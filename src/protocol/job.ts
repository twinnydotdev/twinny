/**
 * One inference job, transport-neutral: validate the request, ask the
 * host which client serves the alias, run it, hand chunks to whoever is
 * carrying them, and report how it ended. The HTTP handler wraps this
 * for a request/response pair; a sharing extension wraps it for a job
 * frame from the gateway. Neither knows more than the other about what
 * a job is.
 *
 * Pure: no vscode, no `http`.
 */
import {
  InferenceError,
  InferenceErrorKind,
  isInferenceError,
  toInferenceError
} from "../extension/inference/errors"
import type {
  ChatChunk,
  EmbeddingResponse,
  FimChunk,
  InferenceCapability,
  InferenceClient,
  InferenceUsage
} from "../extension/inference/types"

import type { RemoteRouteTarget } from "./handler"
import { parseRequest } from "./wire"

/** The content of one inference request, when the host asked for it. */
export interface JobCapture {
  /** The parsed request, without the alias. */
  request: unknown
  /** `{ content }` for chat, `{ text }` for fim, `{ count, dimensions }` for embeddings. */
  response: unknown
  model?: string
  provider?: string
}

export interface JobOptions {
  capability: InferenceCapability
  /** The request body as it arrived; validated here. */
  input: unknown
  /**
   * The client and backend model for an alias and capability. Throws an
   * `InferenceError` (`model-unavailable`, `unsupported-capability`) when
   * there is none; that error is what the requester receives.
   */
  route(alias: string, capability: InferenceCapability): RemoteRouteTarget | Promise<RemoteRouteTarget>
  /**
   * Ends the job early. When its reason is an `InferenceError` (a
   * `timeout`, say), that is what the requester is told; otherwise
   * `cancelled`.
   */
  signal?: AbortSignal
  /** Keep the request and the assembled reply in the result. */
  capture?: boolean
  /**
   * Receives each streamed chunk (fim and chat). Resolving means the
   * transport has taken it; the next chunk waits for that.
   */
  chunk?(chunk: FimChunk | ChatChunk): Promise<void> | void
}

export interface JobResult {
  /** The alias the request named, once the body was readable. */
  alias?: string
  outcome: "ok" | "error" | "cancelled"
  /** Set when the outcome is not `ok`: what to tell the requester. */
  error?: InferenceError
  kind?: InferenceErrorKind
  /** What the backend reported spending, when it did. */
  usage?: InferenceUsage
  /** Chunks handed over before the job ended (streams only). */
  chunks?: number
  /** The whole reply, for embeddings. */
  response?: EmbeddingResponse
  /** Texts the request carried (embeddings), once the body was readable. */
  inputs?: number
  /** Present when `capture` was on and the request parsed. */
  captured?: JobCapture
  /** Which backend served it, when the client chose among several. */
  backend?: string
}

const CLIENT_GONE = () => new InferenceError("cancelled", "The client closed the connection.")

/**
 * The requester hung up. Its own class, distinct from a host cancelling
 * the job (a shutdown, a deadline), so the runner can tell a request that
 * was answered and left from one that was interrupted.
 */
export class RequesterGone extends InferenceError {
  constructor() {
    super("cancelled", "The client closed the connection.")
  }
}

export const isRequesterGone = (error: unknown): error is RequesterGone =>
  error instanceof RequesterGone

/** The alias a request names, for the log, even when the body is otherwise wrong. */
export const aliasOf = (body: unknown): string | undefined => {
  const model = (body as { model?: unknown } | null)?.model
  return typeof model === "string" ? model.slice(0, 128) : undefined
}

/**
 * What to tell the requester. A `cancelled` from the guard carries
 * whatever reason the signal was aborted with; when that was a deadline,
 * the deadline is the news.
 */
export const terminalError = (error: unknown, signal: AbortSignal): InferenceError => {
  const failure = toInferenceError(error)
  if (failure.kind === "cancelled" && isInferenceError(signal.reason)) {
    return signal.reason
  }
  if (failure.kind === "cancelled" && signal.aborted && isInferenceError(failure.cause)) {
    return failure.cause
  }
  return failure
}

export const runInferenceJob = async (options: JobOptions): Promise<JobResult> => {
  const { capability } = options
  let alias: string | undefined
  let usage: InferenceUsage | undefined
  let chunks = 0
  let captured: JobCapture | undefined
  let backend: string | undefined
  let inputs: number | undefined
  const replyParts: string[] = []
  const noteUsage = (reported?: InferenceUsage) => {
    if (reported) usage = { ...usage, ...reported }
  }

  // One controller for everything that can end the job: the host's
  // signal and the provider itself finishing.
  const controller = new AbortController()
  const outer = options.signal
  const forward = () => controller.abort(outer?.reason)
  if (outer?.aborted) forward()
  else outer?.addEventListener("abort", forward, { once: true })

  const finish = (result: Pick<JobResult, "outcome" | "error" | "kind" | "response">): JobResult => {
    outer?.removeEventListener("abort", forward)
    if (captured && capability !== "embeddings") {
      captured.response = capability === "fim" ? { text: replyParts.join("") } : { content: replyParts.join("") }
    }
    return {
      ...result,
      alias,
      ...(usage ? { usage } : {}),
      ...(capability === "embeddings" ? {} : { chunks }),
      ...(captured ? { captured } : {}),
      ...(backend ? { backend } : {}),
      ...(inputs !== undefined ? { inputs } : {})
    }
  }

  const fail = (error: unknown): JobResult => {
    const failure = terminalError(error, controller.signal)
    // A requester that stops reading once it has what it needs (inline
    // completion keeps one line of a longer stream) has been answered: the
    // job is done, not cancelled. A host shutting down, a deadline or a
    // backend fault mid-stream is still reported as what it was.
    if (isRequesterGone(failure) && chunks > 0) return finish({ outcome: "ok" })
    const outcome = failure.kind === "cancelled" ? "cancelled" : "error"
    return finish({ outcome, error: failure, kind: failure.kind })
  }

  try {
    alias = aliasOf(options.input)
    const request = parseRequest(capability, options.input)
    if ("input" in request) inputs = Array.isArray(request.input) ? request.input.length : 1
    if (controller.signal.aborted) return fail(controller.signal.reason)

    if (options.capture) {
      const { model: _alias, ...rest } = request as unknown as { model: string } & Record<string, unknown>
      void _alias
      captured = { request: rest, response: capability === "embeddings" ? { count: 0, dimensions: 0 } : {} }
    }
    const target = await options.route(request.model, capability)
    if (captured) {
      captured.model = target.model
      if (target.provider) captured.provider = target.provider
    }
    const backendRequest = { ...request, model: target.model }
    const inference = {
      signal: controller.signal,
      onBackend: (name: string) => {
        backend = name
      }
    }

    if (capability === "embeddings") {
      const response = await target.client.embeddings(
        backendRequest as Parameters<InferenceClient["embeddings"]>[0],
        inference
      )
      if (controller.signal.aborted) return fail(controller.signal.reason)
      noteUsage(response.usage)
      if (captured) captured.response = { count: response.vectors.length, dimensions: response.vectors[0]?.length ?? 0 }
      return finish({ outcome: "ok", response })
    }

    const stream =
      capability === "fim"
        ? target.client.fim(backendRequest as Parameters<InferenceClient["fim"]>[0], inference)
        : target.client.chat(backendRequest as Parameters<InferenceClient["chat"]>[0], inference)

    for await (const chunk of stream) {
      if (controller.signal.aborted) break
      noteUsage(chunk.usage)
      // Some backends end with an empty chunk; it says nothing worth a line
      // unless it carries the token counts.
      if (!("text" in chunk ? chunk.text : chunk.content) && !chunk.usage) continue
      if (captured) replyParts.push(("text" in chunk ? chunk.text : chunk.content) ?? "")
      await options.chunk?.(chunk)
      chunks++
    }
    if (controller.signal.aborted) return fail(controller.signal.reason)
    return finish({ outcome: "ok" })
  } catch (error) {
    return fail(error)
  } finally {
    // Whatever ended the job, the provider is told once.
    if (!controller.signal.aborted) controller.abort(CLIENT_GONE())
  }
}

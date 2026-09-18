/**
 * The gateway side of the protocol: one HTTP request in, one inference
 * job out, on top of Node's `http` module.
 *
 * The handler reads and validates the body, asks the host which client
 * serves the alias, runs the job, and streams the reply as NDJSON with
 * backpressure. The client hanging up, the host's signal firing (a
 * deadline, a shutdown) or the provider failing all end the same way:
 * the provider is aborted and, if the headers are already out, a terminal
 * frame tells the client what happened.
 *
 * What the handler does not do is authenticate, count, or log: the host
 * wraps it for those. It reports how each request ended so the host can.
 */
import type { IncomingMessage, ServerResponse } from "node:http"

import { InferenceError, InferenceErrorKind, toInferenceError } from "../extension/inference/errors"
import {
  InferenceCapability,
  InferenceClient,
  InferenceModel,
  InferenceUsage
} from "../extension/inference/types"

import { JobCapture, JobResult, RequesterGone, runInferenceJob, terminalError } from "./job"
import type { RemoteTeam } from "./types"
import {
  REMOTE_PROTOCOL_VERSION,
  REMOTE_STREAM_CONTENT_TYPE,
  RemoteIdentity,
  RemoteModelsResponse,
  RemoteRoute,
  RemoteStatus
} from "./types"
import {
  isRemoteRequestError,
  methodForRoute,
  RemoteRequestError,
  statusForKind,
  toErrorBody
} from "./wire"

/** The default cap on a request body; prompts carry context, chats carry images. */
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024

export interface RemoteRouteTarget {
  client: InferenceClient
  /** The backend's own name for the model behind the alias. */
  model: string
  /** The host's name for the backend, for records; never its address. */
  provider?: string
}

export interface RemoteHandlerOptions {
  /** What discovery advertises: the configured aliases and their capabilities. */
  models(): InferenceModel[] | Promise<InferenceModel[]>
  /**
   * The client and backend model for an alias and capability. Throws an
   * `InferenceError` (`model-unavailable`, `unsupported-capability`) when
   * there is none; that error is what the client receives.
   */
  route(
    alias: string,
    capability: InferenceCapability
  ): RemoteRouteTarget | Promise<RemoteRouteTarget>
  maxBodyBytes?: number
  /** Who the host authenticated; answers `whoami`. */
  identity?: Omit<RemoteIdentity, "protocol">
  /** The host's live view of its backends; answers `status`. */
  status?(): Promise<Omit<RemoteStatus, "protocol">>
  team?(): Omit<RemoteTeam, "protocol">
  /**
   * Fired by the host to end the job early. When its reason is an
   * `InferenceError` (a `timeout`, say), that is what the client is told;
   * otherwise the client hears `cancelled`.
   */
  signal?: AbortSignal
  /**
   * Keep the request and the assembled reply and return them in the
   * outcome. Off by default: content is held in memory only when the
   * host has somewhere to put it.
   */
  capture?: boolean
}

/** The content of one inference request, when the host asked for it. */
export type RemoteCapture = JobCapture

export interface RemoteRequestOutcome {
  route: RemoteRoute
  /** The alias the request named, once the body was readable. */
  alias?: string
  outcome: "ok" | "error" | "cancelled"
  kind?: InferenceErrorKind
  /** The HTTP status sent, or 200 once a stream had started. */
  status: number
  /** What the backend reported spending, when it did. */
  usage?: InferenceUsage
  /** Chunks written to the client before the request ended (streams only). */
  chunks?: number
  /** Texts an embeddings request carried. */
  inputs?: number
  /** Present when `capture` was on and the request parsed. */
  captured?: RemoteCapture
  /** Which backend served it, when the provider chose among several (a teammate's machine). */
  backend?: string
}


const readBody = (req: IncomingMessage, maxBytes: number): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let overflowed = false
    req.on("data", (chunk: Buffer) => {
      if (overflowed) return
      size += chunk.length
      if (size > maxBytes) {
        // Rejected now, but the rest is drained so the 413 can be read
        // before the connection goes; nothing more is kept.
        overflowed = true
        chunks.length = 0
        reject(new RemoteRequestError(`the body is larger than ${maxBytes} bytes.`, 413))
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (overflowed) return
      const text = Buffer.concat(chunks as Uint8Array[]).toString("utf8")
      try {
        resolve(text ? JSON.parse(text) : {})
      } catch {
        reject(new RemoteRequestError("the body is not JSON."))
      }
    })
    req.on("error", (error) => reject(new RemoteRequestError(error.message)))
  })

const sendJson = (res: ServerResponse, status: number, value: unknown) => {
  const text = JSON.stringify(value)
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store"
  })
  res.end(text)
}

const sendError = (res: ServerResponse, error: InferenceError): number => {
  const status =
    isRemoteRequestError(error) && error.status ? error.status : statusForKind(error.kind)
  sendJson(res, status, toErrorBody(error))
  return status
}

/**
 * `res.write` with the socket's pace: resolves once the line is buffered
 * or drained, or at once when the response is gone (the caller's abort
 * handling takes over from there).
 */
const writeLine = (res: ServerResponse, value: unknown): Promise<void> =>
  new Promise((resolve) => {
    if (res.destroyed || res.writableEnded) {
      resolve()
      return
    }
    if (res.write(`${JSON.stringify(value)}\n`)) {
      resolve()
      return
    }
    const done = () => {
      res.removeListener("drain", done)
      res.removeListener("close", done)
      resolve()
    }
    res.once("drain", done)
    res.once("close", done)
  })

export const handleRemoteRequest = async (
  route: RemoteRoute,
  req: IncomingMessage,
  res: ServerResponse,
  options: RemoteHandlerOptions
): Promise<RemoteRequestOutcome> => {
  const wanted = methodForRoute(route)
  if (req.method !== wanted) {
    res.setHeader("Allow", wanted)
    const status = sendError(
      res,
      new RemoteRequestError(`${route} is ${wanted} only.`, 405)
    )
    return { route, outcome: "error", kind: "inference-failure", status }
  }

  if (route === "models" || route === "whoami" || route === "status" || route === "team") {
    try {
      let body: RemoteModelsResponse | RemoteIdentity | RemoteStatus | RemoteTeam
      if (route === "team") {
        if (!options.team) throw new RemoteRequestError("This gateway does not publish team defaults. Ask your admin to update it.", 404)
        body = { protocol: REMOTE_PROTOCOL_VERSION, ...options.team() }
      } else if (route === "models") {
        body = { protocol: REMOTE_PROTOCOL_VERSION, models: await options.models() }
      } else if (route === "whoami") {
        if (!options.identity) {
          throw new RemoteRequestError("this gateway does not say who you are.", 404)
        }
        body = { protocol: REMOTE_PROTOCOL_VERSION, ...options.identity }
      } else {
        if (!options.status) throw new RemoteRequestError("this gateway has no status route.", 404)
        body = { protocol: REMOTE_PROTOCOL_VERSION, ...(await options.status()) }
      }
      sendJson(res, 200, body)
      return { route, outcome: "ok", status: 200 }
    } catch (error) {
      const failure = toInferenceError(error)
      const status = sendError(res, failure)
      return { route, outcome: "error", kind: failure.kind, status }
    }
  }

  return runInference(route, req, res, options)
}

const runInference = async (
  capability: InferenceCapability,
  req: IncomingMessage,
  res: ServerResponse,
  options: RemoteHandlerOptions
): Promise<RemoteRequestOutcome> => {
  const route: RemoteRoute = capability

  // The client hanging up ends the job like the host's signal does.
  const controller = new AbortController()
  const outer = options.signal
  const forward = () => controller.abort(outer?.reason)
  if (outer?.aborted) forward()
  else outer?.addEventListener("abort", forward, { once: true })
  let finished = false
  const onClose = () => {
    if (!finished) controller.abort(new RequesterGone())
  }
  res.on("close", onClose)

  const report = (result: JobResult, status: number): RemoteRequestOutcome => {
    finished = true
    outer?.removeEventListener("abort", forward)
    res.removeListener("close", onClose)
    return {
      route,
      outcome: result.outcome,
      status,
      ...(result.kind ? { kind: result.kind } : {}),
      alias: result.alias,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.chunks !== undefined ? { chunks: result.chunks } : {}),
      ...(result.inputs !== undefined ? { inputs: result.inputs } : {}),
      ...(result.captured ? { captured: result.captured } : {}),
      ...(result.backend ? { backend: result.backend } : {})
    }
  }

  const fail = (result: JobResult): RemoteRequestOutcome => {
    const failure = result.error ?? new InferenceError("inference-failure", "The job failed.")
    if (!res.headersSent) {
      if (res.destroyed) return report(result, 499)
      const status = sendError(res, failure)
      return report(result, status)
    }
    // The stream has started: the failure travels as its last line. Not
    // awaited when the socket is gone; `writeLine` resolves at once then.
    void writeLine(res, toErrorBody(failure)).then(() => res.end())
    return report(result, 200)
  }

  let body: unknown
  try {
    body = await readBody(req, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)
  } catch (error) {
    const failure = terminalError(error, controller.signal)
    return fail({ outcome: failure.kind === "cancelled" ? "cancelled" : "error", error: failure, kind: failure.kind })
  }

  const result = await runInferenceJob({
    capability,
    input: body,
    route: options.route,
    signal: controller.signal,
    capture: options.capture,
    chunk: async (chunk) => {
      if (!res.headersSent) {
        res.writeHead(200, {
          "Content-Type": REMOTE_STREAM_CONTENT_TYPE,
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no"
        })
        res.flushHeaders()
      }
      await writeLine(res, chunk)
    }
  })

  if (result.outcome !== "ok") return fail(result)
  if (capability === "embeddings") {
    sendJson(res, 200, result.response)
    return report(result, 200)
  }
  if (!res.headersSent) {
    res.writeHead(200, {
      "Content-Type": REMOTE_STREAM_CONTENT_TYPE,
      "Cache-Control": "no-store"
    })
  }
  await writeLine(res, { done: true })
  res.end()
  return report(result, 200)
}

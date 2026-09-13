/**
 * A POST whose reply arrives as JSON lines or server-sent events, read as
 * an async iterable of parsed objects. Every local server (Ollama,
 * llama.cpp, LM Studio, vLLM) and the OpenAI completions API stream this way.
 */
import { logger } from "../../../common/logger"

import { StreamResponse } from "./fim-dialects"

/** Waiting on the first byte for longer than this is a failure. */
const CONNECT_TIMEOUT_MS = 60000
/** How much of an error body is worth reading in the log. */
const MAX_ERROR_BODY = 400

export function isStreamWithDataPrefix(stringBuffer: string) {
  return stringBuffer.startsWith("data:")
}

export function safeParseJsonResponse(
  stringBuffer: string
): StreamResponse | undefined {
  try {
    const line = stringBuffer.trim()
    if (!line) return undefined
    const payload = isStreamWithDataPrefix(line)
      ? line.slice("data:".length).trim()
      : line
    if (!payload || payload === "[DONE]") return undefined
    return JSON.parse(payload)
  } catch {
    return undefined
  }
}

/**
 * The server usually says what went wrong in the body ("model not found",
 * "context length exceeded"); keep that on the error so the log shows it.
 */
export const responseError = async (response: Response) => {
  let detail = ""
  try {
    detail = (await response.text()).trim().slice(0, MAX_ERROR_BODY)
  } catch {
    // The status alone will have to do.
  }
  const error = new Error(
    `Server responded with status code: ${response.status}${detail ? ` ${detail}` : ""}`
  ) as Error & { status?: number }
  error.status = response.status
  return error
}

/**
 * The request as a person would read it: the prompt (or messages) as
 * text, and the rest of the body as one JSON line. Debug level only.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const logRequest = (url: string, body: any) => {
  const { prompt, messages, ...rest } = body ?? {}
  logger.debug(`→ POST ${url} ${JSON.stringify(rest)}`)
  if (typeof prompt === "string") logger.block("Prompt", prompt)
  if (Array.isArray(messages)) {
    logger.block(
      "Messages",
      messages
        .map((m) => `[${m.role}]\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
        .join("\n\n")
    )
  }
}

export interface JsonStreamRequest {
  url: string
  headers: Record<string, string>
  body: unknown
  signal?: AbortSignal
}

/**
 * Yields each parsed line as it arrives. Stopping early (a `break`, or the
 * signal firing) cancels the response so the server stops generating.
 */
export async function* streamJsonLines(
  request: JsonStreamRequest
): AsyncGenerator<StreamResponse> {
  const { url, headers, body, signal } = request
  logRequest(url, body)

  const controller = new AbortController()
  const forward = () => controller.abort(signal?.reason)
  if (signal?.aborted) forward()
  else signal?.addEventListener("abort", forward, { once: true })
  const timeout = setTimeout(() => {
    controller.abort(new DOMException("Request timed out", "TimeoutError"))
  }, CONNECT_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    })
    clearTimeout(timeout)

    if (!response.ok) throw await responseError(response)
    if (!response.body) {
      throw new Error("Failed to get a ReadableStream from the response")
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += value
        let newline: number
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          const json = safeParseJsonResponse(line)
          if (json) yield json
        }
      }
      const rest = safeParseJsonResponse(buffer)
      if (rest) yield rest
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      logger.warn(
        `No response from ${url} after ${CONNECT_TIMEOUT_MS / 1000}s. ` +
          "The model may still be loading."
      )
    } else if (error instanceof Error) {
      // The caller reports this with the provider named; here only the
      // raw detail, for when that summary is not enough.
      logger.debug(`Request to ${url} failed: ${error.message}`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", forward)
    controller.abort()
  }
}

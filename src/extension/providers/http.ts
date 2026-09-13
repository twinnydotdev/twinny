import { logger } from "../../common/logger"
import { StreamRequest as LlmRequest, StreamRequestOptions } from "../../common/types"
import { notifyKnownErrors, safeParseJsonResponse } from "../utils"

/** Waiting on the first byte for longer than this is a failure. */
const CONNECT_TIMEOUT_MS = 60000
/** How much of an error body is worth reading in the log. */
const MAX_ERROR_BODY = 400

const requestUrl = (options: StreamRequestOptions) =>
  `${options.protocol}://${options.hostname}${
    options.port ? `:${options.port}` : ""
  }${options.path}`

/**
 * The request as a person would read it: the prompt (or messages) as
 * text, and the rest of the body as one JSON line. Debug level only.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const logRequest = (url: string, body: any) => {
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

/**
 * The server usually says what went wrong in the body ("model not found",
 * "context length exceeded"); keep that on the error so the log shows it.
 */
const responseError = async (response: Response) => {
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

export async function llm(request: LlmRequest) {
  const { body, options, onData, onEnd, onError, onStart } = request
  const url = requestUrl(options)
  logRequest(url, body)
  const controller = new AbortController()
  const { signal } = controller

  const timeOut = setTimeout(() => {
    controller.abort(new DOMException("Request timed out", "TimeoutError"))
  }, CONNECT_TIMEOUT_MS)

  try {
    const fetchOptions = {
      method: options.method,
      headers: options.headers,
      body: JSON.stringify(body),
      signal: controller.signal
    }

    // Hand the controller out before connecting so callers can abort a
    // request that is still waiting on the server.
    onStart?.(controller)

    const response = await fetch(url, fetchOptions)
    clearTimeout(timeOut)

    if (!response.ok) throw await responseError(response)

    if (!response.body) {
      throw new Error("Failed to get a ReadableStream from the response")
    }

    let buffer = ""

    if (body.stream === false) {
      const text = await response.text()
      const json = safeParseJsonResponse(text)

      if (!json || !onData) return

      onEnd?.(json)
      return
    }

    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(
        new TransformStream({
          start() {
            buffer = ""
          },
          transform(chunk) {
            buffer += chunk
            let position
            while ((position = buffer.indexOf("\n")) !== -1) {
              const line = buffer.substring(0, position)
              buffer = buffer.substring(position + 1)
              try {
                const json = safeParseJsonResponse(line)
                if (json) onData(json)
              } catch {
                onError?.(new Error("Error parsing JSON data from event"))
              }
            }
          },
          flush() {
            if (buffer) {
              try {
                const json = safeParseJsonResponse(buffer)
                if (!json) return
                onData(json)
              } catch {
                onError?.(new Error("Error parsing JSON data from event"))
              }
            }
          }
        })
      )
      .getReader()

      signal.addEventListener("abort", () => {
        reader.cancel()
      })

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal.aborted) break
      const { done } = await reader.read()
      if (done) break
    }

    controller.abort()
    onEnd?.()
    reader.releaseLock()
  } catch (error: unknown) {
    clearTimeout(timeOut)
    controller.abort()
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        onEnd?.()
      } else if (error.name === "TimeoutError") {
        logger.warn(
          `No response from ${url} after ${CONNECT_TIMEOUT_MS / 1000}s. ` +
            "The model may still be loading."
        )
        onError?.(error)
      } else {
        // The caller reports this with the provider named; here only the
        // raw detail, for when that summary is not enough.
        logger.debug(`Request to ${url} failed: ${error.message}`)
        onError?.(error)
        notifyKnownErrors(error)
      }
    }
  }
}

export async function fetchEmbedding(request: LlmRequest) {
  const { body, options, onData } = request
  const controller = new AbortController()
  const url = requestUrl(options)

  try {
    const fetchOptions = {
      method: options.method,
      headers: options.headers,
      body: JSON.stringify(body),
      signal: controller.signal
    }

    const response = await fetch(url, fetchOptions)

    if (!response.ok) throw await responseError(response)

    if (!response.body) {
      throw new Error("Failed to get a ReadableStream from the response")
    }

    const data = await response.json()

    onData(data)
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.error(`Embedding request to ${url} failed`, error)
      notifyKnownErrors(error)
    }
  }
}

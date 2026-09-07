/**
 * The node's only way out: a handful of fixed routes on its local Ollama.
 *
 * Requests are forwarded as they arrived and the reply is relayed as it
 * streams, status and all, so the client sees exactly what Ollama said.
 * There is no way to name a different path or host from the outside.
 */

import {
  INFERENCE_ROUTES,
  InferenceBody,
  InferenceKind,
  P2pErrorCode,
  RemoteModel
} from "../p2p/protocol"

const TAGS_ROUTE = "/api/tags"
const VERSION_ROUTE = "/api/version"
const HEALTH_TIMEOUT_MS = 3_000
const LIST_TIMEOUT_MS = 8_000

/** Where each relayed frame goes; the server turns these into wire frames. */
export interface RelaySink {
  head: (status: number, contentType: string) => void
  chunk: (text: string) => void
  end: () => void
  error: (code: P2pErrorCode, message: string) => void
}

interface OllamaTag {
  name?: string
  size?: number
  details?: {
    family?: string
    parameter_size?: string
    quantization_level?: string
  }
}

const isAbort = (error: unknown) =>
  error instanceof Error &&
  (error.name === "AbortError" || /abort/i.test(error.message))

export class OllamaProxy {
  public readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "")
  }

  public async isUp(): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
    try {
      const response = await fetch(`${this.baseUrl}${VERSION_ROUTE}`, {
        signal: controller.signal
      })
      return response.ok
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  public async listModels(): Promise<RemoteModel[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS)
    try {
      const response = await fetch(`${this.baseUrl}${TAGS_ROUTE}`, {
        signal: controller.signal
      })
      if (!response.ok) {
        throw new Error(`Ollama answered ${response.status} to ${TAGS_ROUTE}`)
      }
      const json = (await response.json()) as { models?: OllamaTag[] }
      return (json.models || [])
        .filter((tag): tag is OllamaTag & { name: string } => !!tag?.name)
        .map((tag) => ({
          name: tag.name,
          size: tag.size,
          family: tag.details?.family,
          parameterSize: tag.details?.parameter_size,
          quantization: tag.details?.quantization_level
        }))
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Forwards one inference request and relays the reply until it ends, the
   * signal aborts, or Ollama goes away. Resolves in every case; the sink
   * hears which.
   */
  public async relay(
    kind: InferenceKind,
    request: InferenceBody,
    signal: AbortSignal,
    sink: RelaySink
  ): Promise<void> {
    const url = `${this.baseUrl}${INFERENCE_ROUTES[kind]}`
    let response: Response
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal
      })
    } catch (error) {
      if (isAbort(error)) {
        sink.error("cancelled", "Cancelled.")
      } else {
        sink.error(
          "upstream",
          `The node could not reach Ollama at ${this.baseUrl}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
      return
    }

    sink.head(
      response.status,
      response.headers.get("content-type") || "application/json"
    )

    if (!response.body) {
      sink.end()
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value?.length) sink.chunk(decoder.decode(value, { stream: true }))
      }
      const tail = decoder.decode()
      if (tail) sink.chunk(tail)
      sink.end()
    } catch (error) {
      if (isAbort(error) || signal.aborted) {
        sink.error("cancelled", "Cancelled.")
      } else {
        sink.error(
          "upstream",
          `Ollama stopped answering: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    } finally {
      reader.releaseLock()
    }
  }
}

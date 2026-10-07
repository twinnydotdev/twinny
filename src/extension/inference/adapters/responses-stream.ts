/**
 * Shared parser for OpenAI Responses API server-sent events.
 *
 * Request policy intentionally lives in each adapter; only transport/event
 * parsing is shared because ChatGPT-plan usage and API-key usage accept
 * different request fields.
 */
export interface ResponsesEvent {
  type: string
  delta?: string
  item?: { type: string; call_id?: string; name?: string; arguments?: string }
  response?: {
    status?: string
    incomplete_details?: { reason?: string } | null
    usage?: { input_tokens?: number; output_tokens?: number }
    error?: { code?: string; message?: string } | null
  }
  message?: string
  error?: { code?: string; message?: string }
}

/** One parsed `data:` payload at a time. */
export async function* responseEvents(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<ResponsesEvent> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      // SSE permits CRLF; normalize before looking for blank-line separators.
      buffer = buffer.replace(/\r\n/g, "\n")
      let split: number
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("")
        if (!data || data === "[DONE]") continue
        try {
          yield JSON.parse(data) as ResponsesEvent
        } catch {
          // Ignore a malformed event; a later terminal event still decides
          // whether the whole response succeeded.
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

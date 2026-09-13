/**
 * Helpers for the streams the layer hands out.
 */
import { InferenceError } from "./errors"
import { ChatChunk, FimChunk } from "./types"

const cancelled = (reason: unknown) =>
  new InferenceError("cancelled", "The request was cancelled.", {
    cause: reason
  })

/**
 * The same items as `source`, ending the moment `signal` fires: the read in
 * progress rejects with a `cancelled` error instead of waiting on the
 * provider, and the source is told to stop.
 */
export async function* abortable<T>(
  source: AsyncIterable<T>,
  signal?: AbortSignal
): AsyncGenerator<T, void, undefined> {
  if (!signal) {
    yield* source
    return
  }
  const iterator = source[Symbol.asyncIterator]()
  let onAbort = () => undefined as void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(cancelled(signal.reason))
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
  // Nobody awaits the rejection on its own; it only ever loses a race.
  aborted.catch(() => undefined)

  try {
    for (;;) {
      const result = await Promise.race([iterator.next(), aborted])
      if (result.done) return
      yield result.value
    }
  } finally {
    signal.removeEventListener("abort", onAbort)
    // Whether the consumer stopped or the signal fired, let the source
    // release its connection. Not awaited: a source mid-read settles this
    // only when that read does.
    void iterator.return?.().catch(() => undefined)
  }
}

/** The whole reply of a text stream, for callers that want it in one go. */
export const readText = async (
  stream: AsyncIterable<FimChunk | ChatChunk>
): Promise<string> => {
  let text = ""
  for await (const chunk of stream) {
    text += "text" in chunk ? chunk.text : chunk.content
  }
  return text
}

/**
 * The wire format.
 *
 * Every message that crosses the extension <-> webview boundary is one of
 * these three shapes. Keeping the envelope tiny and uniform is what lets a
 * single dispatcher on each side replace the dozens of ad-hoc
 * `postMessage` / `addEventListener` pairs that used to be scattered around.
 */

/** A message travelling in either direction. */
export interface Envelope<T = unknown> {
  /** Channel name — a key of `ClientEvents` or `ServerEvents`. */
  type: string
  /** Channel payload. */
  data?: T
  /**
   * Correlation id. Present only when the sender is waiting for a reply, and
   * echoed verbatim on the reply so the caller can resolve the right promise.
   */
  id?: string
  /** Set on a reply that carries a rejection instead of a value. */
  error?: string
}

export const isEnvelope = (value: unknown): value is Envelope =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Envelope).type === "string"

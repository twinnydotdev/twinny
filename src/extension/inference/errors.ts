/**
 * One error model for every provider. Adapters throw whatever their client
 * throws; the layer turns it into an `InferenceError` whose `kind` a feature
 * can act on, with the raw message kept for the log.
 *
 * Pure: no vscode imports, so it is unit-tested directly.
 */

export type InferenceErrorKind =
  | "provider-unavailable"
  | "model-unavailable"
  | "unsupported-capability"
  | "authentication"
  | "rate-limited"
  | "timeout"
  | "cancelled"
  | "inference-failure"

export class InferenceError extends Error {
  public readonly kind: InferenceErrorKind
  /** The HTTP status when the provider answered with one. */
  public readonly status?: number
  /** What the provider's client actually threw. */
  public readonly cause?: unknown

  constructor(
    kind: InferenceErrorKind,
    message: string,
    details: { status?: number; cause?: unknown } = {}
  ) {
    super(message)
    this.name = "InferenceError"
    this.kind = kind
    this.status = details.status
    this.cause = details.cause
  }
}

export const isInferenceError = (error: unknown): error is InferenceError =>
  error instanceof InferenceError

export const isCancelled = (error: unknown): boolean =>
  isInferenceError(error) && error.kind === "cancelled"

export const unsupportedCapability = (providerId: string, what: string) =>
  new InferenceError(
    "unsupported-capability",
    `${providerId} does not support ${what}.`
  )

interface ErrorLike {
  name?: string
  message?: string
  status?: number
  code?: string
  cause?: ErrorLike
  /** Where axios-style clients put the server's own explanation. */
  response?: { data?: { error?: { message?: string } } }
}

const CONNECTION_HINTS = [
  "econnrefused",
  "enotfound",
  "econnreset",
  "ehostunreach",
  "etimedout",
  "fetch failed",
  "connection error",
  "network error",
  "socket hang up"
]

export const isAbortError = (error: unknown): boolean => {
  const e = error as ErrorLike | undefined
  if (!e) return false
  if (isCancelled(e)) return true
  if (e.name === "AbortError" || e.code === "ABORT_ERR") return true
  return /aborted/i.test(e.message || "") || isAbortError(e.cause)
}

/** Every message in the cause chain, so nothing a server said is lost. */
export const collectMessages = (error: unknown): string => {
  const parts: string[] = []
  let current = error as ErrorLike | undefined
  let depth = 0
  while (current && depth < 5) {
    if (typeof current === "string") {
      parts.push(current)
      break
    }
    const served = current.response?.data?.error?.message
    if (typeof served === "string" && served) parts.push(served)
    if (current.message) parts.push(current.message)
    if (current.code) parts.push(current.code)
    current = current.cause
    depth++
  }
  return parts.join(" | ")
}

const findStatus = (error: unknown): number | undefined => {
  const e = error as ErrorLike | undefined
  if (typeof e?.status === "number") return e.status
  const match = /\b(400|401|403|404|408|429|500|502|503|504)\b/.exec(
    e?.message || ""
  )
  return match ? Number(match[1]) : undefined
}

const classify = (
  error: unknown,
  raw: string,
  status: number | undefined
): InferenceErrorKind => {
  const lower = raw.toLowerCase()
  const name = (error as ErrorLike | undefined)?.name
  if (name === "TimeoutError") return "timeout"
  if (isAbortError(error)) return "cancelled"
  if (CONNECTION_HINTS.some((hint) => lower.includes(hint))) {
    return "provider-unavailable"
  }
  if (
    status === 401 ||
    status === 403 ||
    /api key|unauthori[sz]ed|authentication/.test(lower)
  ) {
    return "authentication"
  }
  if ((status === 404 || /not found/.test(lower)) && /model/.test(lower)) {
    return "model-unavailable"
  }
  if (status === 429 || /rate limit|too many requests/.test(lower)) {
    return "rate-limited"
  }
  if (/timed? ?out/.test(lower) || status === 408 || status === 504) {
    return "timeout"
  }
  if (status && status >= 500) return "provider-unavailable"
  return "inference-failure"
}

/**
 * The provider boundary: whatever a client threw, as an `InferenceError`.
 * One that already is passes through untouched.
 */
export const toInferenceError = (error: unknown): InferenceError => {
  if (isInferenceError(error)) return error
  const raw = collectMessages(error) || "Unknown error"
  const status = findStatus(error)
  return new InferenceError(classify(error, raw, status), raw, {
    status,
    cause: error
  })
}

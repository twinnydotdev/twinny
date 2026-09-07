/**
 * Turns the errors an LLM client throws into something a person can act on.
 * Pure: no vscode imports, so it is unit-tested directly.
 */

export interface ProviderSummary {
  label: string
  modelName: string
  apiHostname?: string
  apiPort?: number
  apiProtocol?: string
  apiPath?: string
}

interface ErrorLike {
  name?: string
  message?: string
  status?: number
  code?: string
  cause?: ErrorLike
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
  if (e.name === "AbortError" || e.code === "ABORT_ERR") return true
  return /aborted/i.test(e.message || "") || isAbortError(e.cause)
}

const providerUrl = (provider: ProviderSummary) => {
  if (!provider.apiHostname) return ""
  const protocol = provider.apiProtocol || "http"
  const port = provider.apiPort ? `:${provider.apiPort}` : ""
  return `${protocol}://${provider.apiHostname}${port}${provider.apiPath || ""}`
}

const collectMessages = (error: unknown): string => {
  const parts: string[] = []
  let current = error as ErrorLike | undefined
  let depth = 0
  while (current && depth < 5) {
    if (typeof current === "string") {
      parts.push(current)
      break
    }
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

export const describeProviderError = (
  error: unknown,
  provider: ProviderSummary
): string => {
  const raw = collectMessages(error) || "Unknown error"
  const lower = raw.toLowerCase()
  const status = findStatus(error)
  const name = `**${provider.label}**`
  const url = providerUrl(provider)
  const where = url ? ` at \`${url}\`` : ""

  let summary: string

  if (CONNECTION_HINTS.some((hint) => lower.includes(hint))) {
    summary =
      `Could not connect to ${name}${where}. ` +
      "Check that the server is running and that the hostname, port and " +
      "protocol in the provider settings are correct."
  } else if (status === 401 || status === 403 || /api key|unauthori[sz]ed|authentication/.test(lower)) {
    summary =
      `${name} rejected the request as unauthorised. ` +
      "Check the API key on the provider."
  } else if (status === 404 || /not found/.test(lower)) {
    summary = /model/.test(lower)
      ? `${name} does not have the model \`${provider.modelName}\`. ` +
        "Check the model name, or pull the model first."
      : `${name} returned 404${where}. Check the API path on the provider.`
  } else if (status === 429 || /rate limit|too many requests/.test(lower)) {
    summary = `${name} is rate limiting requests. Wait a moment and try again.`
  } else if (/timed? ?out/.test(lower) || status === 408 || status === 504) {
    summary = `The request to ${name} timed out. The model may still be loading; try again.`
  } else if (status && status >= 500) {
    summary = `${name} returned a server error (${status}). Check the server logs.`
  } else if (/context length|too many tokens|maximum context|token limit/.test(lower)) {
    summary =
      `The prompt was too long for \`${provider.modelName}\`. ` +
      "Start a new conversation or remove some context files."
  } else {
    summary = `${name} returned an error.`
  }

  return `${summary}\n\n\`${raw}\``
}

/** The same explanation without markdown, for plain-text surfaces. */
export const describeProviderErrorPlain = (
  error: unknown,
  provider: ProviderSummary
): string =>
  describeProviderError(error, provider)
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\n\n/g, " — ")

/** Reasoning models wrap their thinking in tags; only the answer is wanted. */
export const stripThinking = (text: string): string =>
  text
    .replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "")
    .replace(/^<(think|thinking)>[\s\S]*$/i, "")
    .trim()

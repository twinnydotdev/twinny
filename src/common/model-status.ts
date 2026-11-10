/**
 * What the chat can honestly say about the model behind it before a
 * message is sent: where it runs, whether its server has it loaded, how
 * much it holds. Shared by the extension, which asks the server, and the
 * webview, which shows it.
 */

/** Where a chat request goes. */
export type ModelPlace =
  /** A server on this machine: nothing leaves it. */
  | "machine"
  /** A server at another address the user set, such as a box on the LAN. */
  | "network"
  /** A Twinny gateway, which may forward to a hosted API. */
  | "gateway"
  /** A teammate's device over P2P. */
  | "peer"
  /** A hosted API. */
  | "hosted"

export interface ModelStatus {
  place: ModelPlace
  /** The host asked, for `network`. */
  host?: string
  /** Whether the server has the model in memory; absent when it does not say. */
  loaded?: boolean
  /** Whether a click can load it: local servers that load on demand. */
  canLoad?: boolean
  /** Tokens the model is loaded to hold, when the server says. */
  contextWindow?: number
  /** Share of the loaded model that sits on the GPU, 0 to 1, when the server says. */
  gpuShare?: number
  /** How long the model last took to load here, when twinny loaded it. */
  loadMs?: number
  /** twinny is loading it now. */
  loading?: boolean
  /** Why the last load twinny started failed. */
  loadError?: string
}

export const STARTERS = ["explain", "bugs", "tests"] as const
export type StarterKind = (typeof STARTERS)[number]

/** Roughly how many characters a token is, for a draft nothing has counted yet. */
const DRAFT_CHARS_PER_TOKEN = 3.5
/** From here the meter says so in words. */
export const CONTEXT_FILLING = 0.8

export interface ContextFit {
  /** Tokens the conversation and the draft are taken to need. */
  tokens: number
  /** That, as a share of the window; above 1 when it will not fit. */
  share: number
  state: "room" | "filling" | "over"
}

/**
 * How the conversation so far plus the draft sit in the model's context.
 * `conversationTokens` is what the server counted for the last reply;
 * the draft is estimated from its length.
 */
export const contextFit = (
  conversationTokens: number,
  draftChars: number,
  contextWindow: number | undefined
): ContextFit | undefined => {
  if (!contextWindow || contextWindow <= 0) return undefined
  const tokens = Math.round(Math.max(0, conversationTokens) + Math.max(0, draftChars) / DRAFT_CHARS_PER_TOKEN)
  const share = tokens / contextWindow
  return { tokens, share, state: share > 1 ? "over" : share >= CONTEXT_FILLING ? "filling" : "room" }
}

/** 8192 as "8k", 32768 as "32k", 200000 as "200k", 9100 as "9.1k", 900 as "900". */
export const shortTokens = (tokens: number): string => {
  if (tokens < 1000) return String(tokens)
  if (tokens % 1024 === 0) return `${tokens / 1024}k`
  return `${tokens >= 10_000 ? Math.round(tokens / 1000) : Math.round(tokens / 100) / 10}k`
}

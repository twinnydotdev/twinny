/**
 * Keeping a tool conversation inside the model's context. Pure sums: the
 * loop asks how much a request may hold, how large one result may be, and
 * how many tokens a stretch of text is likely to be.
 *
 * Every request of a reply carries the whole conversation so far, tool
 * results included, so a few file reads fill a small local model's
 * context. A server asked for more than it holds cuts the conversation
 * from the front, which is where the tool instructions are, and the model
 * forgets how to call a tool. So the loop trims its own oldest results
 * first, and says so in their place.
 */

/** Code and paths run to fewer characters per token than prose; this errs towards counting too many. */
export const DEFAULT_CHARS_PER_TOKEN = 3.3

/** Under this, tool use is cramped whatever is trimmed: the tools' own description takes a quarter of it. */
export const SMALL_CONTEXT_TOKENS = 8192

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

export interface ContextPlan {
  /** Tokens the model's context holds. */
  window: number
  /** Tokens a request may be estimated at before old results are trimmed. */
  limit: number
  /** Where trimming stops, well under the limit, so it is not needed again a step later. */
  target: number
  /** Characters one tool result may run to. */
  resultChars: number
  /** Characters of tool notes kept for the next turn. */
  notesChars: number
}

/** How a context of `window` tokens is shared out. */
export const planContext = (window: number): ContextPlan => {
  // Room for the reply itself: the answer, or the next call's arguments.
  const reply = Math.min(2048, Math.floor(window * 0.2))
  const limit = Math.max(512, Math.floor(window * 0.9) - reply)
  return {
    window,
    limit,
    target: Math.floor(limit * 0.65),
    resultChars: clamp(Math.floor(window * DEFAULT_CHARS_PER_TOKEN * 0.2), 2000, 30_000),
    notesChars: clamp(Math.floor(window * DEFAULT_CHARS_PER_TOKEN * 0.08), 1200, 6000)
  }
}

/**
 * Characters to tokens, learning the ratio from what the server counts:
 * each request that reports its prompt tokens corrects the next estimate.
 */
export class TokenEstimator {
  private _charsPerToken = DEFAULT_CHARS_PER_TOKEN

  public tokens(chars: number): number {
    return Math.ceil(chars / this._charsPerToken)
  }

  /** A request of `chars` characters was counted as `promptTokens` by the server. */
  public observe(chars: number, promptTokens: number | undefined) {
    if (!promptTokens || chars < 200) return
    this._charsPerToken = clamp(chars / promptTokens, 2, 6)
  }

  public get charsPerToken() {
    return this._charsPerToken
  }
}

/** `text` up to `max` characters, ending on a whole line where one is near. */
export const cutToLine = (text: string, max: number): string => {
  if (text.length <= max) return text
  const newline = text.lastIndexOf("\n", max)
  return text.slice(0, newline > max / 2 ? newline : max)
}

/** One result held to its share of the context, saying what was left out. */
export const fitResult = (output: string, maxChars: number): string =>
  output.length <= maxChars
    ? output
    : `${cutToLine(output, maxChars)}\n… cut to fit the model's context (${output.length - maxChars} more characters); ask for less at a time`

/** A result this short is left as it is: what would stand in for it is no shorter. */
export const MIN_TRIMMABLE_CHARS = 500

const TRIMMED_NOTE = "[The rest was trimmed to save context. Run the tool again if you need it.]"

/**
 * What stands in for a result trimmed out of the conversation: the tool's
 * own digest of it (what was read and what is defined there, where a
 * search matched, how a command ended), or its first line, so the model
 * knows what it was and where to look again.
 */
export const trimmedResult = (output: string, digest?: string): string => {
  const kept = digest?.trim() ? digest.trim().slice(0, 500) : output.split("\n", 1)[0].slice(0, 160)
  return `${kept}\n${TRIMMED_NOTE}`
}

/** A turn of the conversation, as far as fitting it goes. */
interface Turn {
  role: string
  content?: unknown
}

const turnText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("\n")
      : ""

/** Earlier turns are folded this many messages at a time, so the folded conversation reads the same for several turns running and a local server keeps its cache of it. */
const FOLD_BLOCK = 8
/** The share of the request limit the conversation may take before its oldest turns are folded, and what folding brings it down to. */
const HISTORY_SHARE = 0.55
const HISTORY_TARGET = 0.35
const MAX_FOLD_CHARS = 1600

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/```[\s\S]*?(```|$)/g, " (code) ").replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export const FOLD_HEADER = "[Earlier in this conversation, left out to fit the model's context:"

/** Folded turns in brief: what was asked and how each answer began, the latest kept when not all fit. */
const foldedText = (folded: Turn[]): string => {
  const lines = folded
    .map((turn) => {
      const text = oneLine(turnText(turn.content), turn.role === "user" ? 160 : 200)
      return text ? `- ${turn.role === "user" ? "The user" : "You"}: ${text}` : ""
    })
    .filter(Boolean)
  let dropped = 0
  while (lines.length > 2 && lines.join("\n").length > MAX_FOLD_CHARS) {
    lines.shift()
    dropped++
  }
  return [FOLD_HEADER, ...(dropped ? [`(${dropped} older messages not listed)`] : []), ...lines, "]"].join("\n")
}

/**
 * A conversation too long for the model's context, with its oldest turns
 * folded into a few lines at the head of the first turn kept. A server
 * sent more than it holds cuts from the front itself, where the system
 * prompt or the first turns are, and re-reads everything left on each
 * request; folded here, the system prompt and the newest turns stay whole
 * and the prefix stays the same from turn to turn. The system prompt and
 * the last message are never folded. Returns the messages untouched when
 * they fit.
 */
export const compactHistory = <T extends Turn>(
  messages: T[],
  plan: ContextPlan,
  tokens: (chars: number) => number = (chars) => Math.ceil(chars / DEFAULT_CHARS_PER_TOKEN)
): { messages: T[]; folded: number } => {
  const sizes = messages.map((message) => turnText(message.content).length)
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (tokens(total) <= plan.limit * HISTORY_SHARE) return { messages, folded: 0 }
  const first = messages[0]?.role === "system" ? 1 : 0
  const lastIndex = messages.length - 1
  let left = total
  let cut = first
  // Fold whole blocks from the front until what is left is comfortably inside.
  let whole = true
  while (cut < lastIndex && tokens(left) > plan.limit * HISTORY_TARGET) {
    const next = Math.min(lastIndex, cut + FOLD_BLOCK)
    // The last block would leave no turn but the new one: it goes a turn
    // at a time instead, and only as far as it must.
    if (lastIndex - next < 2) {
      whole = false
      break
    }
    for (let i = cut; i < next; i++) left -= sizes[i]
    cut = next
  }
  while (!whole && cut < lastIndex && tokens(left) > plan.limit * HISTORY_SHARE) {
    const next = Math.min(lastIndex, cut + 2)
    for (let i = cut; i < next; i++) left -= sizes[i]
    cut = next
  }
  // The first turn kept is a user's, so the roles still take turns.
  while (cut < lastIndex && messages[cut].role !== "user") {
    left -= sizes[cut]
    cut++
  }
  if (cut <= first) return { messages, folded: 0 }
  const note = foldedText(messages.slice(first, cut))
  const head = messages[cut]
  const merged = (
    typeof head.content === "string"
      ? { ...head, content: `${note}\n\n${head.content}` }
      : Array.isArray(head.content)
        ? { ...head, content: [{ type: "text", text: note }, ...head.content] }
        : head
  ) as T
  return { messages: [...messages.slice(0, first), merged, ...messages.slice(cut + 1)], folded: cut - first }
}

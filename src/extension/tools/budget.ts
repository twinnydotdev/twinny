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

/** What stands in for a result trimmed out of the conversation: its first line, so the model knows what it was. */
export const trimmedResult = (output: string): string => {
  const first = output.split("\n", 1)[0].slice(0, 160)
  return `${first}\n[The rest was trimmed to save context. Run the tool again if you need it.]`
}

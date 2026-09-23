import {
  CLOSING_BRACKETS,
  FIM_MAX_EMPTY_COMPLETION_CHARS,
  OPENING_BRACKETS,
  QUOTES
} from "../../common/constants"

export interface CompletionStreamOptions {
  /** Model-specific control tokens; the completion is cut at the first one. */
  stopWords: string[]
  /** Whether the completion may span more than one line. */
  multiline: boolean
  /** Hard cap on the number of lines in a multiline completion. */
  maxLines: number
  /** Text of the cursor line before the cursor. */
  textBeforeCursor: string
  /** Text of the cursor line after the cursor. */
  textAfterCursor: string
  /** First non-blank line of the suffix, trimmed. Used to avoid duplicating closers. */
  suffixFirstLine: string
  /**
   * The model answers as a chat and tends to wrap the fill in a markdown
   * code block: drop an opening fence line and end at the closing one.
   */
  unwrapFences?: boolean
  /**
   * The unfinished word the prompt left out: the completion must begin with
   * it and the copy is dropped. One that ignores it is discarded.
   */
  wordFragment?: string
}

export interface StreamDecision {
  done: boolean
  text: string
}

/** Why a completion ended, for the log. */
export type StopReason =
  | "stop word"
  | "only whitespace"
  | "misread hole"
  | "single line"
  | "blank line after block"
  | "reached suffix"
  | "dedent"
  | "closed block"
  | "max lines"
  | "closing fence"
  | "ignored word"
  | "model stopped"

const OPENING_FENCE = /^\s*```[\w+#.-]*\s*$/
const isClosingFence = (line: string) => line.trim() === "```"

const leadingWhitespace = (line: string) => line.length - line.trimStart().length

const isCloserOnly = (line: string) =>
  /^[\s)\]}]+[;,]?\s*$/.test(line) && /[)\]}]/.test(line)

/**
 * Net bracket depth change of a line, ignoring brackets inside simple string
 * literals and after a `//` comment marker. Approximate, but good enough to
 * tell "the model is still inside something it opened" from "it has closed".
 */
export const bracketDelta = (line: string): number => {
  let delta = 0
  let quote = ""
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quote) {
      if (char === "\\") i++
      else if (char === quote) quote = ""
      continue
    }
    if (QUOTES.includes(char)) {
      quote = char
    } else if (char === "/" && line[i + 1] === "/") {
      break
    } else if (OPENING_BRACKETS.includes(char)) {
      delta++
    } else if (CLOSING_BRACKETS.includes(char)) {
      delta--
    }
  }
  return delta
}

/**
 * Accumulates streamed completion text and decides when to stop.
 *
 * Decisions are only ever made at line boundaries so a line is never cut in
 * half. In multiline mode the completion ends when the model:
 *  - emits a stop token,
 *  - reaches a blank line while not inside a bracket it opened itself,
 *  - dedents out of the block the cursor is in,
 *  - closes a bracket that was opened before the cursor line, or
 *  - hits the configured line limit.
 */
export class CompletionStream {
  private text = ""
  private judgedUpTo = 0
  private depth: number
  private lineCount = 0
  private seenContent = false
  private finished = false
  /** Whether the first line has been checked for an opening fence. */
  private fenceChecked = false
  /** Whether the text after an opening fence has been checked for a false start. */
  private fenceLeadChecked = false
  /** Whether the completion has been checked against `wordFragment`. */
  private fragmentChecked = false
  /** Set once the completion ends; "model stopped" when the stream ran dry. */
  public stoppedBy: StopReason | "" = ""
  private readonly baseIndent: number
  private readonly blockIndent: number
  private readonly cursorLineHasContent: boolean

  constructor(private readonly options: CompletionStreamOptions) {
    const before = options.textBeforeCursor
    this.cursorLineHasContent = before.trim().length > 0
    this.baseIndent = leadingWhitespace(before)
    // On a blank line siblings at the same indent belong to the block; after
    // content (e.g. `function f() {`) the block body must be indented deeper.
    this.blockIndent = this.cursorLineHasContent
      ? this.baseIndent + 1
      : this.baseIndent
    this.depth = Math.max(0, bracketDelta(before))
  }

  get value(): string {
    return this.text
  }

  get done(): boolean {
    return this.finished
  }

  /** Feed a chunk from the stream; returns whether the completion is finished. */
  push(chunk: string): StreamDecision {
    if (this.finished) return { done: true, text: this.text }
    this.text += chunk

    if (this.cutAtStopWord()) return this.stop(this.text, "stop word")

    // The opening fence can only be judged once its line is complete.
    if (this.options.unwrapFences && !this.fenceChecked) {
      const newline = this.text.indexOf("\n")
      if (newline === -1) return { done: false, text: this.text }
      this.dropOpeningFence(newline)
    }

    if (
      this.text.length > FIM_MAX_EMPTY_COMPLETION_CHARS &&
      this.text.trim().length === 0
    ) {
      return this.stop("", "only whitespace")
    }

    if (this.options.unwrapFences && !this.fenceLeadChecked) {
      if (this.text.trim().length === 0) return { done: false, text: this.text }
      this.dropFenceLead()
    }

    if (this.options.wordFragment && !this.fragmentChecked) {
      if (this.text.length < this.options.wordFragment.length) {
        return { done: false, text: this.text }
      }
      const decision = this.dropWordFragment()
      if (decision) return decision
    }

    let newline = this.text.indexOf("\n", this.judgedUpTo)
    while (newline !== -1) {
      const decision = this.judgeLine(this.judgedUpTo, newline)
      if (decision) return decision
      this.judgedUpTo = newline + 1
      newline = this.text.indexOf("\n", this.judgedUpTo)
    }

    return { done: false, text: this.text }
  }

  /** The stream ended on its own; judge the trailing partial line. */
  finish(): string {
    if (this.finished) return this.text
    const cut = this.cutAtStopWord()
    if (this.options.unwrapFences && !this.fenceChecked) {
      this.dropOpeningFence(this.text.length)
    }
    if (this.options.unwrapFences && !this.fenceLeadChecked) this.dropFenceLead()
    if (this.options.wordFragment && !this.fragmentChecked) {
      const decision = this.dropWordFragment()
      if (decision) return decision.text
    }
    if (this.judgedUpTo < this.text.length) {
      const decision = this.judgeLine(this.judgedUpTo, this.text.length)
      if (decision) return decision.text
    }
    return this.stop(this.text, cut ? "stop word" : "model stopped").text
  }

  private stop(text: string, reason: StopReason): StreamDecision {
    this.finished = true
    this.stoppedBy = reason
    this.text = text
    return { done: true, text }
  }

  /** Drop the first line, ending at `end`, when it is a markdown fence. */
  private dropOpeningFence(end: number) {
    this.fenceChecked = true
    if (OPENING_FENCE.test(this.text.slice(0, end))) {
      this.text = this.text.slice(Math.min(end + 1, this.text.length))
    }
  }

  /**
   * A chat model starts its code block on a fresh line even when the fill
   * continues the cursor line, and then repeats that line's indentation:
   * `con` is completed with `\nsole.log()`. Drop the false start.
   */
  private dropFenceLead() {
    this.fenceLeadChecked = true
    // The cursor line as the prompt showed it, without the unfinished word.
    const fragment = this.options.wordFragment ?? ""
    const before = this.options.textBeforeCursor.slice(
      0,
      this.options.textBeforeCursor.length - fragment.length
    )
    if (before.length === 0) return
    const lead = this.text.match(/^(\r?\n)+/)
    if (lead) this.text = this.text.slice(lead[0].length)
    if (before.trim().length === 0 && this.text.startsWith(before)) {
      this.text = this.text.slice(before.length)
    }
  }

  /** Strip the word fragment the completion must start with, or end with nothing. */
  private dropWordFragment(): StreamDecision | undefined {
    this.fragmentChecked = true
    const fragment = this.options.wordFragment ?? ""
    if (!this.text.startsWith(fragment)) return this.stop("", "ignored word")
    this.text = this.text.slice(fragment.length)
    return undefined
  }

  private cutAtStopWord(): boolean {
    let cut = -1
    for (const word of this.options.stopWords) {
      const index = this.text.indexOf(word)
      if (index !== -1 && (cut === -1 || index < cut)) cut = index
    }
    if (cut === -1) return false
    this.text = this.text.slice(0, cut)
    return true
  }

  /**
   * Judge the completed line spanning [start, end). Returns a decision when
   * the completion should end, either after this line (`end`) or before it
   * (`start`, dropping the preceding newline).
   */
  private judgeLine(start: number, end: number): StreamDecision | undefined {
    const line = this.text.slice(start, end)
    const isFirstLine = start === 0
    const blank = line.trim().length === 0
    const before = this.text.slice(0, Math.max(0, start - 1))

    if (this.options.unwrapFences && isClosingFence(line)) {
      return this.stop(before, "closing fence")
    }

    // With code after the cursor on this line, a completion that starts on
    // the next line would tear the line apart: the model has misread the hole.
    if (isFirstLine && blank && this.options.textAfterCursor.trim()) {
      return this.stop("", "misread hole")
    }

    if (!this.options.multiline) {
      if (this.seenContent || !blank) {
        return this.stop(this.text.slice(0, end), "single line")
      }
      return undefined
    }

    if (!isFirstLine && blank && this.seenContent && this.depth <= 0) {
      return this.stop(before, "blank line after block")
    }

    // The model has reached what already follows the cursor.
    if (
      !isFirstLine &&
      this.depth <= 0 &&
      this.options.suffixFirstLine.length > 1 &&
      line.trim() === this.options.suffixFirstLine
    ) {
      return this.stop(before, "reached suffix")
    }

    if (!isFirstLine && !blank) {
      const indent = leadingWhitespace(line)
      if (indent < this.blockIndent) {
        const closesCursorLine =
          this.cursorLineHasContent &&
          indent === this.baseIndent &&
          isCloserOnly(line)
        const duplicatesSuffix =
          this.options.suffixFirstLine.length > 0 &&
          line.trim() === this.options.suffixFirstLine
        if (closesCursorLine && !duplicatesSuffix) {
          return this.stop(this.text.slice(0, end), "closed block")
        }
        return this.stop(before, "dedent")
      }
    }

    this.depth += bracketDelta(line)
    if (!blank) this.seenContent = true

    if (!isFirstLine && this.depth < 0) {
      const duplicatesSuffix =
        this.options.suffixFirstLine.length > 0 &&
        this.options.suffixFirstLine.startsWith(line.trim().charAt(0))
      return this.stop(
        duplicatesSuffix ? before : this.text.slice(0, end),
        "closed block"
      )
    }

    this.lineCount++
    if (this.lineCount >= this.options.maxLines) {
      return this.stop(this.text.slice(0, end), "max lines")
    }

    return undefined
  }
}

import { distance } from "fastest-levenshtein"
import { Position, Range, TextEditor } from "vscode"

import { CLOSING_BRACKETS, OPENING_BRACKETS, QUOTES } from "../common/constants"
import { supportedLanguages } from "../common/languages"
import { Bracket } from "../common/types"
import { getLineBreakCount } from "../webview/utils"

const BRACKET_PAIRS: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}"
}

/**
 * Post-processes a raw model completion against the text around the cursor:
 * drops closers/quotes the editor already has, refuses completions that
 * duplicate nearby lines, and trims whitespace the editor will add itself.
 */
export class CompletionFormatter {
  protected editor: TextEditor
  public cursorPosition: Position
  private lineText: string
  private textBeforeCursor: string
  public textAfterCursor: string
  private charAfterCursor: string
  private charBeforeCursor: string
  protected completion = ""
  private originalCompletion = ""
  public languageId: string | undefined

  constructor(editor: TextEditor, position?: Position) {
    this.editor = editor
    this.cursorPosition = position ?? editor.selection.active
    const document = editor.document
    this.languageId = document.languageId
    const currentLine = document.lineAt(this.cursorPosition.line)
    this.lineText = currentLine.text
    const textAfterRange = new Range(this.cursorPosition, currentLine.range.end)
    this.textAfterCursor = document.getText(textAfterRange) || ""
    this.textBeforeCursor = this.lineText.slice(0, this.cursorPosition.character)
    this.charAfterCursor = this.textAfterCursor.charAt(0)
    this.charBeforeCursor =
      this.cursorPosition.character > 0
        ? this.lineText.charAt(this.cursorPosition.character - 1)
        : ""
  }

  private isMatchingPair(open?: Bracket, close?: string): boolean {
    return BRACKET_PAIRS[open || ""] === close
  }

  /** Cut the completion at the first closing bracket that has no opener in it. */
  protected matchCompletionBrackets(): this {
    let accumulatedCompletion = ""
    const openBrackets: Bracket[] = []
    let inString = false
    let stringChar = ""

    for (const char of this.originalCompletion) {
      if (QUOTES.includes(char)) {
        if (!inString) {
          inString = true
          stringChar = char
        } else if (char === stringChar) {
          inString = false
          stringChar = ""
        }
      }

      if (!inString) {
        if (OPENING_BRACKETS.includes(char)) {
          openBrackets.push(char as Bracket)
        } else if (CLOSING_BRACKETS.includes(char)) {
          const lastOpen = openBrackets[openBrackets.length - 1]
          if (lastOpen && this.isMatchingPair(lastOpen, char)) {
            openBrackets.pop()
          } else {
            break
          }
        }
      }

      accumulatedCompletion += char
    }

    this.completion =
      accumulatedCompletion.trimEnd() || this.originalCompletion.trimEnd()

    return this
  }

  protected ignoreBlankLines(): this {
    if (
      this.completion.trimStart() === "" &&
      this.originalCompletion !== "\n"
    ) {
      this.completion = this.completion.trim()
    }
    return this
  }

  protected normalize(text: string): string {
    return text.trim()
  }

  protected calculateStringSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1.0
    if (str1.length === 0 || str2.length === 0) return 0.0

    const maxLen = Math.max(str1.length, str2.length)
    return 1 - distance(str1, str2) / maxLen
  }

  /**
   * Models sometimes restart the current line instead of continuing it, e.g.
   * `const x = foo(` completed with `const x = foo(a, b)`. Keep only the part
   * after the echoed text.
   */
  protected stripEchoedPrefix(completion: string): string {
    const before = this.textBeforeCursor.trimStart()
    if (before.trim().length < 3) return completion
    const trimmed = completion.trimStart()
    return trimmed.startsWith(before) ? trimmed.slice(before.length) : completion
  }

  /** Drop the part of the completion that repeats what follows the cursor. */
  protected removeDuplicateText(): this {
    const after = this.normalize(this.textAfterCursor)
    if (!after || !this.completion) return this

    const maxLength = Math.min(this.completion.length, after.length)

    for (let length = maxLength; length > 0; length--) {
      if (this.completion.slice(-length) === after.slice(0, length)) {
        this.completion = this.completion.slice(0, -length)
        break
      }
    }

    return this
  }

  protected isCursorAtMiddleOfWord(): boolean {
    return /\w/.test(this.charAfterCursor) && /\w/.test(this.charBeforeCursor)
  }

  protected removeUnnecessaryMiddleQuotes(): this {
    if (this.isCursorAtMiddleOfWord()) {
      if (QUOTES.includes(this.completion.charAt(0))) {
        this.completion = this.completion.slice(1)
      }
      const lastChar = this.completion.charAt(this.completion.length - 1)
      if (QUOTES.includes(lastChar)) {
        this.completion = this.completion.slice(0, -1)
      }
    }
    return this
  }

  protected removeDuplicateQuotes(): this {
    const trimmedCharAfterCursor = this.charAfterCursor.trim()
    const normalizedCompletion = this.normalize(this.completion)
    const lastCharOfCompletion = normalizedCompletion.charAt(
      normalizedCompletion.length - 1
    )

    if (
      trimmedCharAfterCursor &&
      (normalizedCompletion.endsWith("',") ||
        normalizedCompletion.endsWith("\",") ||
        normalizedCompletion.endsWith("`,") ||
        (normalizedCompletion.endsWith(",") &&
          QUOTES.includes(trimmedCharAfterCursor)))
    ) {
      this.completion = this.completion.slice(0, -2)
    } else if (
      (normalizedCompletion.endsWith("'") ||
        normalizedCompletion.endsWith("\"") ||
        normalizedCompletion.endsWith("`")) &&
      QUOTES.includes(trimmedCharAfterCursor)
    ) {
      this.completion = this.completion.slice(0, -1)
    } else if (
      QUOTES.includes(lastCharOfCompletion) &&
      trimmedCharAfterCursor === lastCharOfCompletion
    ) {
      this.completion = this.completion.slice(0, -1)
    }

    return this
  }

  /**
   * Refuse a completion that repeats one of the next few lines verbatim.
   * Only exact matches count: repetitive code (test files, data tables)
   * legitimately produces lines that closely resemble their neighbours.
   */
  protected preventDuplicateLine(): this {
    const lineCount = this.editor.document.lineCount
    const originalNormalized = this.normalize(this.originalCompletion)
    if (!originalNormalized) return this

    for (let i = 1; i <= 3; i++) {
      const nextLineIndex = this.cursorPosition.line + i
      if (nextLineIndex >= lineCount) break

      const nextLineNormalized = this.normalize(
        this.editor.document.lineAt(nextLineIndex).text
      )
      if (nextLineNormalized && nextLineNormalized === originalNormalized) {
        this.completion = ""
        break
      }
    }

    return this
  }

  /** Mid-line, a completion can neither start on the next line nor end with one. */
  public removeInvalidLineBreaks(): this {
    if (this.textAfterCursor.trim() && /^\s*\n/.test(this.completion)) {
      this.completion = ""
    }
    if (this.textAfterCursor) {
      this.completion = this.completion.trimEnd()
    }
    return this
  }

  protected skipMiddleOfWord(): this {
    if (this.isCursorAtMiddleOfWord()) {
      this.completion = ""
    }
    return this
  }

  protected skipSimilarCompletions(): this {
    if (
      this.calculateStringSimilarity(this.textAfterCursor, this.completion) >
      0.6
    ) {
      this.completion = ""
    }
    return this
  }

  protected getCompletion = () => {
    if (this.completion.trim().length === 0) {
      this.completion = ""
    }
    return this.completion
  }

  /** The editor already indented the line; don't indent it twice. */
  protected trimStart(): this {
    const firstNonSpaceIndex = this.completion.search(/\S/)
    if (
      firstNonSpaceIndex > 0 &&
      this.cursorPosition.character <= firstNonSpaceIndex
    ) {
      this.completion = this.completion.trimStart()
    }
    return this
  }

  /** Strip the "// File:" style header lines the prompt itself introduces. */
  public preventQuotationCompletions(): this {
    const languageDetails =
      supportedLanguages[this.languageId as keyof typeof supportedLanguages]

    const normalizedCompletion = this.normalize(this.completion)

    if (
      normalizedCompletion.startsWith("// File:") ||
      normalizedCompletion === "//"
    ) {
      this.completion = ""
      return this
    }

    const commentStart = languageDetails?.syntaxComments?.start
    if (!commentStart) return this

    if (getLineBreakCount(this.completion) > 1) return this

    const completionLines = this.completion.split("\n").filter((line) => {
      const startsWithComment = line.startsWith(commentStart)
      const includesCommentReference = /\b(Language|File|End):\s*(.*)\b/.test(
        line
      )
      return !(startsWithComment && includesCommentReference)
    })

    if (completionLines.length) {
      this.completion = completionLines.join("\n")
    }

    return this
  }

  public format(completion: string): string {
    this.completion = ""
    this.originalCompletion = this.stripEchoedPrefix(completion)

    return this.matchCompletionBrackets()
      .preventQuotationCompletions()
      .preventDuplicateLine()
      .removeDuplicateQuotes()
      .removeUnnecessaryMiddleQuotes()
      .ignoreBlankLines()
      .removeInvalidLineBreaks()
      .removeDuplicateText()
      .skipMiddleOfWord()
      .skipSimilarCompletions()
      .trimStart()
      .getCompletion()
  }
}

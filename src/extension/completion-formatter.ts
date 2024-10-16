import { Position, Range, TextEditor } from "vscode"

import { CLOSING_BRACKETS, OPENING_BRACKETS, QUOTES } from "../common/constants"
import { supportedLanguages } from "../common/languages"
import { Bracket } from "../common/types"
import { getLineBreakCount } from "../webview/utils"

import { getLanguage } from "./utils"

export class CompletionFormatter {
  private editor: TextEditor
  private cursorPosition: Position
  private lineText: string
  private textAfterCursor: string
  private charAfterCursor: string
  private charBeforeCursor: string
  private completion = ""
  private normalizedCompletion = ""
  private originalCompletion = ""

  constructor(editor: TextEditor) {
    this.editor = editor
    this.cursorPosition = editor.selection.active
    const document = editor.document
    const currentLine = document.lineAt(this.cursorPosition.line)
    this.lineText = currentLine.text
    const textAfterRange = new Range(this.cursorPosition, currentLine.range.end)
    this.textAfterCursor = document.getText(textAfterRange) || ""
    this.charAfterCursor = this.textAfterCursor.charAt(0)
    this.charBeforeCursor =
      this.cursorPosition.character > 0
        ? this.lineText.charAt(this.cursorPosition.character - 1)
        : ""
  }

  private isMatchingPair(open?: Bracket, close?: string): boolean {
    const BRACKET_PAIRS: { [key: string]: string } = {
      "(": ")",
      "[": "]",
      "{": "}"
    }
    return BRACKET_PAIRS[open || ""] === close
  }

  private matchCompletionBrackets(): this {
    let accumulatedCompletion = ""
    const openBrackets: Bracket[] = []

    for (const char of this.originalCompletion) {
      if (OPENING_BRACKETS.includes(char)) {
        openBrackets.push(char)
      } else if (CLOSING_BRACKETS.includes(char)) {
        const lastOpen = openBrackets[openBrackets.length - 1]
        if (lastOpen && this.isMatchingPair(lastOpen, char)) {
          openBrackets.pop()
        } else {
          break
        }
      }
      accumulatedCompletion += char
    }

    this.completion =
      accumulatedCompletion.trimEnd() || this.originalCompletion.trimEnd()
    return this
  }

  private ignoreBlankLines(): this {
    if (
      this.completion.trimStart() === "" &&
      this.originalCompletion !== "\n"
    ) {
      this.completion = this.completion.trim()
    }
    return this
  }

  private normalize(text: string): string {
    return text.trim()
  }

  private removeDuplicateText(): this {
    const after = this.normalize(this.textAfterCursor)
    const maxLength = Math.min(this.completion.length, after.length)
    let overlapLength = 0

    for (let length = 1; length <= maxLength; length++) {
      const endOfCompletion = this.completion.slice(-length)
      const startOfAfter = after.slice(0, length)
      if (endOfCompletion === startOfAfter) {
        overlapLength = length
      }
    }

    if (overlapLength > 0) {
      this.completion = this.completion.slice(0, -overlapLength)
    }

    return this
  }

  private isCursorAtMiddleOfWord(): boolean {
    const isAfterWord = /\w/.test(this.charAfterCursor)
    const isBeforeWord = /\w/.test(this.charBeforeCursor)
    return isAfterWord && isBeforeWord
  }

  private removeUnnecessaryMiddleQuotes(): this {
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

  private removeDuplicateQuotes(): this {
    const trimmedCharAfterCursor = this.charAfterCursor.trim()
    const normalizedCompletion = this.normalize(this.completion)
    const lastCharOfCompletion = normalizedCompletion.charAt(
      normalizedCompletion.length - 1
    )

    if (
      trimmedCharAfterCursor &&
      (normalizedCompletion.endsWith("',") ||
        normalizedCompletion.endsWith("\",") ||
        (normalizedCompletion.endsWith(",") &&
          QUOTES.includes(trimmedCharAfterCursor)))
    ) {
      this.completion = this.completion.slice(0, -2)
    } else if (
      (normalizedCompletion.endsWith("'") ||
        normalizedCompletion.endsWith("\"")) &&
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

  private preventDuplicateLine(): this {
    const lineCount = this.editor.document.lineCount
    const originalNormalized = this.normalize(this.originalCompletion)
    for (let i = 1; i <= 2; i++) {
      const nextLineIndex = this.cursorPosition.line + i
      if (nextLineIndex >= lineCount) break
      const nextLine = this.editor.document.lineAt(nextLineIndex).text
      if (this.normalize(nextLine) === originalNormalized) {
        this.completion = ""
        break
      }
    }
    return this
  }

  public removeInvalidLineBreaks(): this {
    if (this.textAfterCursor) {
      this.completion = this.completion.trimEnd()
    }
    return this
  }

  private skipMiddleOfWord(): this {
    if (this.isCursorAtMiddleOfWord()) {
      this.completion = ""
    }
    return this
  }

  private skipSimilarCompletions(): this {
    const { document } = this.editor
    const textAfter = document.getText(
      new Range(
        this.cursorPosition,
        document.lineAt(this.cursorPosition.line).range.end
      )
    )

    if (textAfter.score(this.completion) > 0.6) {
      this.completion = ""
    }

    return this
  }

  private getCompletion = () => {
    if (this.completion.trim().length === 0) {
      this.completion = ""
    }
    return this.completion
  }

  private trimStart(): this {
    const firstNonSpaceIndex = this.completion.search(/\S/)
    if (
      firstNonSpaceIndex > 0 &&
      this.cursorPosition.character <= firstNonSpaceIndex
    ) {
      this.completion = this.completion.trimStart()
    }
    return this
  }

  public preventQuotationCompletions(): this {
    const language = getLanguage()
    const languageId =
      supportedLanguages[language.languageId as keyof typeof supportedLanguages]

    const normalizedCompletion = this.normalize(this.completion)
    if (
      normalizedCompletion.startsWith("// File:") ||
      normalizedCompletion === "//"
    ) {
      this.completion = ""
      return this
    }

    if (
      !languageId ||
      !languageId.syntaxComments ||
      !languageId.syntaxComments.start
    ) {
      return this
    }

    const lineBreakCount = getLineBreakCount(this.completion)
    if (lineBreakCount > 1) return this

    const completionLines = this.completion.split("\n").filter((line) => {
      const startsWithComment = line.startsWith(languageId.syntaxComments.start)
      const includesCommentReference = /\b(Language|File|End):\s*(.*)\b/.test(
        line
      )
      const isComment = line.startsWith(languageId.syntaxComments.start)
      return !(startsWithComment && includesCommentReference) && !isComment
    })

    if (completionLines.length) {
      this.completion = completionLines.join("\n")
    }

    return this
  }

  public debug(): void {
    console.log(`Text after cursor: ${this.textAfterCursor}`)
    console.log(`Original completion: ${this.originalCompletion}`)
    console.log(`Normalized completion: ${this.normalizedCompletion}`)
    console.log(`Character after cursor: ${this.charAfterCursor}`)
  }

  public format(completion: string): string {
    this.completion = ""
    this.normalizedCompletion = this.normalize(completion)
    this.originalCompletion = completion

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

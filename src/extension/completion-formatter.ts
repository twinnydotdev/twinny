import { distance } from "fastest-levenshtein"
import { Position, Range, TextEditor } from "vscode"

import { CLOSING_BRACKETS, OPENING_BRACKETS, QUOTES } from "../common/constants"
import { supportedLanguages } from "../common/languages"
import { Bracket } from "../common/types"
import { getLineBreakCount } from "../webview/utils"

import { getLanguage } from "./utils"

export class CompletionFormatter {
  protected editor: TextEditor
  public cursorPosition: Position
  private lineText: string
  public textAfterCursor: string
  private charAfterCursor: string
  private charBeforeCursor: string
  protected completion = ""
  private normalizedCompletion = ""
  private originalCompletion = ""
  public languageId: string | undefined
  private isDebugEnabled = false

  constructor(editor: TextEditor) {
    this.editor = editor
    this.cursorPosition = editor.selection.active
    const document = editor.document
    this.languageId = document.languageId
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

  public setDebug(enabled: boolean): this {
    this.isDebugEnabled = enabled
    return this
  }

  private isMatchingPair(open?: Bracket, close?: string): boolean {
    const BRACKET_PAIRS: { [key: string]: string } = {
      "(": ")",
      "[": "]",
      "{": "}"
    }
    return BRACKET_PAIRS[open || ""] === close
  }

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

    if (this.isDebugEnabled) {
      console.log(`After matchCompletionBrackets: ${this.completion}`)
    }

    return this
  }

  protected ignoreBlankLines(): this {
    if (
      this.completion.trimStart() === "" &&
      this.originalCompletion !== "\n"
    ) {
      this.completion = this.completion.trim()
    }

    if (this.isDebugEnabled) {
      console.log(`After ignoreBlankLines: ${this.completion}`)
    }

    return this
  }

  protected normalize(text: string): string {
    let normalized = text.trim()

    const language = getLanguage()
    const languageDetails =
      supportedLanguages[language.languageId as keyof typeof supportedLanguages]

    if (languageDetails) {
      if (languageDetails.syntaxComments && languageDetails.syntaxComments.start) {
        const commentStart = languageDetails.syntaxComments.start
        if (normalized.startsWith(commentStart)) {
          normalized = normalized.substring(commentStart.length).trim()
        }
      }
    }

    return normalized
  }

  protected calculateStringSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1.0;
    if (str1.length === 0 || str2.length === 0) return 0.0;

    const maxLen = Math.max(str1.length, str2.length);
    const levenshteinDistance = distance(str1, str2);

    return 1 - (levenshteinDistance / maxLen);
  }

  protected removeDuplicateText(): this {
    const after = this.normalize(this.textAfterCursor)
    if (!after || !this.completion) return this

    const maxLength = Math.min(this.completion.length, after.length)
    let overlapLength = 0

    for (let length = maxLength; length > 0; length--) {
      const endOfCompletion = this.completion.slice(-length)
      const startOfAfter = after.slice(0, length)
      if (endOfCompletion === startOfAfter) {
        overlapLength = length
        break
      }
    }

    if (overlapLength > 0) {
      this.completion = this.completion.slice(0, -overlapLength)
    }

    if (this.isDebugEnabled) {
      console.log(`After removeDuplicateText: ${this.completion}`)
    }

    return this
  }

  protected isCursorAtMiddleOfWord(): boolean {
    const isAfterWord = /\w/.test(this.charAfterCursor)
    const isBeforeWord = /\w/.test(this.charBeforeCursor)

    if (!isAfterWord || !isBeforeWord) return false

    const language = getLanguage()
    const languageId = language.languageId

    if (languageId) {
      if (["javascript", "typescript", "php"].includes(languageId)) {
        if (this.charBeforeCursor === "$" || this.charAfterCursor === "$") {
          return true
        }
      }

      if (this.charBeforeCursor === "_" || this.charAfterCursor === "_") {
        return true
      }
    }

    return true
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

    if (this.isDebugEnabled) {
      console.log(`After removeUnnecessaryMiddleQuotes: ${this.completion}`)
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
        normalizedCompletion.endsWith("`,")||
        (normalizedCompletion.endsWith(",") &&
          QUOTES.includes(trimmedCharAfterCursor)))
    ) {
      this.completion = this.completion.slice(0, -2)
    }
    else if (
      (normalizedCompletion.endsWith("'") ||
        normalizedCompletion.endsWith("\"") ||
        normalizedCompletion.endsWith("`")) &&
      QUOTES.includes(trimmedCharAfterCursor)
    ) {
      this.completion = this.completion.slice(0, -1)
    }
    else if (
      QUOTES.includes(lastCharOfCompletion) &&
      trimmedCharAfterCursor === lastCharOfCompletion
    ) {
      this.completion = this.completion.slice(0, -1)
    }

    if (this.isDebugEnabled) {
      console.log(`After removeDuplicateQuotes: ${this.completion}`)
    }

    return this
  }

  protected preventDuplicateLine(): this {
    const lineCount = this.editor.document.lineCount
    const originalNormalized = this.normalize(this.originalCompletion)

    for (let i = 1; i <= 3; i++) {
      const nextLineIndex = this.cursorPosition.line + i
      if (nextLineIndex >= lineCount) break

      const nextLine = this.editor.document.lineAt(nextLineIndex).text
      const nextLineNormalized = this.normalize(nextLine)

      if (nextLineNormalized === originalNormalized) {
        this.completion = ""
        break
      }

      if (this.calculateStringSimilarity(nextLineNormalized, originalNormalized) > 0.8) {
        this.completion = ""
        break
      }
    }

    if (this.isDebugEnabled) {
      console.log(`After preventDuplicateLine: ${this.completion}`)
    }

    return this
  }

  public removeInvalidLineBreaks(): this {
    if (this.textAfterCursor) {
      this.completion = this.completion.trimEnd()
    }

    if (this.isDebugEnabled) {
      console.log(`After removeInvalidLineBreaks: ${this.completion}`)
    }

    return this
  }

  protected skipMiddleOfWord(): this {
    if (this.isCursorAtMiddleOfWord()) {
      this.completion = ""
    }

    if (this.isDebugEnabled) {
      console.log(`After skipMiddleOfWord: ${this.completion}`)
    }

    return this
  }

  protected skipSimilarCompletions(): this {
    const { document } = this.editor
    const textAfter = document.getText(
      new Range(
        this.cursorPosition,
        document.lineAt(this.cursorPosition.line).range.end
      )
    )

    if (this.calculateStringSimilarity(textAfter, this.completion) > 0.6) {
      this.completion = ""
    }

    if (this.isDebugEnabled) {
      console.log(`After skipSimilarCompletions: ${this.completion}`)
    }

    return this
  }

  protected getCompletion = () => {
    if (this.completion.trim().length === 0) {
      this.completion = ""
    }
    return this.completion
  }

  protected trimStart(): this {
    const firstNonSpaceIndex = this.completion.search(/\S/)
    if (
      firstNonSpaceIndex > 0 &&
      this.cursorPosition.character <= firstNonSpaceIndex
    ) {
      this.completion = this.completion.trimStart()
    }

    if (this.isDebugEnabled) {
      console.log(`After trimStart: ${this.completion}`)
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

    const commentStart = languageId.syntaxComments.start
    const completionLines = this.completion.split("\n").filter((line) => {
      const startsWithComment = line.startsWith(commentStart)
      const includesCommentReference = /\b(Language|File|End):\s*(.*)\b/.test(line)

      return !(startsWithComment && includesCommentReference)
    })

    if (completionLines.length) {
      this.completion = completionLines.join("\n")
    }

    if (this.isDebugEnabled) {
      console.log(`After preventQuotationCompletions: ${this.completion}`)
    }

    return this
  }

  public debug(): void {
    console.log(`Text after cursor: ${this.textAfterCursor}`)
    console.log(`Original completion: ${this.originalCompletion}`)
    console.log(`Normalized completion: ${this.normalizedCompletion}`)
    console.log(`Character after cursor: ${this.charAfterCursor}`)
    console.log(`Character before cursor: ${this.charBeforeCursor}`)
    console.log(`Language ID: ${this.languageId}`)
    console.log(`Final completion: ${this.completion}`)
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

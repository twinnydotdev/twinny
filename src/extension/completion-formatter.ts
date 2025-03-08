import { distance } from "fastest-levenshtein"
import { Position, Range, TextEditor } from "vscode"

import { CLOSING_BRACKETS, OPENING_BRACKETS, QUOTES } from "../common/constants"
import { supportedLanguages } from "../common/languages"
import { Bracket } from "../common/types"
import { getLineBreakCount } from "../webview/utils"

import { getLanguage } from "./utils"

/**
 * Formatter for code completions that handles various edge cases and formatting rules
 * to provide better inline completions in the editor.
 */
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

  /**
   * Enables or disables debug logging
   */
  public setDebug(enabled: boolean): this {
    this.isDebugEnabled = enabled
    return this
  }

  /**
   * Checks if the opening bracket matches the closing bracket
   */
  private isMatchingPair(open?: Bracket, close?: string): boolean {
    const BRACKET_PAIRS: { [key: string]: string } = {
      "(": ")",
      "[": "]",
      "{": "}"
    }
    return BRACKET_PAIRS[open || ""] === close
  }

  /**
   * Matches brackets in the completion to ensure they are balanced
   * and handles nested brackets correctly
   */
  protected matchCompletionBrackets(): this {
    let accumulatedCompletion = ""
    const openBrackets: Bracket[] = []
    let inString = false
    let stringChar = ""

    for (const char of this.originalCompletion) {
      // Handle string literals to avoid matching brackets inside strings
      if (QUOTES.includes(char)) {
        if (!inString) {
          inString = true
          stringChar = char
        } else if (char === stringChar) {
          inString = false
          stringChar = ""
        }
      }

      // Only process brackets when not inside a string
      if (!inString) {
        if (OPENING_BRACKETS.includes(char)) {
          openBrackets.push(char as Bracket)
        } else if (CLOSING_BRACKETS.includes(char)) {
          const lastOpen = openBrackets[openBrackets.length - 1]
          if (lastOpen && this.isMatchingPair(lastOpen, char)) {
            openBrackets.pop()
          } else {
            // Unmatched closing bracket - stop accumulating
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

  /**
   * Ignores blank lines in the completion
   */
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

  /**
   * Normalizes text by trimming and handling special characters
   */
  protected normalize(text: string): string {
    // Basic normalization - trim whitespace
    let normalized = text.trim()

    // Handle special cases for different languages
    const language = getLanguage()
    const languageDetails =
      supportedLanguages[language.languageId as keyof typeof supportedLanguages]

    if (languageDetails) {
      // Remove language-specific comment markers at the beginning of lines
      if (languageDetails.syntaxComments && languageDetails.syntaxComments.start) {
        const commentStart = languageDetails.syntaxComments.start
        if (normalized.startsWith(commentStart)) {
          normalized = normalized.substring(commentStart.length).trim()
        }
      }
    }

    return normalized
  }

  /**
   * Calculates string similarity score between 0 and 1
   * Higher values indicate more similarity
   */
  protected calculateStringSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1.0;
    if (str1.length === 0 || str2.length === 0) return 0.0;

    const maxLen = Math.max(str1.length, str2.length);
    const levenshteinDistance = distance(str1, str2);

    // Convert distance to similarity score (0 to 1)
    return 1 - (levenshteinDistance / maxLen);
  }

  /**
   * Removes duplicate text between the completion and the text after the cursor
   * Uses an optimized algorithm to find the longest overlap
   */
  protected removeDuplicateText(): this {
    const after = this.normalize(this.textAfterCursor)
    if (!after || !this.completion) return this

    const maxLength = Math.min(this.completion.length, after.length)
    let overlapLength = 0

    // Use a more efficient algorithm to find the longest overlap
    // by starting with the longest possible overlap and working down
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

  /**
   * Checks if the cursor is in the middle of a word or identifier
   * Considers language-specific identifier patterns
   */
  protected isCursorAtMiddleOfWord(): boolean {
    // Default check for word characters
    const isAfterWord = /\w/.test(this.charAfterCursor)
    const isBeforeWord = /\w/.test(this.charBeforeCursor)

    // Basic check
    if (!isAfterWord || !isBeforeWord) return false

    // Get language-specific identifier pattern if available
    const language = getLanguage()
    const languageId = language.languageId

    // Enhanced checks for specific languages
    if (languageId) {
      // For languages that use $ in identifiers (like PHP, JavaScript)
      if (["javascript", "typescript", "php"].includes(languageId)) {
        if (this.charBeforeCursor === "$" || this.charAfterCursor === "$") {
          return true
        }
      }

      // For languages that use underscores in identifiers
      if (this.charBeforeCursor === "_" || this.charAfterCursor === "_") {
        return true
      }
    }

    return true
  }

  /**
   * Removes unnecessary quotes when the cursor is in the middle of a word
   */
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

  /**
   * Removes duplicate quotes between the completion and the text after the cursor
   */
  protected removeDuplicateQuotes(): this {
    const trimmedCharAfterCursor = this.charAfterCursor.trim()
    const normalizedCompletion = this.normalize(this.completion)
    const lastCharOfCompletion = normalizedCompletion.charAt(
      normalizedCompletion.length - 1
    )

    // Handle quotes followed by commas
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
    // Handle quotes at the end of completion
    else if (
      (normalizedCompletion.endsWith("'") ||
        normalizedCompletion.endsWith("\"") ||
        normalizedCompletion.endsWith("`")) &&
      QUOTES.includes(trimmedCharAfterCursor)
    ) {
      this.completion = this.completion.slice(0, -1)
    }
    // Handle when the last character of completion matches the first character after cursor
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

  /**
   * Prevents duplicate lines by checking if the completion matches upcoming lines
   */
  protected preventDuplicateLine(): this {
    const lineCount = this.editor.document.lineCount
    const originalNormalized = this.normalize(this.originalCompletion)

    // Check the next few lines to see if they match the completion
    for (let i = 1; i <= 3; i++) {
      const nextLineIndex = this.cursorPosition.line + i
      if (nextLineIndex >= lineCount) break

      const nextLine = this.editor.document.lineAt(nextLineIndex).text
      const nextLineNormalized = this.normalize(nextLine)

      // Check for exact match
      if (nextLineNormalized === originalNormalized) {
        this.completion = ""
        break
      }

      // Check for high similarity
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

  /**
   * Removes invalid line breaks at the end of the completion
   */
  public removeInvalidLineBreaks(): this {
    if (this.textAfterCursor) {
      this.completion = this.completion.trimEnd()
    }

    if (this.isDebugEnabled) {
      console.log(`After removeInvalidLineBreaks: ${this.completion}`)
    }

    return this
  }

  /**
   * Skips completion if the cursor is in the middle of a word
   */
  protected skipMiddleOfWord(): this {
    if (this.isCursorAtMiddleOfWord()) {
      this.completion = ""
    }

    if (this.isDebugEnabled) {
      console.log(`After skipMiddleOfWord: ${this.completion}`)
    }

    return this
  }

  /**
   * Skips completions that are very similar to the text after the cursor
   */
  protected skipSimilarCompletions(): this {
    const { document } = this.editor
    const textAfter = document.getText(
      new Range(
        this.cursorPosition,
        document.lineAt(this.cursorPosition.line).range.end
      )
    )

    // Use our similarity function instead of the undefined .score() method
    if (this.calculateStringSimilarity(textAfter, this.completion) > 0.6) {
      this.completion = ""
    }

    if (this.isDebugEnabled) {
      console.log(`After skipSimilarCompletions: ${this.completion}`)
    }

    return this
  }

  /**
   * Returns the final completion
   */
  protected getCompletion = () => {
    if (this.completion.trim().length === 0) {
      this.completion = ""
    }
    return this.completion
  }

  /**
   * Trims whitespace from the start of the completion
   */
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

  /**
   * Prevents completions that are just comment references
   */
  public preventQuotationCompletions(): this {
    const language = getLanguage()
    const languageId =
      supportedLanguages[language.languageId as keyof typeof supportedLanguages]

    const normalizedCompletion = this.normalize(this.completion)

    // Skip file reference comments
    if (
      normalizedCompletion.startsWith("// File:") ||
      normalizedCompletion === "//"
    ) {
      this.completion = ""
      return this
    }

    // Skip if no language ID or syntax comments
    if (
      !languageId ||
      !languageId.syntaxComments ||
      !languageId.syntaxComments.start
    ) {
      return this
    }

    // Skip if more than one line break (likely a multi-line comment)
    const lineBreakCount = getLineBreakCount(this.completion)
    if (lineBreakCount > 1) return this

    // Filter out comment lines with references
    const commentStart = languageId.syntaxComments.start
    const completionLines = this.completion.split("\n").filter((line) => {
      const startsWithComment = line.startsWith(commentStart)
      const includesCommentReference = /\b(Language|File|End):\s*(.*)\b/.test(line)

      // Keep lines that are not comments or don't have references
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

  /**
   * Logs debug information about the completion
   */
  public debug(): void {
    console.log(`Text after cursor: ${this.textAfterCursor}`)
    console.log(`Original completion: ${this.originalCompletion}`)
    console.log(`Normalized completion: ${this.normalizedCompletion}`)
    console.log(`Character after cursor: ${this.charAfterCursor}`)
    console.log(`Character before cursor: ${this.charBeforeCursor}`)
    console.log(`Language ID: ${this.languageId}`)
    console.log(`Final completion: ${this.completion}`)
  }

  /**
   * Formats the completion by applying various formatting rules
   */
  public format(completion: string): string {
    this.completion = ""
    this.normalizedCompletion = this.normalize(completion)
    this.originalCompletion = completion

    // Apply formatting rules in sequence
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


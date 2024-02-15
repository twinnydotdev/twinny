import { Position, Range, TextEditor } from 'vscode'

import {
  ALL_BRACKETS,
  CLOSING_BRACKETS,
  OPENING_BRACKETS,
  QUOTES
} from '../constants'
import { Bracket } from './types'

export class CompletionFormatter {
  private _characterAfterCursor: string
  private _completion = ''
  private _normalisedCompletion = ''
  private _originalCompletion = ''
  private _textAfterCursor: string
  private _lineText: string
  private _charBeforeCursor: string
  private _charAfterCursor: string
  private _editor: TextEditor
  private _cursorPosition: Position

  constructor(editor: TextEditor) {
    this._editor = editor
    this._cursorPosition = this._editor.selection.active
    const document = editor.document
    const lineEndPosition = document.lineAt(this._cursorPosition.line).range.end
    const textAfterRange = new Range(this._cursorPosition, lineEndPosition)
    this._lineText = this._editor.document.lineAt(
      this._cursorPosition.line
    ).text
    this._textAfterCursor = document?.getText(textAfterRange) || ''
    this._characterAfterCursor = this._textAfterCursor.at(0) as string
    this._editor = editor
    this._charBeforeCursor =
      this._cursorPosition.character > 0
        ? this._lineText[this._cursorPosition.character - 1]
        : ''
    this._charAfterCursor = this._lineText[this._cursorPosition.character]
  }

  private isMatchingPair = (open?: Bracket, close?: string): boolean => {
    return (
      (open === '[' && close === ']') ||
      (open === '(' && close === ')') ||
      (open === '{' && close === '}')
    )
  }

  private matchCompletionBrackets = (): CompletionFormatter => {
    let accumulatedCompletion = ''
    const openBrackets: Bracket[] = []
    for (const character of this._originalCompletion) {
      if (OPENING_BRACKETS.includes(character)) {
        openBrackets.push(character)
      }

      if (CLOSING_BRACKETS.includes(character)) {
        if (
          openBrackets.length &&
          this.isMatchingPair(openBrackets.at(-1), character)
        ) {
          openBrackets.pop()
        } else {
          break
        }
      }
      accumulatedCompletion += character
    }

    this._completion =
      accumulatedCompletion.trimEnd() || this._originalCompletion.trimEnd()

    return this
  }

  private ignoreBlankLines = (): CompletionFormatter => {
    if (
      this._completion.trimStart() === '' &&
      this._originalCompletion !== '\n'
    ) {
      this._completion = this._completion.trim()
    }
    return this
  }

  private isSingleBracket = (completion: string) =>
    completion.length === 1 && this.isBracket(completion)

  private isOnlyBrackets(completion: string): boolean {
    if (completion.length === 0) return false

    for (const char of completion) {
      if (!this.isBracket(char)) {
        return false
      }
    }
    return true
  }

  private normalise = (text: string) => text?.trim()

  private removeDuplicateText = () => {
    const normalisedAfter = this.normalise(this._textAfterCursor)
    if (
      (normalisedAfter &&
        this._normalisedCompletion &&
        normalisedAfter === this._normalisedCompletion) ||
      !this._completion.length ||
      this._normalisedCompletion.endsWith(this._textAfterCursor)
    ) {
      this._completion = this._completion.replace(this._textAfterCursor, '')
    }

    if (
      this._normalisedCompletion &&
      normalisedAfter &&
      this._normalisedCompletion.includes(normalisedAfter)
    ) {
      if (QUOTES.includes(normalisedAfter.at(-1) as string)) {
        this._completion = this._completion.replace(
          normalisedAfter.slice(0, -1),
          ''
        )
        return this
      }

      this._completion = this._completion.replace(normalisedAfter, '')
      return this
    }

    if (
      this._normalisedCompletion &&
      normalisedAfter.includes(this._normalisedCompletion)
    ) {
      const before = normalisedAfter.at(
        normalisedAfter.indexOf(this._normalisedCompletion) - 1
      ) as string
      const after = normalisedAfter.at(
        normalisedAfter.indexOf(this._normalisedCompletion) +
          this._normalisedCompletion.length
      ) as string
      if (this.isMiddleWord(before, after)) {
        return this
      }
      this._completion = ''
      return this
    }

    return this
  }

  private isMiddleWord(before: string, after: string) {
    return before && after && /\w/.test(before) && /\w/.test(after)
  }

  private isCursorAtMiddleOfWord() {
    return (
      this._charAfterCursor &&
      /\w/.test(this._charBeforeCursor) &&
      /\w/.test(this._charAfterCursor)
    )
  }

  private removeUnnecessaryMiddleQuote(): CompletionFormatter {
    const startsWithQuote = QUOTES.includes(this._completion[0])
    const endsWithQuote = QUOTES.includes(this._completion.at(-1) as string)

    if (startsWithQuote && this.isCursorAtMiddleOfWord()) {
      this._completion = this._completion.substring(1)
    }

    if (endsWithQuote && this.isCursorAtMiddleOfWord()) {
      this._completion = this._completion.slice(0, -1)
    }

    return this
  }

  private removeDuplicateQuotes = () => {
    if (
      this._normalisedCompletion.endsWith('\',') ||
      this._normalisedCompletion.endsWith('",') ||
      (this._normalisedCompletion.endsWith('`,') &&
        QUOTES.includes(this._characterAfterCursor))
    ) {
      this._completion = this._completion.slice(0, -3)
    }

    if (
      this._normalisedCompletion.endsWith(
        '\'' ||
          this._normalisedCompletion.endsWith('"') ||
          this._normalisedCompletion.endsWith('`')
      ) &&
      (this._characterAfterCursor === '"' ||
        this._characterAfterCursor === '\'' ||
        this._characterAfterCursor === '`')
    ) {
      this._completion = this._completion.slice(0, -1)
    }

    if (
      QUOTES.includes(this._completion.at(-1) as string) &&
      this._characterAfterCursor === (this._completion.at(-1) as string)
    ) {
      this._completion = this._completion.slice(0, -1)
    }

    return this
  }

  private isBracket = (char: string): char is Bracket => {
    return ALL_BRACKETS.includes(char as Bracket)
  }

  private preventDuplicateLines = (): CompletionFormatter => {
    const lineCount = this._editor.document.lineCount
    let nextLineIndex = this._cursorPosition.line + 1
    while (
      nextLineIndex < this._cursorPosition.line + 3 &&
      nextLineIndex < lineCount
    ) {
      const line = this._editor.document.lineAt(nextLineIndex)
      if (
        this.normalise(line.text) === this.normalise(this._originalCompletion)
      ) {
        this._completion = ''
        return this
      }
      nextLineIndex++
    }

    return this
  }

  public removeInvalidLineBreaks = (): CompletionFormatter => {
    if (this._textAfterCursor) {
      this._completion = this._completion.trimEnd()
    }
    return this
  }

  private checkBrackets = (): CompletionFormatter => {
    if (
      this.isOnlyBrackets(this._normalisedCompletion) ||
      this.isSingleBracket(this._normalisedCompletion)
    ) {
      this._completion = this._normalisedCompletion
    }
    return this
  }

  private skipMiddleOfWord() {
    if (this.isCursorAtMiddleOfWord()) {
      this._completion = ''
    }
    return this
  }

  private getCompletion = () => {
    return this._completion
  }

  public debug() {
    console.log(`text after: ${this._textAfterCursor}`)
    console.log(`original completion: ${this._originalCompletion}`)
    console.log(`normalised completion: ${this._normalisedCompletion}`)
    console.log(`character after: ${this._characterAfterCursor}`)
  }

  public format = (completion: string): string => {
    this._completion = ''
    this._normalisedCompletion = this.normalise(completion)
    this._originalCompletion = completion
    const infillText = this.matchCompletionBrackets()
      .preventDuplicateLines()
      .removeDuplicateQuotes()
      .removeUnnecessaryMiddleQuote()
      .ignoreBlankLines()
      .removeInvalidLineBreaks()
      .checkBrackets()
      .removeDuplicateText()
      .skipMiddleOfWord()
      .getCompletion()
    return infillText
  }
}

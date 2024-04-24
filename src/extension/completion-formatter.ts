import { Position, Range, TextEditor } from 'vscode'

import { CLOSING_BRACKETS, OPENING_BRACKETS, QUOTES } from '../common/constants'
import { Bracket } from '../common/types'
import { getLanguage } from './utils'
import { supportedLanguages } from '../common/languages'
import { getLineBreakCount } from '../webview/utils'

export class CompletionFormatter {
  private _characterAfterCursor: string
  private _charAfterCursor: string
  private _charBeforeCursor: string
  private _completion = ''
  private _cursorPosition: Position
  private _editor: TextEditor
  private _lineText: string
  private _normalisedCompletion = ''
  private _originalCompletion = ''
  private _textAfterCursor: string

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
    this._characterAfterCursor = this._textAfterCursor
      ? (this._textAfterCursor.at(0) as string)
      : ''
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

  private normalise = (text: string) => text?.trim()

  private removeDuplicateText() {
    const after = this.normalise(this._textAfterCursor)

    const maxLength = Math.min(this._completion.length, after.length)
    let overlapLength = 0

    for (let length = 1; length <= maxLength; length++) {
      const endOfCompletion = this._completion.substring(
        this._completion.length - length
      )
      const startOfAfter = after.substring(0, length)
      if (endOfCompletion === startOfAfter) {
        overlapLength = length
      }
    }

    if (overlapLength > 0) {
      this._completion = this._completion.substring(
        0,
        this._completion.length - overlapLength
      )
    }

    return this
  }

  private isCursorAtMiddleOfWord(): boolean {
    return Boolean(
      this._charAfterCursor &&
        /\w/.test(this._charBeforeCursor) &&
        /\w/.test(this._charAfterCursor)
    )
  }

  private removeUnnecessaryMiddleQuote(): CompletionFormatter {
    const isCursorAtMiddle = this.isCursorAtMiddleOfWord()
    if (isCursorAtMiddle) {
      if (QUOTES.includes(this._completion[0])) {
        this._completion = this._completion.substring(1)
      }
      if (QUOTES.includes(this._completion.at(-1) as string)) {
        this._completion = this._completion.slice(0, -1)
      }
    }
    return this
  }

  private removeDuplicateQuotes = () => {
    const trimmedCharAfterCursor = this._characterAfterCursor.trim()
    const lastCharOfCompletion = this._completion.at(-1) as string

    if (
      trimmedCharAfterCursor &&
      (this._normalisedCompletion.endsWith('\',') ||
        this._normalisedCompletion.endsWith('",') ||
        (this._normalisedCompletion.endsWith('`,') &&
          QUOTES.includes(trimmedCharAfterCursor)))
    ) {
      this._completion = this._completion.slice(0, -2)
    } else if (
      (this._normalisedCompletion.endsWith('\'') ||
        this._normalisedCompletion.endsWith('"') ||
        this._normalisedCompletion.endsWith('`')) &&
      QUOTES.includes(trimmedCharAfterCursor)
    ) {
      this._completion = this._completion.slice(0, -1)
    } else if (
      QUOTES.includes(lastCharOfCompletion) &&
      trimmedCharAfterCursor === lastCharOfCompletion
    ) {
      this._completion = this._completion.slice(0, -1)
    }

    return this
  }

  private preventDuplicateLine = (): CompletionFormatter => {
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

  private skipMiddleOfWord() {
    if (this.isCursorAtMiddleOfWord()) {
      this._completion = ''
    }
    return this
  }

  private skipSimilarCompletions = (): this => {
    const { document } = this._editor
    const textAfter = document.getText(
      new Range(
        this._cursorPosition,
        document.lineAt(this._cursorPosition.line).range.end
      )
    )

    if (textAfter.score(this._completion) > 0.6) {
      this._completion = ''
    }

    return this
  }

  private getCompletion = () => {
    if (this._completion.trim().length === 0) {
      this._completion = ''
    }
    return this._completion
  }

  private trimStart = () => {
    const firstNonSpaceIndex = this._completion.search(/\S/)

    if (
      firstNonSpaceIndex > 0 &&
      this._cursorPosition.character <= firstNonSpaceIndex
    ) {
      this._completion = this._completion.trimStart()
    }
    return this
  }

  public preventQuotationCompletions(): this {
    const language = getLanguage()
    const languageId =
      supportedLanguages[language.languageId as keyof typeof supportedLanguages]

    if (this._normalisedCompletion.startsWith('// File:') || this._normalisedCompletion === '//') {
      this._completion = ''
      return this
    }

    if (
      !languageId ||
      !languageId.syntaxComments ||
      !languageId.syntaxComments.start
    ) {
      return this
    }

    if (!languageId || !languageId.syntaxComments) return this

    const lineCount = getLineBreakCount(this._completion)

    if (lineCount > 1) return this

    const completionLines = this._completion.split('\n').filter((line) => {
      const startsWithComment = line.startsWith(languageId.syntaxComments.start)
      const includesCommentReference = /\b(Language|File|End):\s*(.*)\b/.test(
        line
      )
      const isComment = line.startsWith(languageId.syntaxComments.start)
      return !(startsWithComment && includesCommentReference) && !isComment
    })

    if (completionLines.length) {
      this._completion = completionLines.join('\n')
    }

    return this
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
      .preventQuotationCompletions()
      .preventDuplicateLine()
      .removeDuplicateQuotes()
      .removeUnnecessaryMiddleQuote()
      .ignoreBlankLines()
      .removeInvalidLineBreaks()
      .removeDuplicateText()
      .skipMiddleOfWord()
      .skipSimilarCompletions()
      .trimStart()
      .getCompletion()
    return infillText
  }
}

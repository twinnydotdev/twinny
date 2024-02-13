import { Range, TextEditor } from 'vscode'

import {
  ALL_BRACKETS,
  CLOSING_BRACKETS,
  NORMALIZE_REGEX,
  OPENING_BRACKETS
} from '../constants'
import { Bracket } from './types'

export class CompletionFormatter {
  private _characterAfterCursor: string
  private _textAfterCursor: string
  private _completion: string
  private _normalisedCompletion: string
  private _originalCompletion: string

  constructor(completion: string, editor: TextEditor) {
    const cursorPosition = editor.selection.active
    const document = editor.document
    const lineEndPosition = document.lineAt(cursorPosition.line).range.end
    const textAfterRange = new Range(cursorPosition, lineEndPosition)
    this._textAfterCursor = document?.getText(textAfterRange) || ''
    this._characterAfterCursor = this._textAfterCursor.at(0) as string
    this._completion = ''
    this._normalisedCompletion = this.normalise(completion)
    this._originalCompletion = completion
  }

  private isMatchingPair = (open?: Bracket, close?: string): boolean => {
    return (
      (open === '[' && close === ']') ||
      (open === '(' && close === ')') ||
      (open === '{' && close === '}')
    )
  }

  private bracketMatch = (): CompletionFormatter => {
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

    this._completion = accumulatedCompletion.trimEnd() || this._originalCompletion.trimEnd()

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

  private normalise = (text: string) => text?.replace(NORMALIZE_REGEX, '')

  private removeDuplicates = () => {
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
    return this
  }

  private removeDoubleQuotes = () => {
    if (
      this._completion.endsWith('\'' || this._completion.endsWith('"')) &&
      (this._characterAfterCursor === '"' || this._characterAfterCursor === '\'')
    ) {
      this._completion = this._completion.slice(0, -1)
    }
    return this
  }

  private isBracket = (char: string): char is Bracket => {
    return ALL_BRACKETS.includes(char as Bracket)
  }

  private getCompletion = () => {
    if (this.isSingleBracket(this._normalisedCompletion)) {
      return this._normalisedCompletion
    }
    return this._completion
  }

  public format = (): string => {
    this
      .bracketMatch()
      .removeDoubleQuotes()
      .removeDuplicates()
      .ignoreBlankLines()
      .getCompletion()

    return this._completion
  }
}

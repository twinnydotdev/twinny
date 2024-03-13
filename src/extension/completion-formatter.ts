import { Position, Range, TextEditor } from 'vscode'

import {
  CLOSING_BRACKETS,
  OPENING_BRACKETS,
  QUOTES,
  TARGET_EXPORT_NODES
} from '../common/constants'
import { Bracket } from '../common/types'
import Parser from 'web-tree-sitter'

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
  private _filePath: string
  private _parser?: Parser

  constructor(editor: TextEditor, parser?: Parser) {
    this._editor = editor
    this._parser = parser
    this._cursorPosition = this._editor.selection.active
    const document = editor.document
    this._filePath = document?.uri.fsPath
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
    for (const character of this._completion) {
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
      this._characterAfterCursor.trim() &&
      this._characterAfterCursor.trim().length &&
      (this._normalisedCompletion.endsWith('\',') ||
        this._normalisedCompletion.endsWith('",') ||
        (this._normalisedCompletion.endsWith('`,') &&
          QUOTES.includes(this._characterAfterCursor)))
    ) {
      this._completion = this._completion.slice(0, -2)
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

  private skipMiddleOfWord() {
    if (this.isCursorAtMiddleOfWord()) {
      this._completion = ''
    }
    return this
  }

  private skipSimilarCompletions = () => {
    const textAfter = this._editor.document.getText(
      new Range(
        this._cursorPosition,
        this._editor.document.lineAt(this._cursorPosition.line).range.end
      )
    )

    const score = textAfter.score(this._completion)

    if (score > 0.5) this._completion = ''

    return this
  }

  private getSnippets(rootNode: Parser.SyntaxNode | undefined): string {
    if (!rootNode) return ''

    const findNodes = (
      node: Parser.SyntaxNode,
      types: string[]
    ): Parser.SyntaxNode[] => {
      let nodes = []
      if (types.includes(node.type)) {
        nodes.push(node)
      }
      for (const child of node.children) {
        nodes = nodes.concat(findNodes(child, types))
      }
      return nodes
    }

    const targetedNodes = findNodes(rootNode, TARGET_EXPORT_NODES)

    const errorFreeSnippets = targetedNodes
      .filter((n) => !n.hasError())
      .map((n) => n.text)

    if (!errorFreeSnippets.length) return this._completion

    return errorFreeSnippets[0]
  }

  private parseCompletion() {
    const parsed = this._parser?.parse(this._completion)
    this._completion = this.getSnippets(parsed?.rootNode)
    return this
  }

  private getCompletion = () => {
    if (this._completion.trim().length === 0) {
      this._completion = ''
    }
    return this._completion
  }

  public debug() {
    console.log(`text after: ${this._textAfterCursor}`)
    console.log(`original completion: ${this._originalCompletion}`)
    console.log(`normalised completion: ${this._normalisedCompletion}`)
    console.log(`character after: ${this._characterAfterCursor}`)
  }

  public format = (completion: string): string => {
    this._completion = completion
    this._normalisedCompletion = this.normalise(completion)
    this._originalCompletion = completion
    const infillText = this.parseCompletion()
      .matchCompletionBrackets()
      .preventDuplicateLines()
      .removeDuplicateQuotes()
      .removeUnnecessaryMiddleQuote()
      .ignoreBlankLines()
      .removeInvalidLineBreaks()
      .removeDuplicateText()
      .skipMiddleOfWord()
      .skipSimilarCompletions()
      .getCompletion()
    return infillText
  }
}

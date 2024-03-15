import { Position, Range, TextEditor } from 'vscode'

import {
  PARSEABLE_NODES,
} from '../common/constants'

import Parser from 'web-tree-sitter'
import { getIsOnlyBrackets } from './utils'

export class CompletionFormatter {
  private _characterAfterCursor: string
  private _completion = ''
  private _normalisedCompletion = ''
  private _originalCompletion = ''
  private _textAfterCursor: string
  private _lineText: string
  private _editor: TextEditor
  private _cursorPosition: Position
  private _parser?: Parser
  private _textBefore: string
  private _rangeWindow = 20

  constructor(editor: TextEditor, parser?: Parser) {
    this._editor = editor
    this._parser = parser
    this._cursorPosition = this._editor.selection.active
    const document = editor.document
    const lineEndPosition = document.lineAt(this._cursorPosition.line).range.end
    const textAfterRange = new Range(this._cursorPosition, lineEndPosition)
    const lineStart = this._editor.document.lineAt(
      Math.max(0, this._cursorPosition.line - this._rangeWindow)
    ).range.start
    const textBeforeRange = new Range(lineStart, this._cursorPosition)
    this._textBefore = this._editor.document.getText(textBeforeRange)
    this._lineText = this._editor.document.lineAt(
      this._cursorPosition.line
    ).text
    this._textAfterCursor = document?.getText(textAfterRange) || ''
    this._characterAfterCursor = this._textAfterCursor
      ? (this._textAfterCursor.at(0) as string)
      : ''
    this._editor = editor
  }

  private normalise = (text: string) => text?.trim()

  public removeInvalidLineBreaks = (): CompletionFormatter => {
    if (this._textAfterCursor) {
      this._completion = this._completion.trimEnd()
    }
    return this
  }

  public getCompletionCandidate(): string {
    const codeSnippet = getIsOnlyBrackets(this._textBefore.trim())
      ? this._completion
      : `${this._textBefore.trim()}${this._completion}`

    const parsed = this._parser?.parse(codeSnippet)

    if (!parsed?.rootNode) return ''

    const parsableNodes = parsed.rootNode.children.filter(
      (node: Parser.SyntaxNode) => {
        return PARSEABLE_NODES.includes(node.type) && !node.hasError()
      }
    )

    const node = parsableNodes.find((node) => {
      return !this._editor.document.getText().includes(node.text)
    })

    if (!node) return ''

    if (this._originalCompletion.startsWith('\n\n')) {
      return `\n\n${node.text}`
    }

    if (this._originalCompletion.startsWith('\n')) {
      return `\n${node.text}`
    }

    return node.text
  }

  removeDuplicateAndMerge(firstString: string, secondString: string) {
    const trimmedFirstString = firstString.trim()
    const trimmedSecondString = secondString.trim()
    let appendIndex = -1
    for (let i = 0; i < trimmedFirstString.length; i++) {
      const suffix = trimmedFirstString.substring(i)
      if (trimmedSecondString.startsWith(suffix)) {
        appendIndex = suffix.length
        break
      }
    }
    if (appendIndex === -1) {
      return trimmedSecondString
    }
    return trimmedSecondString.substring(appendIndex)
  }

  private getCompletion = () => {
    if (!this._completion) return ''
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

  public manuallyParseCompletion() {
    this._completion = this.removeDuplicateAndMerge(this._textBefore, this._completion)
    return this
  }

  public getFormattedCompletion = (completion: string): string => {
    this._completion = completion
    this._normalisedCompletion = this.normalise(completion)
    this._originalCompletion = completion
    const parsedCompletion = this.getCompletionCandidate()
    if (completion) {
      return parsedCompletion
    }
    return this.manuallyParseCompletion().getCompletion()
  }
}

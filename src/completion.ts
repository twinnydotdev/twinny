import {
  InlineCompletionItem,
  InlineCompletionItemProvider,
  InlineCompletionList,
  Position,
  Range,
  TextDocument,
  workspace,
  StatusBarItem,
  window
} from 'vscode'
import { streamResponse } from './utils'

export class CompletionProvider implements InlineCompletionItemProvider {
  private _statusBar: StatusBarItem
  private _lineContexts: string[] = []
  private _lineContextLength = 10
  private _lineContextTimeout = 200
  private _debouncer: NodeJS.Timeout | undefined
  private _config = workspace.getConfiguration('twinny')
  private _debounceWait = this._config.get('debounceWait') as number
  private _contextLength = this._config.get('contextLength') as number
  private _model = this._config.get('ollamaModelName') as string
  private _baseurl = this._config.get('ollamaBaseUrl') as string
  private _apiport = this._config.get('ollamaApiPort') as number

  constructor(statusBar: StatusBarItem) {
    this._statusBar = statusBar
    this.registerOnChangeContextListener()
  }

  public async provideInlineCompletionItems(
    document: TextDocument,
    position: Position
  ): Promise<InlineCompletionItem[] | InlineCompletionList | null | undefined> {
    const editor = window.activeTextEditor
    if (!editor) {
      return
    }

    const line = editor.document.lineAt(position.line)

    const charsAfterRange = new Range(editor.selection.start, line.range.end)

    const textAfterCursor = editor.document.getText(charsAfterRange)

    if (textAfterCursor.trim()) {
      return
    }

    return new Promise((resolve) => {
      if (this._debouncer) {
        clearTimeout(this._debouncer)
      }

      this._debouncer = setTimeout(async () => {
        if (!this._config.get('enabled')) return resolve([])

        const prompt = this.getPrompt(document, position)

        if (!prompt) return resolve([] as InlineCompletionItem[])

        let completion = ''

        try {
          this._statusBar.text = '$(code)'

          await new Promise((resolveStream) => {
            this._statusBar.text = '$(loading~spin)'
            streamResponse(
              {
                hostname: this._baseurl,
                port: this._apiport,
                method: 'POST',
                path: '/api/generate'
              },
              {
                model: this._model,
                prompt
              },
              (chunk, onComplete) => {
                try {
                  const json = JSON.parse(chunk)
                  completion = completion + json.response
                  if (json.response === '\n' || json.response.match('<EOT>')) {
                    onComplete()
                    resolveStream(null)
                    this._statusBar.text = '$(code)'
                    resolve(
                      this.getInlineCompletions(
                        completion.replace('<EOT>', ''),
                        position,
                        document
                      )
                    )
                  }
                } catch (error) {
                  console.error('Error parsing JSON:', error)
                  return
                }
              }
            )
          })
        } catch (error) {
          this._statusBar.text = '$(alert)'
          return resolve([] as InlineCompletionItem[])
        }
      }, this._debounceWait as number)
    })
  }

  private getPrompt(document: TextDocument, position: Position) {
    const { prefix, suffix } = this.getContext(document, position)

    return `<PRE> ${prefix} <SUF> ${suffix} <MID>`
  }

  private registerOnChangeContextListener() {
    let timeout: NodeJS.Timer | undefined
    window.onDidChangeTextEditorSelection((e) => {
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(() => {
        const editor = window.activeTextEditor
        if (!editor) return
        const document = editor.document
        const line = editor.document.lineAt(e.selections[0].anchor.line)
        const lineText = document.getText(
          new Range(
            line.lineNumber,
            0,
            line.lineNumber,
            line.range.end.character
          )
        )
        if (lineText.trim().length < 2) return // most likely a bracket or un-interesting
        if (this._lineContexts.length === this._lineContextLength) {
          this._lineContexts.pop()
        }
        this._lineContexts.unshift(lineText.trim())
        this._lineContexts = [...new Set(this._lineContexts)]
      }, this._lineContextTimeout)
    })
  }

  getContext(
    document: TextDocument,
    position: Position
  ): { prefix: string; suffix: string } {
    const line = position.line
    const startLine = Math.max(0, line - this._contextLength)
    const endLine = line + this._contextLength

    const prefixRange = new Range(startLine, 0, line, position.character)
    const suffixRange = new Range(line, position.character, endLine, 0)

    const prefix = document.getText(prefixRange)
    const suffix = document.getText(suffixRange)

    return { prefix, suffix }
  }

  private getInlineCompletions(
    completion: string,
    position: Position,
    document: TextDocument
  ): InlineCompletionItem[] {
    const editor = window.activeTextEditor
    if (!editor) return []
    if (position.character === 0) {
      return [
        new InlineCompletionItem(
          completion as string,
          new Range(position, position)
        )
      ]
    }

    const charBeforeRange = new Range(
      position.translate(0, -1),
      editor.selection.start
    )

    const charBefore = document.getText(charBeforeRange)

    if (completion === ' ' && charBefore === ' ') {
      completion = completion.slice(1, completion.length)
    }

    return [
      new InlineCompletionItem(completion.trim(), new Range(position, position))
    ]
  }

  public updateConfig() {
    this._config = workspace.getConfiguration('twinny')
    this._debounceWait = this._config.get('debounceWait') as number
    this._contextLength = this._config.get('contextLength') as number
  }
}

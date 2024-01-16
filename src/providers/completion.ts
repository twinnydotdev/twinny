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
import 'string_score'
import { noop, streamResponse } from '../utils'
import { getCache, setCache } from '../cache'

export class CompletionProvider implements InlineCompletionItemProvider {
  private _statusBar: StatusBarItem
  private _lineContexts: string[] = []
  private _lineContextLength = 10
  private _lineContextTimeout = 200
  private _debouncer: NodeJS.Timeout | undefined
  private _config = workspace.getConfiguration('twinny')
  private _debounceWait = this._config.get('debounceWait') as number
  private _contextLength = this._config.get('contextLength') as number
  private _model = this._config.get('fimModelName') as string
  private _baseurl = this._config.get('ollamaBaseUrl') as string
  private _apiport = this._config.get('ollamaApiPort') as number
  private _useTls = this._config.get('ollamaUseTls') as boolean
  private _temperature = this._config.get('temperature') as number

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

    return new Promise((resolve) => {
      if (this._debouncer) {
        clearTimeout(this._debouncer)
      }

      this._debouncer = setTimeout(async () => {
        if (!this._config.get('enabled')) return resolve([])
        const currentLine = editor.document.lineAt(
          editor.selection.active.line
        ).text

        const codeContext = this.getContextSnippets()
        const context = this.getPromptContext(currentLine, codeContext)

        const { prompt, prefix, suffix } = this.getPrompt(
          document,
          position,
          context
        )
        const cachedValue = getCache({ prefix, suffix })
        if (cachedValue) {
          return resolve(
            this.getInlineCompletion(
              cachedValue,
              position,
              document,
              prefix,
              suffix
            )
          )
        }

        if (!prompt) return resolve([] as InlineCompletionItem[])

        let completion = ''

        try {
          this._statusBar.text = '🤖'

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
                prompt,
                options: {
                  temperature: this._temperature
                }
              },
              (chunk, onComplete) => {
                try {
                  const json = JSON.parse(chunk)
                  completion = completion + json.response
                  if (
                    (json.response && json.response === '\n') ||
                    json.response.match('<EOT>')
                  ) {
                    onComplete()
                    resolveStream(null)
                    this._statusBar.text = '🤖'
                    resolve(
                      this.getInlineCompletion(
                        completion.replace('<EOT>', ''),
                        position,
                        document,
                        prefix,
                        suffix
                      )
                    )
                  }
                } catch (error) {
                  console.error('Error parsing JSON:', error)
                  return
                }
              },
              noop,
              noop,
              this._useTls
            )
          })
        } catch (error) {
          this._statusBar.text = '$(alert)'
          return resolve([] as InlineCompletionItem[])
        }
      }, this._debounceWait as number)
    })
  }

  private getPrompt(
    document: TextDocument,
    position: Position,
    context: string[]
  ) {
    const { prefix, suffix } = this.getContext(document, position)

    if (this._model.includes('deepseek')) {
      return {
        prompt: `<｜fim▁begin｜>${context.join(
          ''
        )} ${prefix}<｜fim▁hole｜>${suffix}<｜fim▁end｜>`,
        prefix,
        suffix
      }
    }

    return {
      prompt: `<PRE> ${context.join('')} ${prefix} <SUF> ${suffix} <MID>`,
      prefix,
      suffix
    }
  }

  private getContextSnippets(): string[] {
    const codeSnippets: string[] = []

    for (const document of workspace.textDocuments) {
      if (
        document.fileName === window.activeTextEditor?.document.fileName ||
        document.fileName.includes('git')
      ) {
        continue
      }

      const fullText = document.getText()
      codeSnippets.push(fullText)
    }

    return codeSnippets
  }

  private getPromptContext(
    currentLine: string,
    codeSnippets: string[]
  ): string[] {
    const matches: string[] = []

    const totalSnippetLines = codeSnippets.reduce((prev, curr) => {
      return prev + curr.split('\n').length
    }, 0)

    for (const snippet of codeSnippets) {
      if (totalSnippetLines < this._contextLength / 2) {
        matches.push(codeSnippets.join('\n\n'))
      }

      const lines = snippet.split('\n')

      for (const line of lines) {
        if (line.score(currentLine, 0.5) > 0) {
          matches.push(`${line}\n`)
        }
      }
    }

    return matches
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

  private getInlineCompletion(
    completion: string,
    position: Position,
    document: TextDocument,
    prefix: string,
    suffix: string
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

    const cursorPosition = editor.selection.active

    const charBeforeRange = new Range(
      position.translate(0, -1),
      editor.selection.start
    )

    const lineEndPosition = editor.document.lineAt(cursorPosition.line).range
      .end

    const textAfterRange = new Range(cursorPosition, lineEndPosition)
    const textAfterCursor = document.getText(textAfterRange).trim()
    const charBefore = document.getText(charBeforeRange)
    const lineStart = editor.document.lineAt(cursorPosition).range.start
    const lineRange = new Range(lineStart, lineEndPosition)
    const lineText = document.getText(lineRange)

    if (
      completion.trim() === '/' ||
      lineText.includes(completion.trim()) ||
      (completion.trim() === '/>' && lineText.includes('</'))
    ) {
      return []
    }

    if (completion === ' ' && charBefore === ' ') {
      completion = completion.slice(1, completion.length)
    }

    if (completion.includes(textAfterCursor)) {
      completion = completion.replace(textAfterCursor, '').replace('\n', '')
    }

    if (lineText.includes(completion.trim())) {
      return []
    }

    setCache({
      prefix,
      suffix,
      completion
    })

    return [
      new InlineCompletionItem(completion.trim(), new Range(position, position))
    ]
  }

  public updateConfig() {
    this._config = workspace.getConfiguration('twinny')
    this._debounceWait = this._config.get('debounceWait') as number
    this._contextLength = this._config.get('contextLength') as number
    this._temperature = this._config.get('temperature') as number
  }
}

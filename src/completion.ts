import {
  Configuration,
  CreateCompletionRequestPrompt,
  CreateCompletionResponse,
  OpenAIApi
} from 'openai'
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
import { CompletionRequest } from './types'

export class CompletionProvider implements InlineCompletionItemProvider {
  private _statusBar: StatusBarItem
  private _lineContexts: string[] = []
  private _lineContextLength = 10
  private _lineContextTimeout = 200
  private _debouncer: NodeJS.Timeout | undefined
  private _config = workspace.getConfiguration('twinny')
  private _debounceWait = this._config.get('debounceWait') as number
  private _contextLength = this._config.get('contextLength') as number
  private _openaiConfig = new Configuration()
  private _serverPath = this._config.get('server')
  private _engine = this._config.get('engine')
  private _usePreviousContext = this._config.get('usePreviousContext')
  private _basePath = `${this._serverPath}/${this._engine}`
  private _openai: OpenAIApi = new OpenAIApi(this._openaiConfig, this._basePath)

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
        if (!this._config.get('enabled'))
          return resolve([] as InlineCompletionItem[])

        const prompt = this.getPrompt(document, position)

        if (!prompt) return resolve([] as InlineCompletionItem[])

        this._statusBar.tooltip = 'twinny - thinking...'
        this._statusBar.text = '$(loading~spin)'

        const options: CompletionRequest = {
          model: '',
          prompt: prompt as CreateCompletionRequestPrompt,
          max_time: this._config.get('maxTime'),
          max_tokens: this._config.get('maxTokens'),
          num_return_sequences: this._config.get('numReturnSequences'),
          temperature: this._config.get('temperature'),
          one_line: this._config.get('oneLine'),
          top_p: this._config.get('topP'),
          top_k: this._config.get('topK'),
          repetition_penalty: this._config.get('repetitionPenalty')
        }

        try {
          const { data } = await this._openai.createCompletion(options)
          this._statusBar.text = '$(code)'
          this._statusBar.tooltip = 'twinny - Ready'
          return resolve(this.getInlineCompletions(data, position, document))
        } catch (error) {
          this._statusBar.text = '$(alert)'
          return resolve([] as InlineCompletionItem[])
        }
      }, this._debounceWait as number)
    })
  }

  private getPrompt(document: TextDocument, position: Position) {
    const { prefix, suffix } = this.getContext(document, position)
    const prompt = `
      ${this._usePreviousContext ? `${this._lineContexts.join('\n')}\n` : ''}
      ${prefix}<FILL_HERE>${suffix}
    `
    console.log(prompt)
    return prompt
  }

  private registerOnChangeContextListener() {
    let timeout: NodeJS.Timer | undefined
    window.onDidChangeTextEditorSelection((e) => {
      if (!this._usePreviousContext) {
        return
      }
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(() => {
        const editor = window.activeTextEditor
        if (!editor) return
        const fileUri = editor.document.uri
        const fileName = workspace.asRelativePath(fileUri)
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
        this._lineContexts.unshift(
          `filename: ${fileName} - code: ${lineText.trim()}`
        )
        this._lineContexts = [...new Set(this._lineContexts)]
      }, this._lineContextTimeout)
    })
  }

  private getContext(
    document: TextDocument,
    position: Position
  ): { prefix: string; suffix: string } {
    const start = Math.max(0, position.line - this._contextLength)
    const prefix = document.getText(
      new Range(start, 0, position.line, this._contextLength)
    )
    const suffix = document.getText(
      new Range(
        position.line,
        position.character,
        position.line + this._contextLength,
        0
      )
    )
    return { prefix, suffix }
  }

  private getInlineCompletions(
    completionResponse: CreateCompletionResponse,
    position: Position,
    document: TextDocument
  ): InlineCompletionItem[] {
    const editor = window.activeTextEditor
    if (!editor) return []
    return (
      completionResponse.choices?.map((choice) => {
        if (position.character === 0) {
          return new InlineCompletionItem(
            choice.text as string,
            new Range(position, position)
          )
        }

        const charBeforeRange = new Range(
          position.translate(0, -1),
          editor.selection.start
        )

        const charBefore = document.getText(charBeforeRange)

        if (choice.text === ' ' && charBefore === ' ') {
          choice.text = choice.text.slice(1, choice.text.length)
        }

        return new InlineCompletionItem(
          choice.text?.trim() as string,
          new Range(position, position)
        )
      }) || []
    )
  }

  public updateConfig() {
    this._config = workspace.getConfiguration('twinny')
    this._debounceWait = this._config.get('debounceWait') as number
    this._contextLength = this._config.get('contextLength') as number
    this._serverPath = this._config.get('server')
    this._engine = this._config.get('engine')
    this._usePreviousContext = this._config.get('_usePreviousContext')

    this._basePath = `${this._serverPath}/${this._engine}`
    this._openai = new OpenAIApi(this._openaiConfig, this._basePath)
  }
}

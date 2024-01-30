import {
  InlineCompletionItem,
  InlineCompletionItemProvider,
  InlineCompletionList,
  Position,
  Range,
  TextDocument,
  workspace,
  StatusBarItem,
  window,
  Uri,
  TextEditor,
  InlineCompletionContext,
  CompletionTriggerKind
} from 'vscode'
import 'string_score'
import { streamResponse } from '../utils'
import { getCache, setCache } from '../cache'
import { languages } from '../languages'
import { InlineCompletion, StreamOptions } from '../types'
import { RequestOptions } from 'https'
import { ClientRequest } from 'http'
import { getFimPromptTemplate } from '../prompt-template'

export class CompletionProvider implements InlineCompletionItemProvider {
  private _statusBar: StatusBarItem
  private _debouncer: NodeJS.Timeout | undefined
  private _document: TextDocument | undefined
  private _config = workspace.getConfiguration('twinny')
  private _debounceWait = this._config.get('debounceWait') as number
  private _contextLength = this._config.get('contextLength') as number
  private _fimModel = this._config.get('fimModelName') as string
  private _apiUrl = this._config.get('apiUrl') as string
  private _port = this._config.get('fimApiPort') as number
  private _apiPath = this._config.get('fimApiPath') as string
  private _temperature = this._config.get('temperature') as number
  private _numPredictFim = this._config.get('numPredictFim') as number
  private _useFileContext = this._config.get('useFileContext') as boolean
  private _disableAutoSuggest = this._config.get('disableAutoSuggest') as boolean
  private _bearerToken = this._config.get('apiBearerToken') as number
  private _enableCompletionCache = this._config.get(
    'enableCompletionCache'
  ) as boolean
  private _currentReq: ClientRequest | undefined = undefined
  private _isModelAvailable = true

  constructor(statusBar: StatusBarItem) {
    this._statusBar = statusBar
  }

  private buildStreamRequest(prompt: string) {
    const headers: Record<string, string> = {}

    if (this._bearerToken) {
      headers.Authorization = `Bearer ${this._bearerToken}`
    }

    const requestBody: StreamOptions = {
      model: this._fimModel,
      prompt,
      stream: true,
      n_predict: this._numPredictFim,
      temperature: this._temperature,
      // Ollama
      options: {
        temperature: this._temperature,
        num_predict: this._numPredictFim || -2
      }
    }

    const requestOptions: RequestOptions = {
      hostname: this._apiUrl,
      port: this._port,
      path: this._apiPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._bearerToken}`
      }
    }

    return { requestOptions, requestBody }
  }

  public destroyStream = () => {
    this._currentReq?.destroy()
    this._statusBar.text = '🤖'
  }

  public async provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    context: InlineCompletionContext,
  ): Promise<InlineCompletionItem[] | InlineCompletionList | null | undefined> {
    this._document = document
    const editor = window.activeTextEditor

    if (context.triggerKind === CompletionTriggerKind.TriggerCharacter.valueOf() && this._disableAutoSuggest) {
      return
    }

    const language = editor?.document.languageId

    if (!editor) {
      return
    }

    return new Promise((resolve) => {
      if (this._debouncer) {
        clearTimeout(this._debouncer)
      }

      this._debouncer = setTimeout(async () => {
        if (!this._config.get('enabled')) return resolve([])

        const context = this.getFileContext(document.uri)

        const { prefix, suffix } = this.getPositionContext(document, position)

        const { prompt } = getFimPromptTemplate({
          context,
          prefix,
          suffix,
          header: this.getFileHeader(language, document.uri),
          useFileContext: this._useFileContext
        })

        const cachedCompletion = getCache({ prefix, suffix })

        if (cachedCompletion && this._enableCompletionCache) {
          return resolve(
            this.triggerInlineCompletion({
              completion: cachedCompletion,
              position,
              prefix,
              suffix
            })
          )
        }

        if (!prompt) return resolve([])

        try {
          let completion = ''
          let chunkCount = 0
          this._statusBar.text = '$(loading~spin)'
          this._statusBar.command = 'twinny.stopGeneration'

          const { requestBody, requestOptions } =
            this.buildStreamRequest(prompt)

          streamResponse({
            body: requestBody,
            options: requestOptions,
            onStart: (req) => {
              this._currentReq = req
            },
            onData: (streamResponse, destroy) => {
              try {
                const completionString =
                  streamResponse?.response || streamResponse?.content

                if (!completionString) {
                  this._statusBar.text = '🤖'
                  return resolve([])
                }

                completion = completion + completionString
                chunkCount = chunkCount + 1

                if (
                  (chunkCount > 6 && completionString === '\n') ||
                  completion?.match('<EOT>')
                ) {
                  this._statusBar.text = '🤖'
                  completion = completion.replace('<EOT>', '')
                  destroy()
                  resolve(
                    this.triggerInlineCompletion({
                      completion,
                      position,
                      prefix,
                      suffix
                    })
                  )
                }
              } catch (e) {
                this._currentReq?.destroy()
                console.error(e)
              }
            }
          })
        } catch (error) {
          this._statusBar.text = '$(alert)'
          return resolve([] as InlineCompletionItem[])
        }
      }, this._debounceWait as number)
    })
  }

  private getFileHeader(languageId: string | undefined, uri: Uri) {
    const lang = languages[languageId as keyof typeof languages]

    if (!lang) {
      return ''
    }

    const language = `${lang.comment?.start || ''} Language: ${
      lang.name
    } (${languageId}) ${lang.comment?.end || ''}`

    const path = `${
      lang.comment?.start || ''
    } File uri: ${uri.toString()} (${languageId}) ${lang.comment?.end || ''}`

    return `\n${language}\n${path}\n`
  }

  private calculateSimilarity(path1: string, path2: string): number {
    const components1 = path1.split('/')
    const components2 = path2.split('/')

    const fileName1 = components1[components1.length - 1]
    const fileName2 = components2[components2.length - 1]

    const folderSimilarity = components1
      .slice(0, -1)
      .join('/')
      .score(components2.slice(0, -1).join('/'), 0.5)

    const filenameSimilarity = fileName1.score(fileName2, 0.5)

    return folderSimilarity + filenameSimilarity
  }

  private getFileContext(uri: Uri): string {
    const codeSnippets: string[] = []
    const currentFileName = uri.toString()

    for (const document of workspace.textDocuments) {
      if (
        document.fileName === window.activeTextEditor?.document.fileName ||
        document.fileName.includes('git')
      ) {
        continue
      }

      const text = `${this.getFileHeader(
        document.languageId,
        document.uri
      )}${document.getText()}`

      const similarity = this.calculateSimilarity(
        currentFileName.toString(),
        document.uri.toString()
      )

      if (similarity > 1) {
        codeSnippets.push(text)
      }
    }

    return codeSnippets.join('\n')
  }

  getPositionContext(
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

  private getFormattedCompletion = (completion: string, editor: TextEditor) => {
    const cursorPosition = editor.selection.active

    const lineEndPosition = editor.document.lineAt(cursorPosition.line).range
      .end

    const lineStart = editor.document.lineAt(cursorPosition).range.start
    const lineRange = new Range(lineStart, lineEndPosition)
    const lineText = this._document?.getText(lineRange)

    if (
      completion.trim() === '/' ||
      lineText?.includes(completion.trim()) ||
      (completion.trim() === '/>' && lineText?.includes('</'))
    ) {
      return ''
    }

    if (completion.endsWith('\n')){
      const parts = completion.split('\n');
      completion = parts.slice(0, -1).join('\n') + parts.slice(-1);
    }

    return completion
  }

  private triggerInlineCompletion(
    inlineCompletion: InlineCompletion
  ): InlineCompletionItem[] {
    const { position, prefix, suffix } = inlineCompletion

    const editor = window.activeTextEditor

    if (!editor) {
      return []
    }

    const completion = this.getFormattedCompletion(
      inlineCompletion.completion,
      editor
    )

    if (this._enableCompletionCache) {
      setCache({ prefix, suffix, completion })
    }

    return [new InlineCompletionItem(completion, new Range(position, position))]
  }

  public updateConfig() {
    this._config = workspace.getConfiguration('twinny')
    this._debounceWait = this._config.get('debounceWait') as number
    this._contextLength = this._config.get('contextLength') as number
    this._temperature = this._config.get('temperature') as number
    this._useFileContext = this._config.get('useFileContext') as boolean
    this._disableAutoSuggest = this._config.get('disableAutoSuggest') as boolean
    this._fimModel = this._config.get('fimModelName') as string
    this._numPredictFim = this._config.get('numPredictFim') as number
    this._apiPath = this._config.get('fimApiPath') as string
    this._port = this._config.get('fimApiPort') as number
    this._apiUrl = this._config.get('apiUrl') as string
    this._enableCompletionCache = this._config.get(
      'enableCompletionCache'
    ) as boolean
  }
}

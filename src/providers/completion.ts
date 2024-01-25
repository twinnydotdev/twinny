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
  TextEditor
} from 'vscode'
import 'string_score'
import { getIsModelAvailable, streamResponse } from '../utils'
import { getCache, setCache } from '../cache'
import { languages } from '../languages'
import { InlineCompletion, OllamStreamResponse, StreamBody } from '../types'
import { RequestOptions } from 'https'
import { ClientRequest } from 'http'

export class CompletionProvider implements InlineCompletionItemProvider {
  private _statusBar: StatusBarItem
  private _debouncer: NodeJS.Timeout | undefined
  private _document: TextDocument | undefined
  private _config = workspace.getConfiguration('twinny')
  private _debounceWait = this._config.get('debounceWait') as number
  private _contextLength = this._config.get('contextLength') as number
  private _fimModel = this._config.get('fimModelName') as string
  private _baseUrl = this._config.get('ollamaBaseUrl') as string
  private _port = this._config.get('ollamaApiPort') as number
  private _temperature = this._config.get('temperature') as number
  private _numPredictFim = this._config.get('numPredictFim') as number
  private _useFileContext = this._config.get('useFileContext') as number
  private _bearerToken = this._config.get('ollamaApiBearerToken') as number
  private _enableCompletionCache = this._config.get(
    'enableCompletionCache'
  ) as boolean
  private _currentReq: ClientRequest | undefined = undefined
  private _isModelAvailable = true

  constructor(statusBar: StatusBarItem) {
    this._statusBar = statusBar
    this.setModelAvailability()
  }

  private setModelAvailability = async () => {
    this._isModelAvailable = await getIsModelAvailable(this._fimModel)
  }

  private buildStreamRequest(prompt: string) {
    const headers: Record<string, string> = {}

    if (this._bearerToken) {
      headers.Authorization = `Bearer ${this._bearerToken}`
    }

    const requestBody: StreamBody = {
      model: this._fimModel,
      prompt,
      options: {
        temperature: this._temperature,
        num_predict: this._numPredictFim || -2
      }
    }

    const requestOptions: RequestOptions = {
      hostname: this._baseUrl,
      port: this._port,
      path: '/api/generate',
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
    position: Position
  ): Promise<InlineCompletionItem[] | InlineCompletionList | null | undefined> {
    this._document = document
    const editor = window.activeTextEditor

    const language = editor?.document.languageId

    if (!this._isModelAvailable) {
      this._statusBar.text = '$(error)'
      this._statusBar.tooltip = `Model ${this._fimModel} not found.`
      return
    }

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

        const { prompt, prefix, suffix } = this.getPrompt(
          document,
          position,
          context,
          language
        )

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
            onData: (stringBuffer: string, destroy) => {

              try {
                const json: OllamStreamResponse = JSON.parse(stringBuffer)
                if (!json.response) {
                  return
                }
                completion = completion + json.response
                chunkCount = chunkCount + 1
                if (
                  (chunkCount > 1 && json.response === '\n') ||
                  json.response.match('<EOT>')
                ) {
                  this._statusBar.text = '🤖'
                  completion = completion.replace('<EOT>', '')
                  destroy()
                  this._currentReq?.destroy()
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

  // TODO: Move to own file to prevent formatting
  private getPrompt(
    document: TextDocument,
    position: Position,
    context: string,
    language: string | undefined
  ) {
    const header = this._useFileContext
      ? this.getFileHeader(language, document.uri)
      : ''
    const { prefix, suffix } = this.getPositionContext(document, position)
    const fileContext = this._useFileContext ? context : ''

    if (this._fimModel.includes('deepseek')) {
      return {
        prompt: `<｜fim▁begin｜> ${fileContext}\n${header}${prefix} <｜fim▁hole｜>${suffix} <｜fim▁end｜>`,
        prefix,
        suffix
      }
    }

    return {
      prompt: `<PRE> ${fileContext}\n${header}${prefix} <SUF>${suffix} <MID>`,
      prefix,
      suffix
    }
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

  private getFormattedCompletion = (
    completion: string,
    editor: TextEditor,
    position: Position
  ) => {
    const cursorPosition = editor.selection.active

    const charBeforeRange = new Range(
      position.translate(
        0,
        position.character === 0 ? 0 : Math.min(position.character, -1)
      ),
      editor.selection.start
    )

    const lineEndPosition = editor.document.lineAt(cursorPosition.line).range
      .end

    const textAfterRange = new Range(cursorPosition, lineEndPosition)
    const textAfterCursor = this._document?.getText(textAfterRange).trim() || ''
    const charBefore = this._document?.getText(charBeforeRange)
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

    if (completion === ' ' && charBefore === ' ') {
      completion = completion.slice(1, completion.length)
    }

    if (completion.includes(textAfterCursor)) {
      completion = completion.replace(textAfterCursor, '').replace('\n', '')
    }

    if (lineText?.includes(completion.trim())) {
      return ''
    }

    return completion.trim()
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
      editor,
      position
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
    this._useFileContext = this._config.get('useFileContext') as number
    this._fimModel = this._config.get('fimModelName') as string
    this._numPredictFim = this._config.get('numPredictFim') as number
    this._enableCompletionCache = this._config.get(
      'enableCompletionCache'
    ) as boolean
  }
}

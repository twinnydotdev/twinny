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
  InlineCompletionContext,
  CompletionTriggerKind
} from 'vscode'
import 'string_score'
import { getFimDataFromProvider } from '../utils'
import { cache } from '../cache'
import { supportedLanguages } from '../languages'
import {
  InlineCompletion,
  StreamRequestOptions,
  StreamResponse
} from '../types'
import { getFimTemplate } from '../fim-templates'
import { LINE_BREAK_REGEX } from '../../constants'
import { streamResponse } from '../stream'
import { createStreamRequestBody } from '../model-options'
import { Logger } from '../logger'
import { CompletionFormatter } from '../completion-formatter'

export class CompletionProvider implements InlineCompletionItemProvider {
  private _nonce = 0
  private _statusBar: StatusBarItem
  private _debouncer: NodeJS.Timeout | undefined
  private _logger: Logger
  private _config = workspace.getConfiguration('twinny')
  private _debounceWait = this._config.get('debounceWait') as number
  private _contextLength = this._config.get('contextLength') as number
  private _fimModel = this._config.get('fimModelName') as string
  private _apiHostname = this._config.get('apiHostname') as string
  private _port = this._config.get('fimApiPort') as number
  private _apiPath = this._config.get('fimApiPath') as string
  private _temperature = this._config.get('temperature') as number
  private _numPredictFim = this._config.get('numPredictFim') as number
  private _apiProvider = this._config.get('apiProvider') as string
  private _fimTemplateFormat = this._config.get('fimTemplateFormat') as string
  private _useFileContext = this._config.get('useFileContext') as boolean
  private _useTls = this._config.get('useTls') as boolean
  private _keepAlive = this._config.get('keepAlive') as string | number
  private _useMultiLineCompletions = this._config.get(
    'useMultiLineCompletions'
  ) as boolean
  private maxLines = this._config.get('maxLines') as number
  private _disableAutoSuggest = this._config.get(
    'disableAutoSuggest'
  ) as boolean
  private _apiBearerToken = this._config.get('apiBearerToken') as string
  private _enableCompletionCache = this._config.get(
    'enableCompletionCache'
  ) as boolean
  private _controller: AbortController | null

  constructor(statusBar: StatusBarItem) {
    this._statusBar = statusBar
    this._logger = new Logger()
    this._controller = null
  }

  private buildStreamRequest(prompt: string) {
    const requestBody = createStreamRequestBody(this._apiProvider, prompt, {
      model: this._fimModel,
      numPredictChat: this._numPredictFim,
      temperature: this._temperature,
      keepAlive: this._keepAlive
    })

    const requestOptions: StreamRequestOptions = {
      hostname: this._apiHostname,
      port: this._port,
      path: this._apiPath,
      protocol: this._useTls ? 'https' : 'http',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._apiBearerToken}`
      }
    }

    return { requestOptions, requestBody }
  }

  public destroyStream = () => {
    this._controller?.abort()
    this._statusBar.text = '🤖'
  }

  public handleEndStream = ({
    completion,
    position,
    prefix,
    suffix,
    stop
  }: InlineCompletion) => {
    return this.triggerInlineCompletion({
      completion,
      position,
      prefix,
      suffix,
      stop
    })
  }

  public async provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    context: InlineCompletionContext
  ): Promise<InlineCompletionItem[] | InlineCompletionList | null | undefined> {
    const editor = window.activeTextEditor

    if (
      context.triggerKind ===
        CompletionTriggerKind.TriggerCharacter.valueOf() &&
      this._disableAutoSuggest
    ) {
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
        if (!this._config.get('enabled')) {
          this._logger.log('Streaming response end as completions disabled')
          return resolve([])
        }

        this._nonce = this._nonce + 1
        let completion = ''

        const context = this.getFileContext(document.uri)

        const { prefix, suffix } = this.getCursorPositionContext(
          document,
          position
        )

        const { prompt, stop } = getFimTemplate(
          this._fimModel,
          this._fimTemplateFormat,
          {
            context,
            prefix,
            suffix,
            header: this.getFileHeader(language, document.uri),
            useFileContext: this._useFileContext
          }
        )

        const cachedCompletion = cache.getCache({ prefix, suffix })

        if (cachedCompletion && this._enableCompletionCache) {
          completion = cachedCompletion
          this._logger.log(
            `Streaming response end using cache ${this._nonce} \nCompletion: ${completion}`
          )
          this._statusBar.text = '🤖'
          return resolve(
            this.handleEndStream({
              position,
              prefix,
              suffix,
              stop,
              completion
            })
          )
        }

        if (!prompt) {
          this._logger.log('Streaming response end prompt not found')
          this._statusBar.text = '🤖'
          return resolve([])
        }

        try {
          let completion = ''
          let chunkCount = 0
          let lines = 0
          this._statusBar.text = '$(loading~spin)'
          this._statusBar.command = 'twinny.stopGeneration'

          const { requestBody, requestOptions } =
            this.buildStreamRequest(prompt)

          streamResponse({
            body: requestBody,
            options: requestOptions,
            onStart: (controller: AbortController) => {
              this._controller = controller
            },
            onEnd: () => {
              this._logger.log(
                `Streaming response end due to request end ${this._nonce} \nCompletion: ${completion}`
              )
              this._statusBar.text = '🤖'
              stop.forEach((stopWord) => {
                completion = completion.split(stopWord).join('')
              })
              this._controller?.abort()
              resolve(
                this.handleEndStream({
                  position,
                  prefix,
                  suffix,
                  stop,
                  completion
                })
              )
            },
            onData: (streamResponse: StreamResponse | undefined) => {
              try {
                const completionString = getFimDataFromProvider(
                  this._apiProvider,
                  streamResponse
                )

                if (completionString === undefined) {
                  return
                }

                completion = completion + completionString
                chunkCount = chunkCount + 1

                if (
                  !this._useMultiLineCompletions &&
                  chunkCount > 1 &&
                  LINE_BREAK_REGEX.exec(completionString)
                ) {
                  this._logger.log(
                    `Streaming response end due to line break ${this._nonce} \nCompletion: ${completion}`
                  )
                  this._statusBar.text = '🤖'
                  stop.forEach((stopWord) => {
                    completion = completion.split(stopWord).join('')
                  })
                  this._controller?.abort()
                  return resolve(
                    this.handleEndStream({
                      position,
                      prefix,
                      suffix,
                      stop,
                      completion
                    })
                  )
                }

                if (LINE_BREAK_REGEX.exec(completionString)) {
                  lines++
                }

                if (
                  lines > this.maxLines ||
                  stop.some((stopSequence) =>
                    completion?.includes(stopSequence)
                  )
                ) {
                  this._logger.log(
                    `Streaming response end due to max lines or EOT ${this._nonce} \nCompletion: ${completion}`
                  )
                  this._statusBar.text = '🤖'
                  stop.forEach((stopWord) => {
                    completion = completion.split(stopWord).join('')
                  })
                  this._controller?.abort()
                  return resolve(
                    this.handleEndStream({
                      position,
                      prefix,
                      suffix,
                      stop,
                      completion
                    })
                  )
                }
              } catch (e) {
                console.error(e)
              }
            },
            onError: (error: Error) => {
              this._statusBar.text = '🤖'
              console.error(error)
              this._controller?.abort()
              resolve([])
            }
          })
        } catch (error) {
          this._statusBar.text = '$(alert)'
          this._controller?.abort()
          return resolve([] as InlineCompletionItem[])
        }
      }, this._debounceWait)
    })
  }

  private getFileHeader(languageId: string | undefined, uri: Uri) {
    const lang =
      supportedLanguages[languageId as keyof typeof supportedLanguages]

    if (!lang) {
      return ''
    }

    const language = `${lang.syntaxComments?.start || ''} Language: ${
      lang?.langName
    } (${languageId}) ${lang.syntaxComments?.end || ''}`

    const path = `${
      lang.syntaxComments?.start || ''
    } File uri: ${uri.toString()} (${languageId}) ${
      lang.syntaxComments?.end || ''
    }`

    return `\n${language}\n${path}\n`
  }

  private calculateFilePathSimilarity(path1: string, path2: string): number {
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

      const filePathSimilarity = this.calculateFilePathSimilarity(
        currentFileName.toString(),
        document.uri.toString()
      )

      if (filePathSimilarity > 1) {
        codeSnippets.push(text)
      }
    }

    return codeSnippets.join('\n')
  }

  getCursorPositionContext(
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

  private triggerInlineCompletion(
    inlineCompletion: InlineCompletion
  ): InlineCompletionItem[] {
    const { position, prefix, suffix } = inlineCompletion

    const editor = window.activeTextEditor

    if (!editor) {
      return []
    }

    const completion = new CompletionFormatter(editor).format(
      inlineCompletion.completion
    )

    if (this._enableCompletionCache) {
      cache.setCache({ prefix, suffix, completion })
    }

    this._logger.log(
      `\n Inline completion triggered: Formatted completion: ${JSON.stringify(
        completion
      )}\n`
    )

    return [new InlineCompletionItem(completion, new Range(position, position))]
  }

  public updateConfig() {
    this._logger.updateConfig()
    this._config = workspace.getConfiguration('twinny')
    this._debounceWait = this._config.get('debounceWait') as number
    this._contextLength = this._config.get('contextLength') as number
    this._temperature = this._config.get('temperature') as number
    this._useFileContext = this._config.get('useFileContext') as boolean
    this._disableAutoSuggest = this._config.get('disableAutoSuggest') as boolean
    this._fimModel = this._config.get('fimModelName') as string
    this._fimTemplateFormat = this._config.get('fimTemplateFormat') as string
    this._numPredictFim = this._config.get('numPredictFim') as number
    this._apiPath = this._config.get('fimApiPath') as string
    this._port = this._config.get('fimApiPort') as number
    this._apiBearerToken = this._config.get('apiBearerToken') as string
    this._apiHostname = this._config.get('apiHostname') as string
    this._apiProvider = this._config.get('apiProvider') as string
    this._useTls = this._config.get('useTls') as boolean
    this._keepAlive = this._config.get('keepAlive') as string | number
    this._useMultiLineCompletions = this._config.get(
      'useMultiLineCompletions'
    ) as boolean
    this.maxLines = this._config.get('maxLines') as number
    this._enableCompletionCache = this._config.get(
      'enableCompletionCache'
    ) as boolean
  }
}

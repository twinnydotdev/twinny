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
  InlineCompletionTriggerKind,
  ExtensionContext
} from 'vscode'
import AsyncLock from 'async-lock'
import 'string_score'
import {
  getFimDataFromProvider,
  getPrefixSuffix,
  getShouldSkipCompletion,
  getIsMiddleWord,
  getIsMultiLineCompletion
} from '../utils'
import { cache } from '../cache'
import { supportedLanguages } from '../../common/languages'
import {
  FimTemplateData,
  PrefixSuffix,
  ResolvedInlineCompletion,
  StreamRequestOptions,
  StreamResponse
} from '../../common/types'
import { getFimPrompt, getStopWords } from '../fim-templates'
import {
  FIM_TEMPLATE_FORMAT,
  LINE_BREAK_REGEX,
  MAX_CONTEXT_LINE_COUNT
} from '../../common/constants'
import { streamResponse } from '../stream'
import { createStreamRequestBodyFim } from '../provider-options'
import { Logger } from '../../common/logger'
import { CompletionFormatter } from '../completion-formatter'
import { FileInteractionCache } from '../file-interaction'
import { getLineBreakCount } from '../../webview/utils'
import { TemplateProvider } from '../template-provider'
import { ACTIVE_FIM_PROVIDER_KEY, TwinnyProvider } from '../provider-manager'

export class CompletionProvider implements InlineCompletionItemProvider {
  private _config = workspace.getConfiguration('twinny')
  private _abortController: AbortController | null
  private _acceptedLastCompletion = false
  private _cacheEnabled = this._config.get('enableCompletionCache') as boolean
  private _chunkCount = 0
  private _completion = ''
  private _debouncer: NodeJS.Timeout | undefined
  private _debounceWait = this._config.get('debounceWait') as number
  private _disableAuto = this._config.get('disableAutoSuggest') as boolean
  private _document: TextDocument | null
  private _enabled = this._config.get('enabled')
  private _enableSubsequent = this._config.get('enableSubsequent') as boolean
  private _extensionContext: ExtensionContext
  private _fileInteractionCache: FileInteractionCache
  private _keepAlive = this._config.get('keepAlive') as string | number
  private _lastCompletionMultiline = false
  private _lastCompletionText = ''
  private _lock: AsyncLock
  private _logger: Logger
  private _maxLines = this._config.get('maxLines') as number
  private _nonce = 0
  private _numLineContext = this._config.get('contextLength') as number
  private _numPredictFim = this._config.get('numPredictFim') as number
  private _position: Position | null
  private _statusBar: StatusBarItem
  private _temperature = this._config.get('temperature') as number
  private _templateProvider: TemplateProvider
  private _useFileContext = this._config.get('useFileContext') as boolean
  private _useMultiLine = this._config.get('useMultiLineCompletions') as boolean
  private _usingFimTemplate = false

  constructor(
    statusBar: StatusBarItem,
    fileInteractionCache: FileInteractionCache,
    templateProvider: TemplateProvider,
    extentionContext: ExtensionContext
  ) {
    this._abortController = null
    this._document = null
    this._lock = new AsyncLock()
    this._logger = new Logger()
    this._position = null
    this._statusBar = statusBar
    this._fileInteractionCache = fileInteractionCache
    this._templateProvider = templateProvider
    this._extensionContext = extentionContext
  }

  public async provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    context: InlineCompletionContext
  ): Promise<InlineCompletionItem[] | InlineCompletionList | null | undefined> {
    const editor = window.activeTextEditor

    const isLastCompletionAccepted =
      this._acceptedLastCompletion && !this._enableSubsequent

    const prefixSuffix = getPrefixSuffix(
      this._numLineContext,
      document,
      position
    )

    if (
      context.triggerKind === InlineCompletionTriggerKind.Invoke &&
      !this._disableAuto
    ) {
      this._completion = this._lastCompletionText
      return this.triggerInlineCompletion(prefixSuffix)
    }

    if (
      !this._enabled ||
      !editor ||
      isLastCompletionAccepted ||
      this._lastCompletionMultiline ||
      getShouldSkipCompletion(context, this._disableAuto) ||
      getIsMiddleWord()
    ) {
      this._statusBar.text = '🤖'
      return
    }

    this._document = document
    this._position = position
    this._chunkCount = 0
    this._nonce = this._nonce + 1
    this._statusBar.text = '$(loading~spin)'
    this._statusBar.command = 'twinny.stopGeneration'
    const prompt = await this.getPrompt(prefixSuffix)
    const cachedCompletion = cache.getCache(prefixSuffix)

    if (cachedCompletion && this._cacheEnabled) {
      this._completion = cachedCompletion
      return this.triggerInlineCompletion(prefixSuffix)
    }

    if (this._debouncer) clearTimeout(this._debouncer)

    return new Promise<ResolvedInlineCompletion>((resolve, reject) => {
      this._debouncer = setTimeout(() => {
        this._lock.acquire('twinny.completion', () => {
          const request = this.buildStreamRequest(prompt)
          if (!request || !prompt) return
          const { requestBody, requestOptions } = request

          try {
            streamResponse({
              body: requestBody,
              options: requestOptions,
              onStart: (controller) => this.onStart(controller),
              onEnd: () => this.onEnd(prefixSuffix, resolve),
              onData: (data) => {
                if (this.onData(data)) {
                  this._abortController?.abort()
                }
              },
              onError: this.onError
            })
          } catch (error) {
            this.onError()
            reject([])
          }
        })
      }, this._debounceWait)
    })
  }

  public getLastCompletion = () => this._lastCompletionText

  public setAcceptedLastCompletion(value: boolean) {
    this._acceptedLastCompletion = value
    this._lastCompletionMultiline = value
  }

  public abortCompletion() {
    this._abortController?.abort()
    this._statusBar.text = '🤖'
  }

  private buildStreamRequest(prompt: string) {
    const provider = this.getFimProvider()
    if (!provider) return

    const requestBody = createStreamRequestBodyFim(provider.provider, prompt, {
      model: provider.modelName,
      numPredictFim: this._numPredictFim,
      temperature: this._temperature,
      keepAlive: this._keepAlive
    })

    const requestOptions: StreamRequestOptions = {
      hostname: provider.apiHostname,
      port: Number(provider.apiPort),
      path: provider.apiPath,
      protocol: provider.apiProtocol,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`
      }
    }

    return { requestOptions, requestBody }
  }

  private onData(data: StreamResponse | undefined): string {
    const provider = this.getFimProvider()
    if (!provider) return ''
    try {
      const completionData = getFimDataFromProvider(provider.provider, data)
      if (completionData === undefined) return ''

      this._completion = this._completion + completionData
      this._chunkCount = this._chunkCount + 1

      if (
        !this._useMultiLine &&
        this._chunkCount >= 2 &&
        LINE_BREAK_REGEX.test(this._completion.trimStart())
      ) {
        this._logger.log(
          `Streaming response end due to line break ${this._nonce} \nCompletion: ${this._completion}`
        )
        return this._completion
      }

      if (
        !getIsMultiLineCompletion() &&
        this._useMultiLine &&
        this._chunkCount >= 2 &&
        LINE_BREAK_REGEX.test(this._completion.trimStart())
      ) {
        this._logger.log(
          `Streaming response end due to line break ${this._nonce} \nCompletion: ${this._completion}`
        )
        return this._completion
      }

      const lineBreakCount = getLineBreakCount(this._completion)

      if (lineBreakCount >= this._maxLines) {
        this._logger.log(
          `Streaming response end due to max lines ${this._nonce} \nCompletion: ${this._completion}`
        )
        return this._completion
      }

      return ''
    } catch (e) {
      console.error(e)
      return ''
    }
  }

  private onStart(controller: AbortController) {
    this._abortController = controller
  }

  private onEnd(
    prefixSuffix: PrefixSuffix,
    done: (completion: ResolvedInlineCompletion) => void
  ) {
    return done(this.triggerInlineCompletion(prefixSuffix))
  }

  public onError = () => {
    this._abortController?.abort()
    this._statusBar.text = '🤖'
  }

  private getPromptHeader(languageId: string | undefined, uri: Uri) {
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

  private async getFileInteractionContext() {
    const interactions = this._fileInteractionCache.getAll()
    const currentFileName = this._document?.fileName || ''

    const fileChunks: string[] = []
    for (const interaction of interactions) {
      const filePath = interaction.name

      if (filePath.toString().match('.git')) {
        continue
      }

      const uri = Uri.file(filePath)

      if (currentFileName === filePath) continue

      const activeLines = interaction.activeLines

      const document = await workspace.openTextDocument(uri)
      const lineCount = document.lineCount

      if (lineCount > MAX_CONTEXT_LINE_COUNT) {
        const averageLine =
          activeLines.reduce((acc, curr) => acc + curr.line, 0) /
          activeLines.length
        const start = new Position(
          Math.max(0, Math.ceil(averageLine || 0) - 100),
          0
        )
        const end = new Position(
          Math.min(lineCount, Math.ceil(averageLine || 0) + 100),
          0
        )
        fileChunks.push(`
// File: ${filePath}
// Content: \n ${document.getText(new Range(start, end))}
        `)
      } else {
        fileChunks.push(`
// File: ${filePath}
// Content: \n ${document.getText()}
        `)
      }
    }

    return fileChunks.join('\n')
  }

  private getFimProvider = () => {
    const provider = this._extensionContext.globalState.get<TwinnyProvider>(
      ACTIVE_FIM_PROVIDER_KEY
    )
    return provider
  }

  private removeStopWords(completion: string) {
    const provider = this.getFimProvider()
    if (!provider) return completion
    const template = provider.fimTemplate || FIM_TEMPLATE_FORMAT.automatic
    let filteredCompletion = completion
    const stopWords = getStopWords(provider.modelName, template)
    stopWords.forEach((stopWord) => {
      filteredCompletion = filteredCompletion.split(stopWord).join('')
    })
    return filteredCompletion
  }

  private async getPrompt(prefixSuffix: PrefixSuffix) {
    const provider = this.getFimProvider()
    if (!provider) return ''
    if (!this._document || !this._position || !provider) return ''

    const language = this._document.languageId
    const interactionContext = await this.getFileInteractionContext()

    if (provider.fimTemplate === FIM_TEMPLATE_FORMAT.custom) {
      const systemMessage =
        await this._templateProvider.readSystemMessageTemplate('fim-system.hbs')

      const fimTemplate =
        await this._templateProvider.renderTemplate<FimTemplateData>('fim', {
          prefix: prefixSuffix.prefix,
          suffix: prefixSuffix.suffix,
          systemMessage,
          context: interactionContext,
          fileName: this._document.uri.fsPath
        })

      if (fimTemplate) {
        this._usingFimTemplate = true
        return fimTemplate
      }
    }

    const template = provider.fimTemplate || FIM_TEMPLATE_FORMAT.automatic

    const prompt = getFimPrompt(provider.modelName, template, {
      context: interactionContext || '',
      prefixSuffix,
      header: this.getPromptHeader(language, this._document.uri),
      useFileContext: this._useFileContext,
      language: language
    })

    return prompt
  }

  private logCompletion(formattedCompletion: string) {
    this._logger.log(`
*** Twinny completion triggered for file: ${this._document?.uri} ***
Original completion: ${this._completion}
Formatted completion: ${formattedCompletion}
Max Lines: ${this._maxLines}
Use file context: ${this._useFileContext}
Completed lines count ${getLineBreakCount(formattedCompletion)}
Using custom FIM template fim.bhs?: ${this._usingFimTemplate}
    `)
  }

  private triggerInlineCompletion(
    prefixSuffix: PrefixSuffix
  ): InlineCompletionItem[] {
    const editor = window.activeTextEditor

    if (!editor || !this._position) return []

    const formattedCompletion = new CompletionFormatter(editor).format(
      this.removeStopWords(this._completion)
    )

    this.logCompletion(formattedCompletion)

    if (this._cacheEnabled) cache.setCache(prefixSuffix, formattedCompletion)

    this._completion = ''
    this._statusBar.text = '🤖'
    this._lastCompletionText = formattedCompletion
    this._lastCompletionMultiline = getLineBreakCount(this._completion) > 1

    return [
      new InlineCompletionItem(
        formattedCompletion,
        new Range(this._position, this._position)
      )
    ]
  }

  public updateConfig() {
    this._cacheEnabled = this._config.get('enableCompletionCache') as boolean
    this._config = workspace.getConfiguration('twinny')
    this._debounceWait = this._config.get('debounceWait') as number
    this._disableAuto = this._config.get('disableAutoSuggest') as boolean
    this._enableSubsequent = this._config.get('enableSubsequent') as boolean
    this._keepAlive = this._config.get('keepAlive') as string | number
    this._maxLines = this._config.get('maxLines') as number
    this._numLineContext = this._config.get('contextLength') as number
    this._numPredictFim = this._config.get('numPredictFim') as number
    this._temperature = this._config.get('temperature') as number
    this._useFileContext = this._config.get('useFileContext') as boolean
    this._useMultiLine = this._config.get('useMultiLineCompletions') as boolean
    this._logger.updateConfig()
  }
}

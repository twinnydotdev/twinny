import {
  StatusBarItem,
  WebviewView,
  commands,
  window,
  workspace,
  ExtensionContext
} from 'vscode'
import * as path from 'path'
import * as fs from 'fs/promises'

import {
  EXTENSION_CONTEXT_NAME,
  EVENT_NAME,
  WEBUI_TABS,
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  SYSTEM,
  USER,
  RELEVANT_FILE_COUNT,
  RELEVANT_CODE_COUNT,
  SYMMETRY_EMITTER_KEY,
  DEFAULT_RERANK_THRESHOLD
} from '../common/constants'
import {
  StreamResponse,
  RequestBodyBase,
  ServerMessage,
  TemplateData,
  Message,
  StreamRequestOptions,
  EmbeddedDocument
} from '../common/types'
import { getChatDataFromProvider, getLanguage } from './utils'
import { CodeLanguageDetails } from '../common/languages'
import { TemplateProvider } from './template-provider'
import { streamResponse } from './stream'
import { createStreamRequestBody } from './provider-options'
import { kebabToSentence } from '../webview/utils'
import { TwinnyProvider } from './provider-manager'
import { EmbeddingDatabase } from './embeddings'
import { Reranker } from './reranker'
import { SymmetryService } from './symmetry-service'
import { Logger } from '../common/logger'

const logger = new Logger()

export class ChatService {
  private _completion = ''
  private _config = workspace.getConfiguration('twinny')
  private _context?: ExtensionContext
  private _controller?: AbortController
  private _db?: EmbeddingDatabase
  private _documents: EmbeddedDocument[] = []
  private _keepAlive = this._config.get('keepAlive') as string | number
  private _numPredictChat = this._config.get('numPredictChat') as number
  private _promptTemplate = ''
  private _reranker: Reranker
  private _statusBar: StatusBarItem
  private _symmetryService?: SymmetryService
  private _temperature = this._config.get('temperature') as number
  private _templateProvider?: TemplateProvider
  private _view?: WebviewView
  private readonly MAX_FILE_SIZE = 1000000
  private readonly READ_THRESHOLD = 0.27

  constructor(
    statusBar: StatusBarItem,
    templateDir: string,
    extensionContext: ExtensionContext,
    view: WebviewView,
    db: EmbeddingDatabase | undefined,
    symmetryService: SymmetryService
  ) {
    this._view = view
    this._statusBar = statusBar
    this._templateProvider = new TemplateProvider(templateDir)
    this._reranker = new Reranker()
    this._context = extensionContext
    this._db = db
    this._symmetryService = symmetryService
    workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('twinny')) {
        return
      }
      this.updateConfig()
    })

    this.setupSymmetryListeners()
  }

  private setupSymmetryListeners() {
    this._symmetryService?.on(
      SYMMETRY_EMITTER_KEY.inference,
      (completion: string) => {
        this._view?.webview.postMessage({
          type: EVENT_NAME.twinnyOnCompletion,
          value: {
            completion: completion.trimStart(),
            data: getLanguage()
          }
        } as ServerMessage)
      }
    )
  }

  private async getRelevantFiles(text: string | undefined): Promise<string[]> {
    if (!this._db || !text || !workspace.name) return []

    const table = `${workspace.name}-file-paths`
    if (await this._db.hasEmbeddingTable(table)) {
      const embedding = await this._db.fetchModelEmbedding(text)

      if (!embedding) return []

      const filePaths =
        (await this._db.getDocuments(embedding, RELEVANT_FILE_COUNT, table)) ||
        []

      if (!filePaths.length) return []

      return this.rerankFiles(
        text,
        filePaths.map((f) => f.content)
      )
    }

    return []
  }

  private getRerankThreshold() {
    const rerankThresholdContext = `${EVENT_NAME.twinnyGlobalContext}-${EXTENSION_CONTEXT_NAME.twinnyRerankThreshold}`
    const stored = this._context?.globalState.get(
      rerankThresholdContext
    ) as number
    const rerankThreshold = stored || DEFAULT_RERANK_THRESHOLD

    return rerankThreshold
  }

  private async rerankFiles(
    text: string | undefined,
    filePaths: string[] | undefined
  ) {
    if (!this._db || !text || !workspace.name || !filePaths?.length) return []

    const rerankThreshold = this.getRerankThreshold()

    logger.log(
      `
      Reranking threshold: ${rerankThreshold}
    `.trim()
    )

    const fileNames = filePaths?.map((filePath) => path.basename(filePath))

    const scores = await this._reranker.rerank(text, fileNames)

    if (!scores) return []

    const relevantFilePaths = filePaths
      ?.map((filePath, index) =>
        scores[index] > rerankThreshold ? filePath : ''
      )
      .filter((_, index) => scores[index] > this.READ_THRESHOLD)

    return relevantFilePaths
  }

  private async readFileContent(
    filePath: string | undefined
  ): Promise<string | null> {
    try {
      if (!filePath) return ''

      const stats = await fs.stat(filePath)

      if (stats.size > this.MAX_FILE_SIZE) {
        console.warn(`File ${filePath} exceeds max size. Skipping direct read.`)
        return null
      }

      return await fs.readFile(filePath, 'utf-8')
    } catch (error) {
      console.error(`Error reading file ${filePath}:`, error)
      return null
    }
  }

  private async getRelevantCode(
    text: string | undefined,
    filePaths: string[] | undefined
  ): Promise<string> {
    if (!this._db || !text || !workspace.name) return ''

    const table = `${workspace.name}-documents`
    const rerankThreshold = this.getRerankThreshold()

    if (await this._db.hasEmbeddingTable(table)) {
      const embedding = await this._db.fetchModelEmbedding(text)

      if (!embedding) return ''

      const query = filePaths?.length
        ? `file IN ("${filePaths.join('","')}")`
        : ''

      const documents =
        (await this._db.getDocuments(
          embedding,
          RELEVANT_CODE_COUNT,
          table,
          query
        )) || []

      const scores = await this._reranker.rerank(
        text,
        documents.map((item) => (item.file ? item.file.trim() : ''))
      )

      if (!scores) return ''

      for (let i = 0; i < documents.length; i++) {
        if (scores[i] > this.READ_THRESHOLD) {
          try {
            const fileContent = await this.readFileContent(documents[i].file)
            if (fileContent) return fileContent
          } catch (error) {
            console.error(`Error reading file ${documents[i].file}:`, error)
          }
        }
      }

      const codeChunks = documents
        .filter((_, index) => scores[index] > rerankThreshold)
        .map(({ content }) => content)
        .join('\n\n')
        .trim()

      return codeChunks
    }

    return ''
  }

  private getProvider = () => {
    const provider = this._context?.globalState.get<TwinnyProvider>(
      ACTIVE_CHAT_PROVIDER_STORAGE_KEY
    )
    return provider
  }

  private buildStreamRequest(messages?: Message[] | Message[]) {
    const provider = this.getProvider()

    if (!provider) return

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

    const requestBody = createStreamRequestBody(provider.provider, {
      model: provider.modelName,
      numPredictChat: this._numPredictChat,
      temperature: this._temperature,
      messages,
      keepAlive: this._keepAlive
    })

    return { requestOptions, requestBody }
  }

  private onStreamData = (
    streamResponse: StreamResponse,
    onEnd?: (completion: string) => void
  ) => {
    const provider = this.getProvider()
    if (!provider) return

    try {
      const data = getChatDataFromProvider(provider.provider, streamResponse)
      this._completion = this._completion + data
      if (onEnd) return
      this._view?.webview.postMessage({
        type: EVENT_NAME.twinnyOnCompletion,
        value: {
          completion: this._completion.trimStart(),
          data: getLanguage(),
          type: this._promptTemplate
        }
      } as ServerMessage)
    } catch (error) {
      console.error('Error parsing JSON:', error)
      return
    }
  }

  private onStreamEnd = (onEnd?: (completion: string) => void) => {
    this._statusBar.text = '🤖'
    commands.executeCommand(
      'setContext',
      EXTENSION_CONTEXT_NAME.twinnyGeneratingText,
      false
    )
    if (onEnd) {
      onEnd(this._completion)
      this._view?.webview.postMessage({
        type: EVENT_NAME.twinnyOnEnd
      } as ServerMessage)
      return
    }
    this._view?.webview.postMessage({
      type: EVENT_NAME.twinnyOnEnd,
      value: {
        completion: this._completion.trimStart(),
        data: getLanguage(),
        type: this._promptTemplate
      }
    } as ServerMessage)
  }

  private onStreamError = (error: Error) => {
    this._view?.webview.postMessage({
      type: EVENT_NAME.twinnyOnEnd,
      value: {
        error: true,
        errorMessage: error.message
      }
    } as ServerMessage)
  }

  private onStreamStart = (controller: AbortController) => {
    this._controller = controller
    commands.executeCommand(
      'setContext',
      EXTENSION_CONTEXT_NAME.twinnyGeneratingText,
      true
    )
    this._view?.webview.onDidReceiveMessage((data: { type: string }) => {
      if (data.type === EVENT_NAME.twinnyStopGeneration) {
        this._controller?.abort()
      }
    })
  }

  public destroyStream = () => {
    this._controller?.abort()
    this._statusBar.text = '🤖'
    commands.executeCommand(
      'setContext',
      EXTENSION_CONTEXT_NAME.twinnyGeneratingText,
      true
    )
    this._view?.webview.postMessage({
      type: EVENT_NAME.twinnyOnEnd,
      value: {
        completion: this._completion.trimStart(),
        data: getLanguage(),
        type: this._promptTemplate
      }
    } as ServerMessage)
  }

  private buildTemplatePrompt = async (
    template: string,
    language: CodeLanguageDetails,
    context?: string
  ) => {
    const editor = window.activeTextEditor
    const selection = editor?.selection
    const selectionContext =
      editor?.document.getText(selection) || context || ''

    const prompt = await this._templateProvider?.readTemplate<TemplateData>(
      template,
      {
        code: selectionContext || '',
        language: language?.langName || 'unknown'
      }
    )
    return { prompt: prompt || '', selection: selectionContext }
  }

  private streamResponse({
    requestBody,
    requestOptions,
    onEnd
  }: {
    requestBody: RequestBodyBase
    requestOptions: StreamRequestOptions
    onEnd?: (completion: string) => void
  }) {
    return streamResponse({
      body: requestBody,
      options: requestOptions,
      onData: (streamResponse) =>
        this.onStreamData(streamResponse as StreamResponse, onEnd),
      onEnd: () => this.onStreamEnd(onEnd),
      onStart: this.onStreamStart,
      onError: this.onStreamError
    })
  }

  private sendEditorLanguage = () => {
    this._view?.webview.postMessage({
      type: EVENT_NAME.twinnySendLanguage,
      value: {
        data: getLanguage()
      }
    } as ServerMessage)
  }

  private focusChatTab = () => {
    this._view?.webview.postMessage({
      type: EVENT_NAME.twinnySetTab,
      value: {
        data: WEBUI_TABS.chat
      }
    } as ServerMessage<string>)
  }

  public async addRagContextIfEnabled(text?: string): Promise<string | null> {
    const ragContextKey = `${EVENT_NAME.twinnyWorkspaceContext}-${EXTENSION_CONTEXT_NAME.twinnyEnableRag}`
    const isRagEnabled = this._context?.workspaceState.get(ragContextKey)

    if (!isRagEnabled) return null

    const relevantFiles = await this.getRelevantFiles(text)
    const relevantCode = await this.getRelevantCode(text, relevantFiles)

    let combinedContext = ''

    if (relevantFiles?.length) {
      const filesTemplate =
        await this._templateProvider?.readTemplate<TemplateData>(
          'relevant-files',
          { code: relevantFiles.join(', ') }
        )
      combinedContext += filesTemplate + '\n\n'
    }

    if (relevantCode) {
      const codeTemplate =
        await this._templateProvider?.readTemplate<TemplateData>(
          'relevant-code',
          { code: relevantCode }
        )
      combinedContext += codeTemplate
    }

    return combinedContext.trim() || null
  }

  public async streamChatCompletion(messages: Message[]) {
    this._completion = ''
    this.sendEditorLanguage()
    const editor = window.activeTextEditor
    const selection = editor?.selection
    const userSelection = editor?.document.getText(selection)
    const lastMessage = messages[messages.length - 1]
    const text = lastMessage.content

    const systemMessage = {
      role: SYSTEM,
      content: await this._templateProvider?.readSystemMessageTemplate(
        this._promptTemplate
      )
    }

    let additionalContext = ''

    if (userSelection) {
      additionalContext += `Selected Code:\n${userSelection}\n\n`
    }

    const ragContext = await this.addRagContextIfEnabled(text)
    if (ragContext) {
      additionalContext += `Additional Context:\n${ragContext}\n\n`
    }

    const updatedMessages = [systemMessage, ...messages.slice(0, -1)]

    if (additionalContext) {
      const lastMessageContent = `${text}\n\n${additionalContext.trim()}`
      updatedMessages.push({
        role: USER,
        content: lastMessageContent
      })
    } else {
      updatedMessages.push(lastMessage)
    }

    const request = this.buildStreamRequest(updatedMessages)
    if (!request) return
    const { requestBody, requestOptions } = request
    return this.streamResponse({ requestBody, requestOptions })
  }

  public async getTemplateMessages(
    template: string,
    context?: string,
    skipMessage?: boolean
  ): Promise<Message[]> {
    this._statusBar.text = '$(loading~spin)'
    const { language } = getLanguage()
    this._completion = ''
    this._promptTemplate = template
    this.sendEditorLanguage()

    const { prompt, selection } = await this.buildTemplatePrompt(
      template,
      language,
      context
    )

    if (!skipMessage) {
      this.focusChatTab()
      this._view?.webview.postMessage({
        type: EVENT_NAME.twinnyOnLoading
      })
      this._view?.webview.postMessage({
        type: EVENT_NAME.twinngAddMessage,
        value: {
          completion: kebabToSentence(template) + '\n\n' + '```\n' + selection,
          data: getLanguage()
        }
      } as ServerMessage)
    }

    const systemMessage = {
      role: SYSTEM,
      content: await this._templateProvider?.readSystemMessageTemplate(
        this._promptTemplate
      )
    }

    let ragContext = undefined

    if (['explain'].includes(template)) {
      ragContext = await this.addRagContextIfEnabled(selection)
    }

    const userContent = ragContext
      ? `${prompt}\n\nAdditional Context:\n${ragContext}`
      : prompt

    const conversation: Message[] = [
      systemMessage,
      {
        role: USER,
        content: userContent
      }
    ]

    return conversation
  }

  public async streamTemplateCompletion(
    promptTemplate: string,
    context?: string,
    onEnd?: (completion: string) => void,
    skipMessage?: boolean
  ) {
    const messages = await this.getTemplateMessages(
      promptTemplate,
      context,
      skipMessage
    )
    const request = this.buildStreamRequest(messages)

    if (!request) return
    const { requestBody, requestOptions } = request
    return this.streamResponse({ requestBody, requestOptions, onEnd })
  }

  private updateConfig() {
    this._config = workspace.getConfiguration('twinny')
    this._temperature = this._config.get('temperature') as number
    this._keepAlive = this._config.get('keepAlive') as string | number
  }
}

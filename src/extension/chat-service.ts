import {
  StatusBarItem,
  WebviewView,
  commands,
  window,
  workspace,
  ExtensionContext
} from 'vscode'
import * as path from 'path'

import {
  EXTENSION_CONTEXT_NAME,
  EVENT_NAME,
  WEBUI_TABS,
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  SYSTEM,
  USER,
  MINIMUM_RERANK_SCORE,
  MINIMUM_FILE_PATH_SCORE
} from '../common/constants'
import {
  StreamResponse,
  StreamBodyBase,
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

export class ChatService {
  private _config = workspace.getConfiguration('twinny')
  private _completion = ''
  private _controller?: AbortController
  private _extensionContext?: ExtensionContext
  private _keepAlive = this._config.get('keepAlive') as string | number
  private _numPredictChat = this._config.get('numPredictChat') as number
  private _promptTemplate = ''
  private _statusBar: StatusBarItem
  private _temperature = this._config.get('temperature') as number
  private _templateProvider?: TemplateProvider
  private _view?: WebviewView
  private _db?: EmbeddingDatabase
  private _reranker: Reranker
  private _documents: EmbeddedDocument[] = []

  constructor(
    statusBar: StatusBarItem,
    templateDir: string,
    extensionContext: ExtensionContext,
    view: WebviewView,
    db: EmbeddingDatabase | undefined
  ) {
    this._view = view
    this._statusBar = statusBar
    this._templateProvider = new TemplateProvider(templateDir)
    this._reranker = new Reranker(extensionContext)
    this._extensionContext = extensionContext
    this._db = db
    workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('twinny')) {
        return
      }
      this.updateConfig()
    })
  }

  private async getRelevantFilePaths(text: string | undefined) {
    if (!this._db || !text || !workspace.name) return
    const table = `${workspace.name}-file-paths`
    if (await this._db.hasEmbeddingTable(table)) {
      const embedding = await this._db.fetchModelEmbedding(text)

      if (!embedding) return

      const filePaths =
        (await this._db.getDocuments(
          embedding,
          5,
          `${workspace.name}-file-paths`
        )) || []

      if (!filePaths.length) {
        return
      }

      return filePaths
    }
    return []
  }

  private async rerankFilePaths(
    text: string | undefined,
    filePaths: string[] | undefined
  ) {
    if (!this._db || !text || !workspace.name || !filePaths?.length) return []

    const fileNames = filePaths?.map((filePath) => path.basename(filePath))

    const scores = await this._reranker.rerank(text, fileNames)

    if (!scores) return []

    const relevantFilePaths =
      filePaths
        ?.map((filePath, index) =>
          scores[index] > MINIMUM_FILE_PATH_SCORE ? filePath : ''
        )
        .filter(Boolean) || []

    return relevantFilePaths
  }

  private async getRelevantCodeChunks(
    text: string | undefined,
    filePaths: string[]
  ) {
    if (!this._db || !text || !workspace.name) return
    const table = `${workspace.name}-documents`
    if (await this._db.hasEmbeddingTable(table)) {
      const embedding = await this._db.fetchModelEmbedding(text)

      if (!embedding) return

      this._documents =
        (await this._db.getDocuments(
          embedding,
          3,
          `${workspace.name}-documents`,
          filePaths.length ? `file IN ("${filePaths.join('","')}")` : ''
        )) || []

      const scores = await this._reranker.rerank(
        text,
        this._documents.map((item) =>
          `
          ${item.file}
        `.trim()
        )
      )

      if (!scores) return ''

      const codeChunks =
        this._documents
          ?.map(({ content }, index) =>
            scores[index] > MINIMUM_RERANK_SCORE ? content : null
          )
          .filter(Boolean)
          .join('\n\n')
          .trim() || ''

      return codeChunks
    }
    return ''
  }

  private getProvider = () => {
    const provider = this._extensionContext?.globalState.get<TwinnyProvider>(
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

    const prompt = await this._templateProvider?.renderTemplate<TemplateData>(
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
    requestBody: StreamBodyBase
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

  public async streamChatCompletion(messages: Message[]) {
    this._completion = ''
    this.sendEditorLanguage()
    const editor = window.activeTextEditor
    const selection = editor?.selection
    const selectionContext = editor?.document.getText(selection)
    const lastMessage = messages[messages.length - 1]
    const text = lastMessage.content

    const systemMessage = {
      role: SYSTEM,
      content: await this._templateProvider?.readSystemMessageTemplate(
        this._promptTemplate
      )
    }

    const relevantFiles = await this.getRelevantFilePaths(text)

    const rerankedFilePaths = await this.rerankFilePaths(
      text,
      relevantFiles?.map((f) => f.content)
    )

    let relevantCodeChunks = await this.getRelevantCodeChunks(
      text,
      rerankedFilePaths
    )

    if (rerankedFilePaths.length && !relevantCodeChunks) {
      const promises = []
      for (const file of rerankedFilePaths) {
        promises.push(this._db?.getDocumentByFilePath(file))
      }

      relevantCodeChunks = (await Promise.all(promises)).join('\n')
    }

    const conversation = [systemMessage, ...messages]

    if (selectionContext) {
      conversation.push({
        role: USER,
        content: `This is the code that the user is selecting: ${selectionContext}`
      })
    }

    if (relevantFiles?.length) {
      conversation.push({
        role: USER,
        content: `These files are relevant to the user's query: ${relevantFiles
          ?.map((f) => f.content)
          .join(', ')}`
      })
    }

    if (relevantCodeChunks) {
      conversation.push({
        role: USER,
        content: `These are the relevant code chunks, use them only if you are sure they are relevant to the user's query: ${relevantCodeChunks}`
      })
    }

    const request = this.buildStreamRequest(conversation)
    if (!request) return
    const { requestBody, requestOptions } = request
    return this.streamResponse({ requestBody, requestOptions })
  }

  public async streamTemplateCompletion(
    promptTemplate: string,
    context?: string,
    onEnd?: (completion: string) => void,
    skipMessage?: boolean
  ) {
    this._statusBar.text = '$(loading~spin)'
    const { language } = getLanguage()
    this._completion = ''
    this._promptTemplate = promptTemplate
    this.sendEditorLanguage()
    const { prompt, selection } = await this.buildTemplatePrompt(
      promptTemplate,
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
          completion:
            kebabToSentence(promptTemplate) + '\n\n' + '```\n' + selection,
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

    const conversation = [
      systemMessage,
      {
        role: USER,
        content: prompt
      }
    ]

    // const similarCode = await this.getRelevantCodeChunks(prompt)

    // if (similarCode) {
    //   conversation.push({
    //     role: USER,
    //     content: `Use this similar code as a context for the next response if it is relevant: ${similarCode}`
    //   })
    // }

    const request = this.buildStreamRequest(conversation)

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

import { ExtensionContext, Webview, workspace } from 'vscode'
import {
  ClientMessage,
  Conversation,
  Message,
  ServerMessage,
  RequestBodyBase,
  StreamRequestOptions,
  StreamResponse
} from '../common/types'
import { v4 as uuidv4 } from 'uuid'
import { createStreamRequestBody } from './provider-options'
import { TwinnyProvider } from './provider-manager'
import { streamResponse } from './stream'
import { getChatDataFromProvider } from './utils'
import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ACTIVE_CONVERSATION_STORAGE_KEY,
  CONVERSATION_EVENT_NAME,
  CONVERSATION_STORAGE_KEY,
  EXTENSION_SESSION_NAME,
  TITLE_GENERATION_PROMPT_MESAGE,
  USER,
} from '../common/constants'
import { SessionManager } from './session-manager'
import { SymmetryService } from './symmetry-service'

type Conversations = Record<string, Conversation> | undefined

export class ConversationHistory {
  public config = workspace.getConfiguration('twinny')
  public context: ExtensionContext
  public keepAlive = this.config.get('keepAlive') as string | number
  public temperature = this.config.get('temperature') as number
  public webView: Webview
  private _sessionManager: SessionManager | undefined
  private _symmetryService: SymmetryService
  private _title = ''

  constructor(
    context: ExtensionContext,
    webView: Webview,
    sessionManager: SessionManager | undefined,
    symmetryService: SymmetryService
  ) {
    this.context = context
    this.webView = webView
    this._sessionManager = sessionManager
    this._symmetryService = symmetryService
    this.setUpEventListeners()
  }

  setUpEventListeners() {
    this.webView?.onDidReceiveMessage(
      (message: ClientMessage<Conversation>) => {
        this.handleMessage(message)
      }
    )
  }

  handleMessage(message: ClientMessage<Conversation>) {
    const { type } = message
    switch (type) {
      case CONVERSATION_EVENT_NAME.getConversations:
        return this.getAllConversations()
      case CONVERSATION_EVENT_NAME.getActiveConversation:
        return this.getActiveConversation()
      case CONVERSATION_EVENT_NAME.setActiveConversation:
        return this.setActiveConversation(message.data)
      case CONVERSATION_EVENT_NAME.removeConversation:
        return this.removeConversation(message.data)
      case CONVERSATION_EVENT_NAME.saveConversation:
        if (!message.data) return
        return this.saveConversation(message.data)
      case CONVERSATION_EVENT_NAME.clearAllConversations:
        return this.clearAllConversations()
      default:
      // do nothing
    }
  }

  streamConversationTitle({
    requestBody,
    requestOptions
  }: {
    requestBody: RequestBodyBase
    requestOptions: StreamRequestOptions
    onEnd?: (completion: string) => void
  }): Promise<string> {
    const provider = this.getProvider()

    if (!provider) return Promise.resolve('')

    return new Promise((resolve, reject) => {
      try {
        return streamResponse({
          body: requestBody,
          options: requestOptions,
          onData: (streamResponse) => {
            const data = getChatDataFromProvider(
              provider.provider,
              streamResponse as StreamResponse
            )
            this._title = this._title + data
          },
          onEnd: () => {
            return resolve(this._title)
          }
        })
      } catch (e) {
        return reject(e)
      }
    })
  }

  public getProvider = () => {
    return this.context?.globalState.get<TwinnyProvider>(
      ACTIVE_CHAT_PROVIDER_STORAGE_KEY
    )
  }

  private getRequestOptions(provider: TwinnyProvider) {
    return {
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
  }

  public buildStreamRequestTitle(messages?: Message[]) {
    const provider = this.getProvider()

    if (!provider || !messages?.length) return

    const requestOptions = this.getRequestOptions(provider)

    const requestBody = createStreamRequestBody(provider.provider, {
      model: provider.modelName,
      numPredictChat: this.config.numPredictChat,
      temperature: this.temperature,
      messages: [
        ...messages,
        {
          role: USER,
          content: TITLE_GENERATION_PROMPT_MESAGE
        }
      ],
      keepAlive: this.keepAlive
    })

    return { requestOptions, requestBody }
  }

  public buildStreamRequest(messages?: Message[]) {
    const provider = this.getProvider()

    if (!provider || !messages?.length) return

    const requestOptions = this.getRequestOptions(provider)

    const requestBody = createStreamRequestBody(provider.provider, {
      model: provider.modelName,
      numPredictChat: this.config.numPredictChat,
      temperature: this.temperature,
      messages,
      keepAlive: this.keepAlive
    })

    return { requestOptions, requestBody }
  }

  async getConversationTitle(messages: Message[]): Promise<string> {
    const symmetryConnected = this._sessionManager?.get(
      EXTENSION_SESSION_NAME.twinnySymmetryConnection
    )
    if (symmetryConnected) {
      return Promise.resolve(`${messages[0].content?.substring(0, 50)}...`)
    }
    const request = this.buildStreamRequestTitle(messages)
    if (!request) return ''
    return await this.streamConversationTitle(request)
  }

  getAllConversations() {
    const conversations = this.getConversations() || {}
    this.webView?.postMessage({
      type: CONVERSATION_EVENT_NAME.getConversations,
      value: {
        data: conversations
      }
    })
  }

  getConversations(): Conversations {
    const conversations = this.context.globalState.get<
      Record<string, Conversation>
    >(CONVERSATION_STORAGE_KEY)
    return conversations
  }

  resetConversation() {
    this.context.globalState.update(ACTIVE_CONVERSATION_STORAGE_KEY, undefined)
    this.setActiveConversation(undefined)
  }

  updateConversation(conversation: Conversation) {
    const conversations = this.getConversations() || {}
    if (!conversation.id) return
    this.context.globalState.update(CONVERSATION_STORAGE_KEY, {
      ...conversations,
      [conversation.id]: conversation
    })
    this.setActiveConversation(conversation)
  }

  setActiveConversation(conversation: Conversation | undefined) {
    this.context.globalState.update(
      ACTIVE_CONVERSATION_STORAGE_KEY,
      conversation
    )
    this.webView?.postMessage({
      type: CONVERSATION_EVENT_NAME.setActiveConversation,
      value: {
        data: conversation
      }
    } as ServerMessage<Conversation>)
    this.getAllConversations()
  }

  getActiveConversation() {
    const conversation: Conversation | undefined = this.context.globalState.get(
      ACTIVE_CONVERSATION_STORAGE_KEY
    )
    this.setActiveConversation(conversation)
    return conversation
  }

  removeConversation(conversation?: Conversation) {
    const conversations = this.getConversations() || {}
    if (!conversation?.id) return
    delete conversations[conversation.id]
    this.context.globalState.update(CONVERSATION_STORAGE_KEY, {
      ...conversations
    })
    this.setActiveConversation(undefined)
    this.getAllConversations()
  }

  clearAllConversations() {
    this.context.globalState.update(CONVERSATION_STORAGE_KEY, {})
    this.setActiveConversation(undefined)
  }

  async saveConversation(conversation: Conversation) {
    const activeConversation = this.getActiveConversation()
    if (activeConversation)
      return this.updateConversation({
        ...activeConversation,
        messages: conversation.messages
      })

    if (!conversation.messages.length || conversation.messages.length > 2)
      return

    this._title = await this.getConversationTitle(conversation.messages)
    this.saveConversationEnd(conversation)
  }

  private saveConversationEnd(conversation: Conversation) {
    const id = uuidv4()
    const conversations = this.getConversations()
    if (!conversations) return
    const newConversation: Conversation = {
      id,
      title: this._title || '',
      messages: conversation.messages
    }
    conversations[id] = newConversation
    this.context.globalState.update(CONVERSATION_STORAGE_KEY, conversations)
    this.setActiveConversation(newConversation)
    this._title = ''
  }
}

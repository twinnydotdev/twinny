import { ChatCompletionMessageParam } from "fluency.js"
import { ExtensionContext, Webview } from "vscode"

import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ACTIVE_CONVERSATION_STORAGE_KEY,
  CONVERSATION_EVENT_NAME,
  CONVERSATION_STORAGE_KEY,
} from "../common/constants"
import { ClientMessage, Conversation, ServerMessage } from "../common/types"

import { Base } from "./base"
import { TwinnyProvider } from "./provider-manager"

type Conversations = Record<string, Conversation> | undefined

export class ConversationHistory extends Base {
  public webView: Webview

  constructor(
    context: ExtensionContext,
    webView: Webview,
  ) {
    super(context)
    this.webView = webView
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

  public getProvider = () => {
    return this.context?.globalState.get<TwinnyProvider>(
      ACTIVE_CHAT_PROVIDER_STORAGE_KEY
    )
  }

  private getRequestOptions(provider: TwinnyProvider) {
    return {
      hostname: provider.apiHostname,
      port: provider.apiPort ? Number(provider.apiPort) : undefined,
      path: provider.apiPath,
      protocol: provider.apiProtocol,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`
      }
    }
  }

  getConversationTitle(
    messages: ChatCompletionMessageParam[]
  ):string | undefined {
    const message = messages[0].content as string
    return `${message?.substring(0, 50)}...`
  }

  getAllConversations() {
    const conversations = this.getConversations() || {}
    this.webView?.postMessage({
      type: CONVERSATION_EVENT_NAME.getConversations,
      data: conversations
    })
  }

  getConversations(): Conversations {
    const conversations = this.context?.globalState.get<
      Record<string, Conversation>
    >(CONVERSATION_STORAGE_KEY)
    return conversations
  }

  resetConversation() {
    this.context?.globalState.update(ACTIVE_CONVERSATION_STORAGE_KEY, undefined)
    this.setActiveConversation(undefined)
  }

  updateConversation(conversation: Conversation) {
    if (!conversation.id) return

    const conversations = this.getConversations() || {}

    this.context?.globalState.update(CONVERSATION_STORAGE_KEY, {
      ...conversations,
      [conversation.id]: conversation
    })

    this.setActiveConversation(conversation)
  }

  setActiveConversation(conversation: Conversation | undefined) {
    this.context?.globalState.update(
      ACTIVE_CONVERSATION_STORAGE_KEY,
      conversation
    )

    this.webView?.postMessage({
      type: CONVERSATION_EVENT_NAME.setActiveConversation,
      data: conversation
    } as ServerMessage<Conversation>)

    this.getAllConversations()
  }

  getActiveConversation() {
    const conversation: Conversation | undefined =
      this.context?.globalState.get(ACTIVE_CONVERSATION_STORAGE_KEY)

    this.setActiveConversation(conversation)
    return conversation
  }

  removeConversation(conversation?: Conversation) {
    const conversations = this.getConversations() || {}
    if (!conversation?.id) return
    delete conversations[conversation.id]
    this.context?.globalState.update(CONVERSATION_STORAGE_KEY, {
      ...conversations
    })
    this.setActiveConversation(undefined)
    this.getAllConversations()
  }

  clearAllConversations() {
    this.context?.globalState.update(CONVERSATION_STORAGE_KEY, {})
    this.setActiveConversation(undefined)
  }

  async saveConversation(conversation: Conversation) {
    const activeConversation = this.getActiveConversation()

    if (activeConversation) {
      return this.updateConversation({
        ...activeConversation,
        messages: conversation.messages,
        title: this.getConversationTitle(conversation.messages)
      })
    }
  }
}

import { ChatCompletionMessageParam } from "fluency.js"
import { v4 as uuidv4 } from "uuid"
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
  private _title = ""

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

  async getConversationTitle(
    messages: ChatCompletionMessageParam[]
  ): Promise<string | null> {

    const message = messages[0].content as string

    return Promise.resolve(`${message?.substring(0, 50)}...`)
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

  async resetConversation() {
    this.context?.globalState.update(ACTIVE_CONVERSATION_STORAGE_KEY, undefined)
    const conversation = await this.saveConversation({
      messages: []
    })
    this.setActiveConversation(conversation)
  }

  updateConversation(conversation: Conversation) {
    const conversations = this.getConversations() || {}
    if (!conversation.id) return
    this.context?.globalState.update(CONVERSATION_STORAGE_KEY, {
      ...conversations,
      [conversation.id]: conversation
    })
    this.setActiveConversation(conversation)
    return conversation
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

  async saveConversation(conversation: Conversation): Promise<Conversation | undefined> {
    const activeConversation = this.getActiveConversation()
    if (activeConversation)
      return this.updateConversation({
        ...activeConversation,
        messages: conversation.messages
      })

    return this.saveConversationEnd(conversation)
  }

  private saveConversationEnd(conversation: Conversation) {
    let id = conversation.id
    if (!id) id = uuidv4()
    const conversations = this.getConversations()
    if (!conversations) return
    const newConversation: Conversation = {
      id,
      title: this._title || "",
      messages: conversation.messages
    }
    conversations[id] = newConversation
    this.context?.globalState.update(CONVERSATION_STORAGE_KEY, conversations)
    this.setActiveConversation(newConversation)
    this._title = ""
    return newConversation
  }
}

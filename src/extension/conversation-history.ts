import { ChatCompletionMessageParam } from "fluency.js"
import { ExtensionContext, Webview } from "vscode"

import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ACTIVE_CONVERSATION_STORAGE_KEY,
  CONVERSATION_EVENT_NAME,
  CONVERSATION_STORAGE_KEY,
  TITLE_GENERATION_PROMPT_MESAGE
} from "../common/constants"
import { ClientMessage, Conversation, ServerMessage } from "../common/types"

import { Base } from "./base"
import { Chat } from "./chat" // Added import
import { TwinnyProvider } from "./provider-manager"

type Conversations = Record<string, Conversation> | undefined

export class ConversationHistory extends Base {
  public webView: Webview
  private _chatService: Chat

  constructor(context: ExtensionContext, webView: Webview, chatService: Chat) {
    super(context)
    this.webView = webView
    this._chatService = chatService
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

  getConversationTitle(messages: ChatCompletionMessageParam[]): string {
    if (
      messages &&
      messages.length > 0 &&
      messages[0].content &&
      typeof messages[0].content === "string" &&
      (messages[0].content as string).trim() !== ""
    ) {
      const content = messages[0].content as string
      return content.length > 50 ? `${content.substring(0, 50)}...` : content
    }
    return "Untitled Conversation"
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
      let title = await this._generateTitleWithLlm(
        conversation.messages.slice(0, 2)
      )
      if (!title) {
        title = this.getConversationTitle(conversation.messages)
      }
      return this.updateConversation({
        ...activeConversation,
        messages: conversation.messages,
        title
      })
    }
  }

  private async _generateTitleWithLlm(
    messages: ChatCompletionMessageParam[]
  ): Promise<string | undefined> {
    if (!messages?.length) {
      return undefined
    }

    const firstMessage = messages[0].content
    if (typeof firstMessage !== "string" || !firstMessage.trim()) {
      return undefined
    }

    const secondMessage =
      messages.length > 1 && typeof messages[1].content === "string"
        ? messages[1].content
        : ""

    const prompt = `${TITLE_GENERATION_PROMPT_MESAGE}:

    Message 1: "${firstMessage.trim()}"
    ${secondMessage ? `Message 2: "${secondMessage}"` : ""}

    Title:`.trim()

    console.log("LLM Title Generation Prompt:", prompt)

    try {
      const generatedTitle = await this._chatService.generateSimpleCompletion(
        prompt
      )
      return generatedTitle?.trim()
    } catch (error) {
      console.error("Error calling LLM for title generation:", error)
      return undefined
    }
  }
}

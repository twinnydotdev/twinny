import { ChatCompletionMessageParam } from "fluency.js"
import { ExtensionContext } from "vscode"

import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ACTIVE_CONVERSATION_STORAGE_KEY,
  CONVERSATION_EVENT_NAME,
  CONVERSATION_STORAGE_KEY,
  TITLE_GENERATION_PROMPT_MESAGE
} from "../../common/constants"
import { Conversation, TwinnyProvider } from "../../common/types"
import { ExtensionBridge } from "../messaging/bridge"
import { Base } from "../providers/base"

import { Chat } from "./index"

type Conversations = Record<string, Conversation> | undefined

export class ConversationHistory extends Base {
  public bridge: ExtensionBridge
  private _chatService: Chat

  constructor(
    context: ExtensionContext,
    bridge: ExtensionBridge,
    chatService: Chat
  ) {
    super(context)
    this.bridge = bridge
    this._chatService = chatService
    this.registerHandlers()
  }

  protected registerHandlers() {
    this.bridge.handleAll({
      [CONVERSATION_EVENT_NAME.getConversations]: () =>
        this.getAllConversations(),
      [CONVERSATION_EVENT_NAME.getActiveConversation]: () =>
        void this.getActiveConversation(),
      [CONVERSATION_EVENT_NAME.setActiveConversation]: (conversation) =>
        this.setActiveConversation(conversation),
      [CONVERSATION_EVENT_NAME.removeConversation]: (conversation) =>
        this.removeConversation(conversation),
      [CONVERSATION_EVENT_NAME.renameConversation]: ({ id, title }) =>
        this.renameConversation(id, title),
      [CONVERSATION_EVENT_NAME.saveConversation]: (conversation) =>
        conversation && void this.saveConversation(conversation),
      [CONVERSATION_EVENT_NAME.clearAllConversations]: () =>
        this.clearAllConversations()
    })
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
    this.bridge.emit(
      CONVERSATION_EVENT_NAME.getConversations,
      this.getConversations() || {}
    )
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

    const stamped = { ...conversation, updatedAt: Date.now() }
    this.context?.globalState.update(CONVERSATION_STORAGE_KEY, {
      ...conversations,
      [conversation.id]: stamped
    })

    this.setActiveConversation(stamped)
  }

  /** A title the user typed sticks: the model is not asked again. */
  renameConversation(id: string, title: string) {
    const conversations = this.getConversations() || {}
    const existing = conversations[id]
    const cleaned = title.trim()
    if (!existing || !cleaned) return
    const renamed = { ...existing, title: cleaned, pinnedTitle: true }
    this.context?.globalState.update(CONVERSATION_STORAGE_KEY, {
      ...conversations,
      [id]: renamed
    })
    const active = this.context?.globalState.get<Conversation>(
      ACTIVE_CONVERSATION_STORAGE_KEY
    )
    if (active?.id === id) {
      this.setActiveConversation({ ...active, title: cleaned, pinnedTitle: true })
    } else {
      this.getAllConversations()
    }
  }

  setActiveConversation(conversation: Conversation | undefined) {
    this.context?.globalState.update(
      ACTIVE_CONVERSATION_STORAGE_KEY,
      conversation
    )

    this.bridge.emit(
      CONVERSATION_EVENT_NAME.setActiveConversation,
      conversation
    )

    this.getAllConversations()
  }

  getActiveConversation() {
    const conversation: Conversation | undefined =
      this.context?.globalState.get(ACTIVE_CONVERSATION_STORAGE_KEY)

    this.setActiveConversation(conversation)
    return conversation
  }

  /** Deleting a conversation other than the open one leaves the chat alone. */
  removeConversation(conversation?: Conversation) {
    const conversations = this.getConversations() || {}
    if (!conversation?.id) return
    delete conversations[conversation.id]
    this.context?.globalState.update(CONVERSATION_STORAGE_KEY, {
      ...conversations
    })
    const active = this.context?.globalState.get<Conversation>(
      ACTIVE_CONVERSATION_STORAGE_KEY
    )
    if (active?.id === conversation.id) {
      this.setActiveConversation(undefined)
    } else {
      this.getAllConversations()
    }
  }

  clearAllConversations() {
    this.context?.globalState.update(CONVERSATION_STORAGE_KEY, {})
    this.setActiveConversation(undefined)
  }

  /**
   * The model names the conversation once, after the first reply, when the
   * two messages say what it is about. Later saves keep that title rather
   * than paying for another request every time a message lands.
   */
  async saveConversation(conversation: Conversation) {
    const activeConversation = this.getActiveConversation()
    if (!activeConversation) return

    const isFirstExchange = conversation.messages.length === 2
    let title = activeConversation.title

    if (isFirstExchange && !activeConversation.pinnedTitle) {
      title =
        (await this._generateTitleWithLlm(conversation.messages)) || title
    }
    if (!title) {
      title = this.getConversationTitle(conversation.messages)
    }

    return this.updateConversation({
      ...activeConversation,
      messages: conversation.messages,
      title
    })
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

    try {
      const generatedTitle = await this._chatService.generateSimpleCompletion(
        prompt
      )
      return this.cleanTitle(generatedTitle)
    } catch (error) {
      console.error("Error calling LLM for title generation:", error)
      return undefined
    }
  }

  /** Models like to quote or prefix titles; a title is one short line. */
  private cleanTitle(text: string | undefined): string | undefined {
    if (!text) return undefined
    const firstLine = text
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0)
    if (!firstLine) return undefined
    const cleaned = firstLine
      .replace(/^(title:?)\s*/i, "")
      .replace(/^["'`*#\s]+|["'`*\s]+$/g, "")
      .trim()
    if (!cleaned) return undefined
    return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned
  }
}

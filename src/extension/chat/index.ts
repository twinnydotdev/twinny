import { TokenJS } from "fluency.js"
import { CompletionNonStreaming, LLMProvider } from "fluency.js/dist/chat"
import { ExtensionContext } from "vscode"

import { EVENT_NAME, SYSTEM, USER, WEBUI_TABS } from "../../common/constants"
import { logger } from "../../common/logger"
import { kebabToSentence } from "../../common/text"
import {
  ChatCompletionMessage,
  MentionType,
  TwinnyProvider
} from "../../common/types"
import { WorkspaceSearch } from "../embeddings/search"
import { ExtensionBridge } from "../messaging/bridge"
import { Base } from "../providers/base"
import { describeProviderError, stripThinking } from "../providers/errors"
import { TwinnyStatusBar } from "../status-bar"
import { TemplateProvider } from "../templates/provider"
import { getLanguage } from "../utils"

import { ChatContextBuilder } from "./context"
import { ContextEntry, formatContextEntries } from "./context-files"
import { ChatGeneration } from "./generation"
import {
  buildBlockingRequest,
  buildStreamingRequest,
  getFluencyProvider,
  supportsStreaming,
  toApiMessages
} from "./messages"

/** Templates whose answer benefits from `@workspace`-style lookups. */
const TEMPLATES_WITH_RAG = ["explain"]

/**
 * The chat feature's front door.
 *
 * Takes what the webview or a command hands over, builds the full prompt
 * (`ChatContextBuilder`), converts it for the API (`messages.ts`) and runs
 * it (`ChatGeneration`). Holds the running conversation between turns.
 */
export class Chat extends Base {
  private _conversation: ChatCompletionMessage[] = []
  private readonly _bridge: ExtensionBridge
  private readonly _context: ChatContextBuilder
  private readonly _generation: ChatGeneration

  constructor(
    statusBar: TwinnyStatusBar,
    templateDir: string | undefined,
    extensionContext: ExtensionContext,
    bridge: ExtensionBridge,
    search: WorkspaceSearch | undefined
  ) {
    super(extensionContext)
    this._bridge = bridge
    this._generation = new ChatGeneration(bridge, statusBar)
    this._context = new ChatContextBuilder(
      extensionContext,
      bridge,
      new TemplateProvider(templateDir),
      search
    )
  }

  /* ------------------------------------------------------------------------ */
  /*  Public API                                                               */
  /* ------------------------------------------------------------------------ */

  public get cancelled(): boolean {
    return this._generation.cancelled
  }

  public abort = () => this._generation.abort()

  public resetConversation() {
    this._conversation = []
  }

  /** A message typed in the chat, with whatever the user attached. */
  public async completion(
    messages: ChatCompletionMessage[],
    mentions?: MentionType[]
  ): Promise<string | undefined> {
    const provider = this.start()
    if (!provider) return undefined
    this._conversation = await this.buildConversation(messages, mentions)
    return this.run(provider)
  }

  /** A code action (explain, refactor…) run over the editor selection. */
  public async templateCompletion(template: string, context?: string) {
    const provider = this.start()
    if (!provider) return ""
    this._conversation = await this.buildTemplateConversation(template, context)
    return this.run(provider)
  }

  /**
   * A question raised by a command rather than typed: shown in the chat as
   * if the user had sent `display`, answered from `prompt` with `attached`
   * code, and kept in the conversation so follow-ups work.
   */
  public async ask(
    display: string,
    prompt: string,
    attached: ContextEntry[] = []
  ): Promise<string> {
    const provider = this.start()
    if (!provider) return ""
    this._bridge.emit(EVENT_NAME.twinnySetTab, WEBUI_TABS.chat)
    this._bridge.emit(EVENT_NAME.twinnyAddMessage, {
      role: USER,
      content: display
    })
    const code = formatContextEntries(attached)
    const content = code ? `${prompt}\n\nAttached code:\n\n${code}` : prompt
    if (!this._conversation.length) {
      this._conversation = [
        { role: SYSTEM, content: await this._context.systemPrompt() }
      ]
    }
    this._conversation = [
      ...this._conversation,
      { role: USER, content: content.trim() }
    ]
    return this.run(provider)
  }

  /**
   * Stream a reply to exactly these messages, skipping the chat's own prompt
   * building (system prompt, editor selection, workspace context). The reply
   * is shown in the chat as it arrives and returned when complete.
   */
  public async streamMessages(
    messages: ChatCompletionMessage[],
    prefix = ""
  ): Promise<string> {
    const provider = this.start()
    if (!provider) return ""
    this._conversation = messages
    return this.run(provider, prefix)
  }

  /** One-shot, no UI: used for conversation titles and commit messages. */
  public async generateSimpleCompletion(
    prompt: string
  ): Promise<string | undefined> {
    const provider = this.getProvider()
    if (!provider) {
      logger.error("No chat provider configured.")
      return undefined
    }
    const request: CompletionNonStreaming<LLMProvider> = {
      messages: [{ role: USER, content: prompt }],
      model: provider.modelName,
      provider: getFluencyProvider(provider)
    }
    try {
      const result = await this.client(provider).chat.completions.create(request)
      const content = result.choices?.[0]?.message?.content
      return typeof content === "string" ? stripThinking(content) || undefined : undefined
    } catch (error) {
      logger.error(
        `Simple completion failed: ${describeProviderError(error, provider)}`
      )
      return undefined
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Internals                                                                */
  /* ------------------------------------------------------------------------ */

  /** Common preamble: clear the stop flag, tell the webview the language. */
  private start(): TwinnyProvider | undefined {
    this._generation.reset()
    this._bridge.emit(EVENT_NAME.twinnySendLanguage, getLanguage())
    return this.getProvider()
  }

  private client(provider: TwinnyProvider) {
    return new TokenJS({
      baseURL: this.getProviderBaseUrl(provider),
      apiKey: provider.apiKey
    })
  }

  private run(provider: TwinnyProvider, prefix = "") {
    const client = this.client(provider)
    return supportsStreaming(provider)
      ? this._generation.stream(
          client,
          buildStreamingRequest(provider, this._conversation),
          provider,
          prefix
        )
      : this._generation.block(
          client,
          buildBlockingRequest(provider, this._conversation),
          provider,
          prefix
        )
  }

  private async buildConversation(
    messages: ChatCompletionMessage[],
    mentions: MentionType[] | undefined
  ): Promise<ChatCompletionMessage[]> {
    const last = messages[messages.length - 1]
    const extra = await this._context.additionalContext(
      last.content?.toString() || "",
      mentions
    )
    return toApiMessages([
      { role: SYSTEM, content: await this._context.systemPrompt() },
      ...messages.slice(0, -1),
      {
        role: USER,
        content: `${last.content}\n\n${extra.trim()}`.trim(),
        images: last.images
      }
    ])
  }

  private async buildTemplateConversation(
    template: string,
    context?: string
  ): Promise<ChatCompletionMessage[]> {
    const { language } = getLanguage()
    const { prompt, selection } = await this._context.templatePrompt(
      template,
      language,
      context
    )

    this._bridge.emit(EVENT_NAME.twinnySetTab, WEBUI_TABS.chat)
    this._bridge.emit(EVENT_NAME.twinnyAddMessage, {
      role: USER,
      content:
        `${kebabToSentence(template)}\n\n\n<pre><code>${selection}</code></pre>`.trim() ||
        " "
    })

    const rag = TEMPLATES_WITH_RAG.includes(template)
      ? await this._context.ragContext(selection)
      : undefined
    const content = rag ? `${prompt}\n\nAdditional Context:\n${rag}` : prompt

    return [...this._conversation, { role: USER, content: content.trim() || " " }]
  }
}

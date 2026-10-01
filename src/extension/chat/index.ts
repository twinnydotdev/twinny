import { ExtensionContext, workspace } from "vscode"

import {
  API_PROVIDERS,
  ASSISTANT,
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  SYSTEM,
  USER,
  WEBUI_TABS
} from "../../common/constants"
import { formatCount, logger } from "../../common/logger"
import { kebabToSentence } from "../../common/text"
import {
  ChatCompletionMessage,
  MentionType,
  TwinnyProvider
} from "../../common/types"
import type { ChatEditMode } from "../edit/service"
import { WorkspaceSearch } from "../embeddings/search"
import { GenerationTracker } from "../generations"
import { readText, resolveInferenceProvider } from "../inference"
import { ExtensionBridge } from "../messaging/bridge"
import { Base } from "../providers/base"
import { describeProviderError, stripThinking } from "../providers/errors"
import { TemplateProvider } from "../templates/provider"
import { toolModeFor, withTools } from "../tools/loop"
import { workspaceTools } from "../tools/workspace"
import { getLanguage } from "../utils"

import { ChatContextBuilder } from "./context"
import { ContextEntry, formatContextEntries } from "./context-files"
import { ChatGeneration } from "./generation"
import { ChatCommandMode, editorEdits, editorKnowledge, indexSearch, terminalCommands } from "./tool-sinks"
import { ToolSteps } from "./tool-steps"
import { buildChatTurn } from "./turn"

/** Templates whose answer benefits from `@workspace`-style lookups. */
const TEMPLATES_WITH_RAG = ["explain"]

/**
 * The chat feature's front door.
 *
 * Takes what the webview or a command hands over, turns it into the
 * messages the model is sent (`buildChatTurn`, with `ChatContextBuilder`
 * for the context) and runs them (`ChatGeneration`) against whichever
 * provider the inference layer resolves. Holds the running conversation,
 * replies included, between turns.
 */
export class Chat extends Base {
  private _conversation: ChatCompletionMessage[] = []
  private readonly _bridge: ExtensionBridge
  private readonly _context: ChatContextBuilder
  private readonly _generation: ChatGeneration
  private readonly _search: WorkspaceSearch | undefined
  private readonly _steps: ToolSteps
  private readonly _stopSubscription: { dispose(): void }

  constructor(
    generations: GenerationTracker,
    templateDir: string | undefined,
    extensionContext: ExtensionContext,
    bridge: ExtensionBridge,
    search: WorkspaceSearch | undefined
  ) {
    super(extensionContext)
    this._bridge = bridge
    this._search = search
    this._steps = new ToolSteps((steps) => bridge.emit(EVENT_NAME.twinnyToolSteps, steps))
    // Stopping the reply skips a command still waiting for Run or Skip.
    this._stopSubscription = generations.onDidStop(() => this._steps.cancelWaiting())
    this._generation = new ChatGeneration(bridge, generations)
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

  public abort = () => {
    this._steps.cancelWaiting()
    this._generation.abort()
  }

  /** Run or Skip, clicked on a command waiting in the tool steps. */
  public answerToolApproval(id: string, run: boolean) {
    this._steps.answer(id, run)
  }

  public dispose() {
    super.dispose()
    this._stopSubscription.dispose()
    this._steps.cancelWaiting()
    this._generation.dispose()
  }

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
    this._conversation = await buildChatTurn(messages, {
      systemPrompt: () => this._context.systemPrompt(),
      additionalContext: (question, sources, history) =>
        this._context.additionalContext(question, sources, mentions, history)
    })
    return this.run(provider, "", this.config.get<boolean>("chatTools", false))
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
    const code = formatContextEntries(attached)
    const content = (code ? `${prompt}\n\nAttached code:\n\n${code}` : prompt).trim()
    this._bridge.emit(EVENT_NAME.twinnySetTab, WEBUI_TABS.chat)
    this._bridge.emit(EVENT_NAME.twinnyAddMessage, {
      role: USER,
      content: display,
      prompt: content
    })
    if (!this._conversation.length) {
      this._conversation = [
        { role: SYSTEM, content: await this._context.systemPrompt() }
      ]
    }
    this._conversation = [
      ...this._conversation,
      { role: USER, content }
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
    try {
      const content = await readText(
        resolveInferenceProvider(provider).chat({
          model: provider.modelName,
          messages: [{ role: USER, content: prompt }]
        })
      )
      return stripThinking(content) || undefined
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

  /**
   * Send the conversation; the reply joins it, so the next turn follows on.
   * With `tools`, the model may look around the workspace first.
   */
  private async run(provider: TwinnyProvider, prefix = "", tools = false) {
    let transcript: string | undefined
    const reply = await this._generation.generate(
      this.client(provider, tools, (text) => (transcript = text)),
      { model: provider.modelName, messages: this._conversation },
      provider,
      prefix,
      () => transcript
    )
    if (reply) {
      this._conversation = [
        ...this._conversation,
        { role: ASSISTANT, content: transcript ?? reply }
      ]
    }
    return reply
  }

  /**
   * The provider's client, with the workspace tools when asked for and a
   * folder is open: reading and searching (by meaning too, when there is an
   * index), editing files and running commands, each as the settings say.
   */
  private client(
    provider: TwinnyProvider,
    tools: boolean,
    onTranscript: (text: string) => void
  ) {
    const client = resolveInferenceProvider(provider)
    const root = tools ? workspace.workspaceFolders?.[0]?.uri.fsPath : undefined
    if (!root) return client
    this._steps.reset()
    const ignored = this.config.get<string[]>("embeddingIgnoredGlobs", [])
    const commandMode = this.config.get<ChatCommandMode>("chatToolsCommands", "ask")
    const editMode = this.config.get<ChatEditMode>("chatToolsEdits", "apply")
    const approveChange = (detail: string, approval: "command" | "change") =>
      this._steps.approve(detail, approval)
    const search = this._search
    const available = workspaceTools(root, ignored, {
      edits: editorEdits(editMode, approveChange),
      editor: editorKnowledge(root, editMode, approveChange),
      commands:
        commandMode === "off"
          ? undefined
          : terminalCommands(commandMode, root, (command) => this._steps.approve(command)),
      codeSearch: search?.available
        ? indexSearch(search, () =>
            Number(
              this.context?.globalState.get(
                `${EVENT_NAME.twinnyGlobalContext}-${EXTENSION_CONTEXT_NAME.twinnyRerankThreshold}`
              )
            )
          )
        : undefined
    })
    return withTools(client, available, {
      mode: toolModeFor(provider.provider),
      // OpenAI's reasoning models think silently on the chat route; at their
      // default effort one tool step can take minutes.
      reasoningEffort: provider.provider === API_PROVIDERS.OpenAI ? "low" : undefined,
      onTranscript,
      onRequest: (chars, step, mode) =>
        logger.info(`Chat tools · request ${step + 1} (${mode}) · ${formatCount(chars)} chars`),
      stepLines: false,
      onToolStart: (start) => this._steps.start(start),
      onStep: (step) => {
        this._steps.finish(step)
        logger.info(`Chat tools · ${step.summary}`)
      },
      onFallback: (reason) =>
        logger.warn(`Chat tools · ${provider.modelName} refused native tool calls, using text: ${reason}`)
    })
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
        " ",
      // Like a typed turn, the conversation keeps the question; what the
      // workspace search adds is for this reply only.
      prompt: prompt.trim()
    })

    const rag = TEMPLATES_WITH_RAG.includes(template)
      ? await this._context.ragContext(selection, new Set())
      : undefined
    const content =
      (rag ? `${prompt}\n\nAdditional Context:\n${rag}` : prompt).trim() || " "

    return [...this._conversation, { role: USER, content }]
  }
}

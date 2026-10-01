import { ExtensionContext, workspace } from "vscode"

import {
  API_PROVIDERS,
  ASSISTANT,
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  GLOBAL_STORAGE_KEY,
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
import {
  assumedContextWindow,
  contextWindowOf,
  knownContextWindow
} from "../inference/context-window"
import { ExtensionBridge } from "../messaging/bridge"
import { Base } from "../providers/base"
import { describeProviderError, stripThinking } from "../providers/errors"
import { TemplateProvider } from "../templates/provider"
import { SMALL_CONTEXT_TOKENS } from "../tools/budget"
import { ToolLoopUsage, toolModeFor, withTools } from "../tools/loop"
import { WorkspaceView } from "../tools/view"
import { workspaceTools } from "../tools/workspace"
import { getLanguage } from "../utils"

import { ChatContextBuilder } from "./context"
import { ContextEntry, formatContextEntries } from "./context-files"
import { ChatGeneration } from "./generation"
import {
  ChatCommandMode,
  editorEdits,
  editorHint,
  editorKnowledge,
  indexSearch,
  openDocumentText,
  terminalCommands
} from "./tool-sinks"
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
    const view = this.toolsView()
    this._conversation = await buildChatTurn(messages, {
      systemPrompt: () => this._context.systemPrompt(),
      additionalContext: async (question, sources, history) => {
        const context = await this._context.additionalContext(question, sources, mentions, history)
        // With tools, where the user is in the editor comes with the
        // question, so "this function" needs no tool call to place.
        const hint = view ? editorHint(view) : ""
        return hint ? `${hint}\n\n${context}` : context
      }
    })
    return this.run(provider, "", view)
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
   * Agent mode, as the composer's switch left it (stored the way the webview
   * stores global values). Until it is first switched, `twinny.chatTools`.
   */
  private agentMode(): boolean {
    const stored = this.context?.globalState.get<boolean>(
      `${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.agentMode}`
    )
    return stored ?? this.config.get<boolean>("chatTools", false)
  }

  /**
   * The workspace as the tools will see it, when the user has tools on
   * and a folder open. Made once per reply: its ignore rules are read at
   * the start and hold until the end.
   */
  private toolsView(): WorkspaceView | undefined {
    if (!this.agentMode()) return undefined
    const root = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!root) return undefined
    return new WorkspaceView(root, this.config.get<string[]>("embeddingIgnoredGlobs", []), openDocumentText)
  }

  /**
   * Send the conversation; the reply joins it, so the next turn follows on.
   * With a `view`, the model may work in the workspace first.
   */
  private async run(provider: TwinnyProvider, prefix = "", view?: WorkspaceView) {
    let toolNotes: string | undefined
    const usage: ToolLoopUsage = {}
    // Asked now, so the reply can say how much of the context it used.
    void contextWindowOf(provider)
    const reply = await this._generation.generate(
      view
        ? this.toolsClient(provider, view, {
            onNotes: (notes) => (toolNotes = notes),
            onUsage: (counted) => Object.assign(usage, counted)
          })
        : resolveInferenceProvider(provider),
      { model: provider.modelName, messages: this._conversation },
      provider,
      prefix,
      {
        toolNotes: () => toolNotes,
        keepEmpty: () => !!view && this._steps.steps.length > 0,
        meta: () => {
          const contextWindow = knownContextWindow(provider)
          return {
            ...(usage.promptTokens ? { promptTokens: usage.promptTokens } : {}),
            ...(usage.completionTokens ? { completionTokens: usage.completionTokens } : {}),
            ...(contextWindow ? { contextWindow } : {})
          }
        }
      }
    )
    if (reply) {
      this._conversation = [
        ...this._conversation,
        { role: ASSISTANT, content: reply }
      ]
    }
    return reply
  }

  /**
   * The provider's client with the workspace's tools: reading and
   * searching (by meaning too, when there is an index), what the language
   * servers know, editing files and running commands, each as the
   * settings say.
   */
  private toolsClient(
    provider: TwinnyProvider,
    view: WorkspaceView,
    hooks: { onNotes(notes: string | undefined): void; onUsage(usage: ToolLoopUsage): void }
  ) {
    this._steps.reset()
    const commandMode = this.config.get<ChatCommandMode>("chatToolsCommands", "ask")
    const editMode = this.config.get<ChatEditMode>("chatToolsEdits", "apply")
    const approveChange = (detail: string, approval: "command" | "change") =>
      this._steps.approve(detail, approval)
    const search = this._search
    const available = workspaceTools(view, [], {
      edits: editorEdits(view, editMode, approveChange),
      editor: editorKnowledge(view, editMode, approveChange),
      commands:
        commandMode === "off"
          ? undefined
          : terminalCommands(commandMode, view.root, (command) => this._steps.approve(command)),
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
    let warned = false
    return withTools(resolveInferenceProvider(provider), available, {
      mode: toolModeFor(provider.provider),
      // OpenAI's reasoning models think silently on the chat route; at their
      // default effort one tool step can take minutes.
      reasoningEffort: provider.provider === API_PROVIDERS.OpenAI ? "low" : undefined,
      contextWindow: async () => {
        const told = await contextWindowOf(provider)
        if (told && told < SMALL_CONTEXT_TOKENS && !warned) {
          warned = true
          logger.warn(
            `Chat tools · ${provider.modelName} is loaded with a ${formatCount(told)}-token context. ` +
              "Tools need about 8k to work well; older results will be trimmed often. Raise the server's context length if you can."
          )
        }
        return told ?? assumedContextWindow(provider)
      },
      stepLines: false,
      onNotes: hooks.onNotes,
      onUsage: hooks.onUsage,
      onRequest: (chars, step, mode, tokens) =>
        logger.info(
          `Chat tools · request ${step + 1} (${mode}) · ${formatCount(chars)} chars, about ${formatCount(tokens)} tokens`
        ),
      onToolStart: (start) => this._steps.start(start),
      onStep: (step) => {
        this._steps.finish(step)
        logger.info(`Chat tools · ${step.summary}`)
      },
      onTrim: (results, tokens) =>
        logger.info(
          `Chat tools · trimmed ${results} older tool result${results === 1 ? "" : "s"} to fit the context (now about ${formatCount(tokens)} tokens)`
        ),
      onFallback: (reason, what) =>
        logger.warn(
          what === "tools"
            ? `Chat tools · ${provider.modelName} refused native tool calls, using the text protocol: ${reason}`
            : `Chat tools · ${provider.modelName} does not take a reasoning effort, carrying on without: ${reason}`
        ),
      // A step cut off by a stop or a failure is marked so before the
      // reply (and its steps) are saved.
      onEnd: () => this._steps.settle()
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

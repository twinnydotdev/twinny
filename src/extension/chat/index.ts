import os from "os"
import path from "path"
import { ExtensionContext, workspace } from "vscode"

import { cleanModelSuggestion, composerSuggestionMessages } from "../../common/composer-predict"
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
import type { ComposerTurn } from "../../common/messaging/protocol"
import type { TeamAgentPolicy } from "../../common/team"
import { currentTeamPolicy, currentTeamState } from "../../common/team-policy"
import { kebabToSentence } from "../../common/text"
import {
  ChatCompletionMessage,
  MentionType,
  ReplyChangesView,
  TwinnyProvider
} from "../../common/types"
import type { ChatEditMode } from "../edit/service"
import { WorkspaceSearch } from "../embeddings/search"
import { GenerationTracker } from "../generations"
import { isCancelled, readText, resolveInferenceProvider } from "../inference"
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
import { DEFAULT_MAX_STEPS, ToolLoopUsage, toolModeFor, withTools } from "../tools/loop"
import type { McpToolSpec } from "../tools/mcp"
import { WorkspaceView } from "../tools/view"
import { WorkspaceTools, workspaceTools } from "../tools/workspace"
import { getLanguage } from "../utils"

import { ChatContextBuilder } from "./context"
import { ContextEntry, formatContextEntries } from "./context-files"
import { ChatGeneration } from "./generation"
import { McpHost } from "./mcp-host"
import { ChangeStore, ReplyChanges, viewOf } from "./reply-changes"
import { ReplyChangesEditor } from "./reply-changes-editor"
import {
  ChatCommandMode,
  ChatCommandPlace,
  editorEdits,
  editorHint,
  editorKnowledge,
  indexSearch,
  normalCommand,
  openDocumentText,
  terminalCommands
} from "./tool-sinks"
import { ToolSteps } from "./tool-steps"
import { buildChatTurn } from "./turn"

/** Templates whose answer benefits from `@workspace`-style lookups. */
const TEMPLATES_WITH_RAG = ["explain"]
/** Room for a sentence of the composer's grey text, and no more. */
const SUGGESTION_MAX_TOKENS = 32
/** Whether the team's rules leave the developer's MCP servers to agent mode. */
const mcpAllowed = (team: TeamAgentPolicy | undefined) => team?.commands !== "off" && team?.mcp !== "off"

/** How long an agent reply waits for the team's policy to be re-read. */
const POLICY_REFRESH_WAIT_MS = 1500
/** The steps an agent reply may take, as `twinny.chatToolsMaxSteps` may set them. */
const MIN_STEPS_SETTING = 4
const MAX_STEPS_SETTING = 40

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
  private _suggestion?: AbortController
  private readonly _bridge: ExtensionBridge
  private readonly _context: ChatContextBuilder
  private readonly _generation: ChatGeneration
  private readonly _search: WorkspaceSearch | undefined
  private readonly _steps: ToolSteps
  private readonly _stopSubscription: { dispose(): void }
  /** What agent replies changed, kept so each can be compared or undone from the chat. */
  private _changes?: { store: ChangeStore; editor: ReplyChangesEditor }
  /** The MCP servers in the user's settings, running for this chat. */
  private readonly _mcp = new McpHost(
    () => this.config.get<Record<string, unknown>>("chatToolsMcpServers", {}),
    () => this.workspaceRoot()
  )
  /** A typed message's context is being gathered; its reply has not started. */
  private _preparing = false
  /** Aborted when this chat goes: the commands it started end with it. */
  private readonly _lifetime = new AbortController()

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

  /**
   * Run, Always run or Skip, on a command waiting in the tool steps.
   * Always run keeps that exact command, to run unasked from then on.
   */
  public answerToolApproval(id: string, run: boolean, always = false) {
    const step = this._steps.steps.find((s) => s.id === id)
    if (run && always && step?.approval === "command" && step.command && !currentTeamPolicy()?.agent?.commands) {
      // An MCP tool is kept by name: its arguments differ from call to call.
      const list = step.mcpTool ? GLOBAL_STORAGE_KEY.alwaysRunMcpTools : GLOBAL_STORAGE_KEY.alwaysRunCommands
      const key = `${EVENT_NAME.twinnyGlobalContext}-${list}`
      const kept = this.context?.globalState.get<string[]>(key) ?? []
      const entry = step.mcpTool ?? normalCommand(step.command)
      if (!kept.includes(entry)) void this.context?.globalState.update(key, [...kept, entry])
    }
    this._steps.answer(id, run)
  }

  /**
   * Whether a call to an MCP tool may go ahead: asked in the steps, unless
   * the user chose Always run for that tool (and the team does not ask for
   * every command).
   */
  private approveMcp(detail: string, tool: McpToolSpec): Promise<boolean> {
    const team = currentTeamPolicy()?.agent?.commands
    const name = `${tool.server}/${tool.tool}`
    const kept = this.context?.globalState.get<string[]>(
      `${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.alwaysRunMcpTools}`
    )
    if (!team && kept?.includes(name)) return Promise.resolve(true)
    return this._steps.approve(detail, "command", { always: !team, mcpTool: name })
  }

  /** Whether a reply is being written now. */
  public get replying(): boolean {
    return this._generation.running || this._preparing
  }

  /**
   * Stop the reply and keep none of it, nor its steps: the user started a
   * new conversation or opened another one while it was being written, or
   * while its context was still being gathered (then it never starts).
   */
  public discardReply() {
    if (!this.replying) return
    this._steps.discard()
    this._generation.discard()
  }

  /**
   * Where what agent replies changed is kept: the workspace's storage,
   * made on first use.
   */
  private changes() {
    if (!this._changes) {
      const storage = (this.context?.storageUri ?? this.context?.globalStorageUri)?.fsPath ?? os.tmpdir()
      const store = new ChangeStore(path.join(storage, "agent-changes"))
      this._changes = { store, editor: new ReplyChangesEditor(store, openDocumentText) }
    }
    return this._changes
  }

  /** A file a reply changed, beside what it was before. */
  public openChange(id: string, file: string) {
    return this.changes().editor.openDiff(id, file)
  }

  /** Put a reply's changed files (all, or `paths`) back as they were. */
  public undoChanges(id: string, paths?: string[]) {
    return this.changes().editor.undo(id, paths)
  }

  /** The stop button on a running command: ends it, and the reply carries on. */
  public stopToolStep(id: string) {
    this._steps.stop(id)
  }

  public dispose() {
    super.dispose()
    this._stopSubscription.dispose()
    this._steps.cancelWaiting()
    this._lifetime.abort()
    this._mcp.dispose()
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
    // Gathering context can take a while (a workspace search, the team's
    // policy); a conversation left meanwhile stops this reply too.
    this._preparing = true
    let view: WorkspaceView | undefined
    try {
      // Asked on the developer's own switch, so a team that turns agent mode
      // back on is heard from too.
      if (this.ownAgentMode()) await this.freshTeamPolicy()
      view = this.toolsView()
      // The user's MCP servers, started (or restarted) for an agent reply.
      if (view && this._mcp.configured && mcpAllowed(currentTeamPolicy()?.agent)) await this._mcp.ready()
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
    } finally {
      this._preparing = false
    }
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

  /**
   * The rest of the message the user is typing, as the model guesses it
   * from the last few turns, for the composer's grey text. A newer call
   * cancels the one before; any failure is just no guess.
   */
  public async suggestDraft(draft: string, recent: ComposerTurn[]): Promise<string> {
    this._suggestion?.abort()
    const provider = this.getProvider()
    if (!provider || !draft.trim()) return ""
    const controller = new AbortController()
    this._suggestion = controller

    try {
      const reply = await readText(
        resolveInferenceProvider(provider).chat(
          {
            model: provider.modelName,
            messages: composerSuggestionMessages(draft, recent),
            maxTokens: SUGGESTION_MAX_TOKENS,
            temperature: 0,
            think: false
          },
          { signal: controller.signal }
        )
      )
      if (controller.signal.aborted) return ""
      return cleanModelSuggestion(draft, stripThinking(reply))
    } catch (error) {
      if (!isCancelled(error)) {
        logger.debug(`Composer suggestion failed: ${describeProviderError(error, provider)}`)
      }
      return ""
    } finally {
      if (this._suggestion === controller) this._suggestion = undefined
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Internals                                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * Re-reads the team's policy (at most once a minute, by the provider
   * manager), so an admin's change to the agent rules holds from the next
   * agent reply rather than the next VS Code start. A slow gateway is not
   * waited on for long: what was agreed holds meanwhile.
   */
  public refreshTeamPolicy?: () => Promise<void>

  private async freshTeamPolicy() {
    if (!this.refreshTeamPolicy || !currentTeamState()) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      this.refreshTeamPolicy().catch(() => undefined),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, POLICY_REFRESH_WAIT_MS)))
    ])
    clearTimeout(timer)
  }

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
    return !currentTeamPolicy()?.agent?.off && this.ownAgentMode()
  }

  /** The developer's own switch, whatever their team's rules say. */
  private ownAgentMode(): boolean {
    const stored = this.context?.globalState.get<boolean>(
      `${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.agentMode}`
    )
    return stored ?? this.config.get<boolean>("chatTools", false)
  }

  /**
   * Whether a command asks first: not when the composer's auto-run switch
   * is on (until it is first switched, `twinny.chatToolsCommands`), nor
   * when the user chose Always run for that exact command. Read for each
   * command, so either holds for the rest of the reply.
   */
  private commandMode(setting: ChatCommandMode, command: string): "ask" | "allow" {
    // A team that asks for every command is asked for every command.
    if (currentTeamPolicy()?.agent?.commands) return "ask"
    const state = this.context?.globalState
    const stored = state?.get<boolean>(`${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.autoRunCommands}`)
    if (stored ?? setting === "allow") return "allow"
    const kept = state?.get<string[]>(`${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.alwaysRunCommands}`)
    return kept?.includes(normalCommand(command)) ? "allow" : "ask"
  }

  /** The folder agent mode works in: the first workspace folder. */
  protected workspaceRoot(): string | undefined {
    return workspace.workspaceFolders?.[0]?.uri.fsPath
  }

  /**
   * The workspace as the tools will see it, when the user has tools on
   * and a folder open. Made once per reply: its ignore rules are read at
   * the start and hold until the end.
   */
  private toolsView(): WorkspaceView | undefined {
    if (!this.agentMode()) return undefined
    const root = this.workspaceRoot()
    if (!root) return undefined
    return new WorkspaceView(
      root,
      this.config.get<string[]>("embeddingIgnoredGlobs", []),
      openDocumentText,
      currentTeamPolicy()?.agent?.blockedPaths ?? []
    )
  }

  /**
   * Send the conversation; the reply joins it, so the next turn follows on.
   * With a `view`, the model may work in the workspace first.
   */
  private async run(provider: TwinnyProvider, prefix = "", view?: WorkspaceView) {
    let toolNotes: string | undefined
    let instructionFiles = (): string[] => []
    let tracked: ReplyChanges | undefined
    let changed: ReplyChangesView | undefined
    const usage: ToolLoopUsage = {}
    // Asked now, so the reply can say how much of the context it used.
    void contextWindowOf(provider)
    const reply = await this._generation.generate(
      view
        ? this.toolsClient(provider, view, {
            onNotes: (notes) => (toolNotes = notes),
            onUsage: (counted) => Object.assign(usage, counted),
            onTools: (tools) => (instructionFiles = () => tools.instructionFiles?.() ?? []),
            onChanges: (changes) => (tracked = changes)
          })
        : resolveInferenceProvider(provider),
      { model: provider.modelName, messages: this._conversation },
      provider,
      prefix,
      {
        toolNotes: () => toolNotes,
        keepEmpty: () => !!view && this._steps.steps.length > 0,
        // What the reply changed, read once it is over and kept for undo.
        settle: async () => {
          if (!tracked?.touched) return
          const record = await tracked.record()
          if (!record) return
          try {
            this.changes().store.save(record)
            changed = viewOf(record)
          } catch (error) {
            logger.warn(`Chat · could not keep what the reply changed: ${error}`)
          }
        },
        changes: () => changed,
        meta: () => {
          const contextWindow = knownContextWindow(provider)
          const instructions = instructionFiles()
          return {
            ...(instructions.length ? { instructions } : {}),
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
    hooks: {
      onNotes(notes: string | undefined): void
      onUsage(usage: ToolLoopUsage): void
      onTools(tools: WorkspaceTools): void
      onChanges(changes: ReplyChanges): void
    }
  ) {
    this._steps.reset()
    // The team's rules only ever tighten what the developer set.
    const team = currentTeamPolicy()?.agent
    const commandMode = team?.commands === "off" ? "off" : this.config.get<ChatCommandMode>("chatToolsCommands", "ask")
    const editMode = team?.edits === "review" ? "review" : this.config.get<ChatEditMode>("chatToolsEdits", "apply")
    const changes = new ReplyChanges(view.root, openDocumentText)
    hooks.onChanges(changes)
    const approveChange = (detail: string, approval: "command" | "change") =>
      this._steps.approve(detail, approval)
    const search = this._search
    const available = workspaceTools(view, [], {
      edits: editorEdits(view, editMode, approveChange, changes),
      editor: editorKnowledge(view, editMode, approveChange, changes),
      commands:
        commandMode === "off"
          ? undefined
          : terminalCommands(
              (command) => this.commandMode(commandMode, command),
              view.root,
              (command) => this._steps.approve(command, "command", { always: !team?.commands }),
              {
                place: this.config.get<ChatCommandPlace>("chatToolsCommandsRunIn", "background"),
                onOutput: (output) => this._steps.progress(output),
                onStart: (stop) => this._steps.stoppable(stop),
                lifetime: this._lifetime.signal,
                changes,
                visible: (file) => view.visible(file)
              }
            ),
      codeSearch: search?.available
        ? indexSearch(search, () =>
            Number(
              this.context?.globalState.get(
                `${EVENT_NAME.twinnyGlobalContext}-${EXTENSION_CONTEXT_NAME.twinnyRerankThreshold}`
              )
            )
          )
        : undefined,
      // A team that takes commands away takes MCP servers too: neither can be undone.
      mcp: !mcpAllowed(team) || !this._mcp.tools.length ? undefined : this._mcp.sink((detail, tool) => this.approveMcp(detail, tool))
    })
    hooks.onTools(available)
    let warned = false
    return withTools(resolveInferenceProvider(provider), available, {
      mode: toolModeFor(provider.provider),
      maxSteps: Math.min(MAX_STEPS_SETTING, Math.max(MIN_STEPS_SETTING, this.config.get<number>("chatToolsMaxSteps", DEFAULT_MAX_STEPS) || DEFAULT_MAX_STEPS)),
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

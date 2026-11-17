import {
  CancellationToken,
  Disposable,
  EndOfLine,
  ExtensionContext,
  InlineCompletionContext,
  InlineCompletionItem,
  InlineCompletionItemProvider,
  InlineCompletionTriggerKind,
  Position,
  Range,
  SelectedCompletionInfo,
  TextDocument,
  Uri,
  window,
  workspace
} from "vscode"
import { SyntaxNode } from "web-tree-sitter"

import {
  FIM_CONTEXT_WINDOW_LINES,
  FIM_MAX_CONTEXT_CHARS,
  FIM_MAX_CONTEXT_FILES,
  FIM_STREAM_TIMEOUT_MS,
  FIM_TEMPLATE_FORMAT
} from "../../common/constants"
import { supportedLanguages } from "../../common/languages"
import { formatCount, logger } from "../../common/logger"
import {
  FimContextFile,
  FimTemplateData,
  PrefixSuffix
} from "../../common/types"
import { GenerationRun, GenerationTracker } from "../generations"
import {
  FimRequest,
  FimStructuredContext,
  isCancelled,
  resolveInferenceProvider
} from "../inference"
import { Base } from "../providers/base"
import { describeProviderErrorPlain } from "../providers/errors"
import { TwinnyProvider } from "../providers/manager"
import { TemplateProvider } from "../templates/provider"
import {
  getIsMiddleOfWord,
  getPrefixSuffix,
  getShouldUseMultiline,
  notifyKnownErrors,
  sanitizeWorkspaceName
} from "../utils"

import { cache, getSuggestionContinuation, LastSuggestion } from "./cache"
import { DefinitionContext, TOTAL_CHARS as DEFINITION_CHARS } from "./definitions"
import { FileInteractionCache } from "./file-interaction"
import {
  getFimChat,
  getFimPrompt,
  getFimTemplateRepositoryLevel,
  getStopWords,
  isChatFimFormat,
  renderChatML
} from "./fim-templates"
import { CompletionFormatter } from "./formatter"
import { getImportedFiles } from "./imports"
import { LspContext } from "./lsp-context"
import { getNodeAtPosition, getParser } from "./parser"
import { prefetchProgress, textToNextLine } from "./prefetch"
import { RecentEdits } from "./recent-edits"
import { HeldDefinitions, StableOrder } from "./stable-context"
import { CompletionStream } from "./stream"
import { ModelWarmer, shouldWarm } from "./warm-up"

/** Everything one inline-completion request needs, kept off the instance. */
interface CompletionRequest {
  id: number
  version: number
  scope: string
  cacheScope: string
  document: TextDocument
  position: Position
  prefixSuffix: PrefixSuffix
  /** The current line up to the cursor and after it, as the model should see them. */
  lineBefore: string
  lineAfter: string
  /**
   * The unfinished word at the cursor, for models that fill the hole as a
   * chat turn: they cannot continue a fragment, so the prompt ends before
   * it and the answer must begin with it. Empty otherwise.
   */
  wordFragment: string
  /**
   * Set while the suggest widget is open: VS Code only shows a completion
   * that begins with the item it highlights, so the request is made as if
   * that item were already accepted and the result is returned with it.
   */
  selected?: SelectedCompletionInfo
  provider: TwinnyProvider
  token: CancellationToken
}

/** Where a suggestion was shown and what it was made from: enough to ask for the one after it. */
interface Shown {
  id: number
  document: TextDocument
  scope: string
  provider: TwinnyProvider
  prefixSuffix: PrefixSuffix
  lineBefore: string
  lineAfter: string
  selected?: SelectedCompletionInfo
  contextFiles: FimContextFile[]
}

/** The completion for the line after the suggestion on screen, asked for ahead of the user. */
interface Prefetch {
  document: TextDocument
  scope: string
  /** The document around the cursor when the suggestion showed. */
  origin: PrefixSuffix
  /** What the document gains on the way to where this was made for. */
  added: string
  contextFiles: FimContextFile[]
  abort: AbortController
  /** The model's raw completion; empty when it had nothing or was stopped. */
  result: Promise<string>
}

/** Editors that are not code: output panes, search results, terminals. */
const IGNORED_SCHEMES = new Set([
  "output",
  "search-editor",
  "vscode-terminal",
  "comment"
])

export class CompletionProvider
  extends Base
  implements InlineCompletionItemProvider
{
  private _run: GenerationRun | null = null
  private _acceptedLastCompletion = false
  private _definitions = new DefinitionContext()
  private _fileInteractionCache: FileInteractionCache
  private _lastSuggestion: LastSuggestion | undefined
  private _lspContext = new LspContext()
  private _recentEdits = new RecentEdits()
  private _contextOrder = new StableOrder()
  private _heldDefinitions = new HeldDefinitions()
  private _prefetch: Prefetch | undefined
  private _requestId = 0
  private _generations: GenerationTracker
  private _templateProvider: TemplateProvider
  private _warmer = new ModelWarmer(
    () => this.getFimProvider(),
    () => this.config.get<string>("keepAlive")
  )
  private _windowState: Disposable
  public lastCompletionText = ""

  constructor(
    generations: GenerationTracker,
    fileInteractionCache: FileInteractionCache,
    templateProvider: TemplateProvider,
    context: ExtensionContext
  ) {
    super(context)
    this._generations = generations
    this._fileInteractionCache = fileInteractionCache
    this._templateProvider = templateProvider
    this._windowState = window.onDidChangeWindowState((state) => {
      if (state.focused) this.warmModel("window focused")
    })
  }

  /** Loads the completion model ahead of the first keystroke, if it is set to. */
  public warmModel(reason: string) {
    if (!this.config.get<boolean>("enabled", true)) return
    if (!this.config.get<boolean>("warmUpModel", true)) return
    void this._warmer.warm(reason)
  }

  public dispose() {
    super.dispose()
    this._windowState.dispose()
    this._recentEdits.dispose()
    this.dropPrefetch()
  }

  public async provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    context: InlineCompletionContext,
    token: CancellationToken
  ): Promise<InlineCompletionItem[] | undefined> {
    // Not an editor the user types in, so it must not stop the request in
    // flight for one. The Output panel showing twinny's own log is such a
    // document: each debug line written mid-request asked again and
    // aborted it (#559).
    if (IGNORED_SCHEMES.has(document.uri.scheme)) return
    // Invalidate even when this invocation returns early or uses the cache.
    this.abortCompletion()
    if (token.isCancellationRequested) return
    const provider = this.getFimProvider()
    if (!this.config.get<boolean>("enabled", true) || !provider) return

    if (!this.isLanguageEnabled(document.languageId)) return

    const isManualTrigger =
      context.triggerKind === InlineCompletionTriggerKind.Invoke
    if (!isManualTrigger && !this.config.get<boolean>("autoSuggestEnabled")) {
      return
    }

    const version = document.version
    let prefixSuffix = getPrefixSuffix(
      this.config.get<number>("contextLength", 100),
      document,
      position
    )
    const lineText = document.lineAt(position.line).text
    let lineBefore = lineText.slice(0, position.character)
    let lineAfter = lineText.slice(position.character)
    const selected = context.selectedCompletionInfo
    if (selected) {
      // IntelliSense is open. VS Code cancelled the plain request when the
      // widget appeared and asks again with the highlighted item; answering
      // as if that item were typed is the only way a completion shows now.
      const typed = Math.max(0, position.character - selected.range.start.character)
      const trailing = Math.max(0, selected.range.end.character - position.character)
      prefixSuffix = {
        prefix: prefixSuffix.prefix.slice(0, prefixSuffix.prefix.length - typed) + selected.text,
        suffix: prefixSuffix.suffix.slice(trailing)
      }
      lineBefore = lineText.slice(0, selected.range.start.character) + selected.text
      lineAfter = lineText.slice(selected.range.end.character)
    }

    const scope = JSON.stringify([
      document.uri.toString(), document.languageId,
      provider.id, provider.modelName, provider.provider,
      provider.apiProtocol, provider.apiHostname, provider.apiPort, provider.apiPath,
      provider.fimTemplate, provider.repositoryLevel,
      this.config.get("lspContextEnabled", true),
      this.config.get("fileContextEnabled", false),
      this.config.get("multilineCompletionsEnabled", true),
      this.config.get("maxLines", 40),
      this.config.get("numPredictFim", 512),
      this.config.get("temperature", 0.2)
    ])
    const cacheScope = JSON.stringify([scope, document.version])
    const continuation = getSuggestionContinuation(
      this._lastSuggestion,
      prefixSuffix,
      scope
    )
    if (continuation) {
      logger.debug("FIM served from the previous suggestion (typed through)")
      return this.toInlineCompletion(continuation, position, selected)
    }

    if (this.config.get<boolean>("completionCacheEnabled")) {
      const cached = cache.getCache(prefixSuffix, cacheScope)
      if (cached) {
        logger.debug("FIM served from the completion cache")
        return this.toInlineCompletion(cached, position, selected)
      }
    }

    if (
      this._acceptedLastCompletion &&
      !this.config.get<boolean>("enableSubsequentCompletions", true)
    ) {
      return
    }

    const ahead = selected ? undefined : this.prefetchFor(document, prefixSuffix, scope)
    if (ahead) {
      const id = this._requestId
      const waited = logger.timer()
      const raw = await ahead.result
      if (id !== this._requestId || token.isCancellationRequested || document.version !== version) return
      if (this._prefetch === ahead) this._prefetch = undefined
      const formatted = raw && this.format(raw, document, position)
      if (formatted) {
        logger.info(`FIM #${id} served from the prefetch · waited ${waited()} · ${formatted.length} chars`)
        return this.show(formatted, {
          id, document, scope, provider, prefixSuffix, lineBefore, lineAfter,
          contextFiles: ahead.contextFiles
        }, cacheScope, position)
      }
      logger.debug(`FIM #${id} prefetch had nothing usable; asking afresh`)
    }

    // Mid-word the model would only finish the word; with the widget open
    // the highlighted item already does that and the request starts after it.
    if (!selected && getIsMiddleOfWord(document, position)) return

    const request: CompletionRequest = {
      id: this._requestId,
      version,
      scope,
      cacheScope,
      document,
      position,
      prefixSuffix,
      lineBefore,
      lineAfter,
      wordFragment: isChatFimFormat(provider.modelName, provider.fimTemplate)
        ? (lineBefore.match(/[\w$]+$/)?.[0] ?? "")
        : "",
      selected,
      provider,
      token
    }

    if (!isManualTrigger) {
      await this.debounce(this.config.get<number>("debounceWait", 300))
      if (this.isStale(request)) return
    }

    return this.complete(request)
  }

  private isLanguageEnabled(languageId: string) {
    const enabledLanguages = this.config.get<Record<string, boolean>>(
      "enabledLanguages",
      {}
    )
    return enabledLanguages[languageId] ?? enabledLanguages["*"] ?? true
  }

  private debounce(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms))
  }

  private isStale(request: CompletionRequest) {
    return request.id !== this._requestId || request.token.isCancellationRequested ||
      request.document.version !== request.version
  }

  /** One request, as one run on the tracker: however it ends, the run ends. */
  private async complete(request: CompletionRequest) {
    const run = this._generations.start("completion")
    this._run = run
    try {
      return await this.completeWith(request, run)
    } finally {
      run.finish()
      if (this._run === run) this._run = null
    }
  }

  private async completeWith(
    request: CompletionRequest,
    run: GenerationRun
  ): Promise<InlineCompletionItem[] | undefined> {
    const { document, position, prefixSuffix, provider, token } = request

    const elapsed = logger.timer()
    const where = `${workspace.asRelativePath(document.uri)}:${position.line + 1}`

    if (this.isStale(request)) return
    const [node, prepared] = await Promise.all([
      this.getNodeAtCursor(document, position),
      this.getPrompt(request)
    ])
    if (!prepared || this.isStale(request)) return
    const { prompt, context, contextFiles } = prepared
    // This request needs the model now; an answer being made for
    // somewhere the user did not go must not hold it up.
    if (this._prefetch && !this.onTheWay(this._prefetch, document, prefixSuffix, request.scope)) {
      this.dropPrefetch()
    }
    logger.info(
      `FIM #${request.id} → ${provider.modelName} · ${where} · ` +
        `prompt ${formatCount(prompt.length)} chars`
    )

    const stopWords = getStopWords(provider.modelName, provider.fimTemplate)
    const multiline = getShouldUseMultiline({
      document,
      position,
      node,
      multilineEnabled: this.config.get<boolean>(
        "multilineCompletionsEnabled",
        true
      )
    })
    const stream = new CompletionStream({
      stopWords,
      multiline,
      maxLines: this.config.get<number>("maxLines", 40),
      textBeforeCursor: request.lineBefore,
      textAfterCursor: request.lineAfter,
      suffixFirstLine: this.getFirstNonBlankLine(prefixSuffix.suffix),
      unwrapFences: isChatFimFormat(provider.modelName, provider.fimTemplate),
      wordFragment: request.wordFragment
    })

    const inference = resolveInferenceProvider(provider)
    this._warmer.touch(provider)
    // Why the request was stopped, when it was: a timeout keeps what has
    // arrived, the editor moving on wants nothing.
    let stoppedBy: "timeout" | "editor" | undefined
    const timeout = setTimeout(() => {
      logger.warn(
        `FIM #${request.id} gave up after ${FIM_STREAM_TIMEOUT_MS / 1000}s; ` +
          `keeping the ${stream.value.length} chars received`
      )
      stoppedBy = "timeout"
      run.abort()
    }, FIM_STREAM_TIMEOUT_MS)
    const cancellation = token.onCancellationRequested(() => {
      logger.debug(`FIM #${request.id} cancelled by the editor after ${elapsed()}`)
      stoppedBy = "editor"
      run.abort()
    })

    let completion = ""
    // Whether the backend finished on its own. Stopping early (enough
    // lines, reached the suffix) is normal and aborts to free the GPU; a
    // stream that ended by itself must not be reported as cancelled.
    let streamEnded = false
    try {
      const chunks = inference.fim(
        this.buildFimRequest(
          prompt,
          provider,
          stopWords,
          prefixSuffix,
          request.wordFragment,
          context
        ),
        { signal: run.signal }
      )
      let stoppedEarly = false
      for await (const chunk of chunks) {
        if (stream.push(chunk.text).done) {
          stoppedEarly = true
          break
        }
      }
      streamEnded = !stoppedEarly
      completion = stream.finish()
    } catch (error) {
      if (isCancelled(error)) {
        completion = stoppedBy === "timeout" ? stream.finish() : ""
      } else {
        logger.error(
          `FIM #${request.id} failed: ${describeProviderErrorPlain(error, provider)}`
        )
        if (error instanceof Error) notifyKnownErrors(error)
      }
    } finally {
      clearTimeout(timeout)
      cancellation.dispose()
      if (!streamEnded) run.abort()
    }

    const outcome = (what: string) =>
      `FIM #${request.id} ← ${elapsed()} · ${what}` +
      (stream.stoppedBy ? ` · ended by ${stream.stoppedBy}` : "")

    if (this.isStale(request)) {
      logger.debug(outcome("dropped, the document moved on"))
      return
    }
    if (!completion) {
      logger.info(outcome("nothing usable"))
      return
    }

    if (window.activeTextEditor?.document !== document) {
      logger.debug(outcome("dropped, editor changed"))
      return
    }

    const formatted = this.format(completion, document, position)

    const lines = formatted.split("\n").length
    logger.info(
      outcome(
        formatted
          ? `${formatted.length} chars, ${lines} line${lines === 1 ? "" : "s"}${multiline ? "" : " (single-line mode)"}`
          : `formatter discarded ${completion.length} chars`
      )
    )
    logger.block(`FIM #${request.id} raw`, completion)
    if (formatted && formatted !== completion) {
      logger.block(`FIM #${request.id} formatted`, formatted)
    }

    if (!formatted) return

    return this.show(formatted, {
      id: request.id,
      document,
      scope: request.scope,
      provider,
      prefixSuffix,
      lineBefore: request.lineBefore,
      lineAfter: request.lineAfter,
      selected: request.selected,
      contextFiles
    }, request.cacheScope, position)
  }

  /** A raw completion fitted to the text around the cursor; empty when nothing of it is worth showing. */
  private format(completion: string, document: TextDocument, position: Position) {
    const editor = window.activeTextEditor
    if (!editor || editor.document !== document) return ""
    return new CompletionFormatter(editor, position).format(completion)
  }

  /** Hands a suggestion to the editor, remembers it for typing through, and asks for the one after it. */
  private show(formatted: string, shown: Shown, cacheScope: string, position: Position) {
    if (this.config.get<boolean>("completionCacheEnabled")) {
      cache.setCache(shown.prefixSuffix, formatted, cacheScope)
    }
    this._lastSuggestion = { ...shown.prefixSuffix, completion: formatted, scope: shown.scope }
    this.prefetchAfter(shown, formatted)
    return this.toInlineCompletion(formatted, position, shown.selected)
  }

  /**
   * Whether the completion for the next line is worth asking for ahead of
   * the user. Only of a model on this machine or this network, whose idle
   * time is free: a hosted API bills the request, and a team's gateway
   * would spend a shared GPU on answers most of which are never used.
   */
  private prefetches(shown: Shown) {
    return (
      this.config.get<boolean>("prefetchNextCompletion", true) &&
      this.config.get<boolean>("enableSubsequentCompletions", true) &&
      shouldWarm(shown.provider) &&
      !shown.selected &&
      // Text after the cursor stays on the line when Enter is pressed.
      shown.lineAfter === ""
    )
  }

  private prefetchAfter(shown: Shown, formatted: string) {
    const { document, prefixSuffix } = shown
    // A suggestion shown part of the way to the line a prefetch was made
    // for (just after the last one was accepted, say) does not replace
    // it: Enter is still the likelier next key.
    const standing = this._prefetch
    if (
      standing &&
      standing.document === document &&
      standing.scope === shown.scope &&
      (prefetchProgress(standing.origin, standing.added, prefixSuffix) ?? 0) > 0
    ) {
      return
    }
    this.dropPrefetch()
    if (!this.prefetches(shown)) return
    const options = window.activeTextEditor?.document === document ? window.activeTextEditor.options : undefined
    const indentUnit = options?.insertSpaces === false ? "\t" : " ".repeat(Number(options?.tabSize) || 2)
    const added = textToNextLine(
      shown.lineBefore,
      formatted,
      indentUnit,
      document.eol === EndOfLine.CRLF ? "\r\n" : "\n"
    )
    const next: PrefixSuffix = { prefix: prefixSuffix.prefix + added, suffix: prefixSuffix.suffix }
    const abort = new AbortController()
    const prefetch: Prefetch = {
      document,
      scope: shown.scope,
      origin: prefixSuffix,
      added,
      contextFiles: shown.contextFiles,
      abort,
      result: this.runPrefetch(shown, next, added.slice(added.lastIndexOf("\n") + 1), abort)
    }
    this._prefetch = prefetch
  }

  /** The model's raw completion for a place the cursor is not at yet. Never throws; off the status bar. */
  private async runPrefetch(
    shown: Shown,
    prefixSuffix: PrefixSuffix,
    indent: string,
    abort: AbortController
  ): Promise<string> {
    const { document, provider } = shown
    const elapsed = logger.timer()
    const timeout = setTimeout(() => abort.abort(), FIM_STREAM_TIMEOUT_MS)
    let stream: CompletionStream | undefined
    try {
      // The same context, in the same order, as the request before: the
      // server has read all of it and most of the prefix already.
      const prepared = await this.renderPrompt(provider, document, prefixSuffix, shown.contextFiles)
      if (!prepared || abort.signal.aborted) return ""
      const stopWords = getStopWords(provider.modelName, provider.fimTemplate)
      stream = new CompletionStream({
        stopWords,
        // An empty line is where a block gets written.
        multiline: this.config.get<boolean>("multilineCompletionsEnabled", true),
        maxLines: this.config.get<number>("maxLines", 40),
        textBeforeCursor: indent,
        textAfterCursor: "",
        suffixFirstLine: this.getFirstNonBlankLine(prefixSuffix.suffix),
        unwrapFences: isChatFimFormat(provider.modelName, provider.fimTemplate),
        wordFragment: ""
      })
      logger.debug(`FIM prefetch → ${provider.modelName} · the line after #${shown.id}`)
      this._warmer.touch(provider)
      const chunks = resolveInferenceProvider(provider).fim(
        this.buildFimRequest(prepared.prompt, provider, stopWords, prefixSuffix, "", prepared.context),
        { signal: abort.signal }
      )
      for await (const chunk of chunks) {
        if (stream.push(chunk.text).done) break
      }
      const completion = stream.finish()
      logger.debug(`FIM prefetch ← ${elapsed()} · ${completion.length} chars`)
      return completion
    } catch (error) {
      if (!isCancelled(error)) {
        logger.debug(`FIM prefetch failed: ${describeProviderErrorPlain(error, provider)}`)
      }
      return ""
    } finally {
      clearTimeout(timeout)
      // Stopped early or not, the server is told to stop generating.
      abort.abort()
    }
  }

  /** Whether the document is at, or still on the way to, the place a prefetch was made for. */
  private onTheWay(prefetch: Prefetch, document: TextDocument, current: PrefixSuffix, scope?: string) {
    if (prefetch.document !== document) return false
    if (scope !== undefined && prefetch.scope !== scope) return false
    return prefetchProgress(prefetch.origin, prefetch.added, current) !== undefined
  }

  /** The prefetch made for exactly this place, if there is one. */
  private prefetchFor(document: TextDocument, current: PrefixSuffix, scope: string) {
    const prefetch = this._prefetch
    if (!prefetch || prefetch.document !== document || prefetch.scope !== scope) return undefined
    return prefetchProgress(prefetch.origin, prefetch.added, current) === prefetch.added.length
      ? prefetch
      : undefined
  }

  private dropPrefetch() {
    this._prefetch?.abort.abort()
    this._prefetch = undefined
  }

  /**
   * The item VS Code shows. With the suggest widget open it must begin
   * with the highlighted suggestion and replace that suggestion's range;
   * VS Code hides anything else.
   */
  private toInlineCompletion(
    text: string,
    position: Position,
    selected?: SelectedCompletionInfo
  ) {
    this.lastCompletionText = text
    if (selected) {
      return [new InlineCompletionItem(selected.text + text, selected.range)]
    }
    return [new InlineCompletionItem(text, new Range(position, position))]
  }

  private getFirstNonBlankLine(text: string) {
    return (
      text
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0) || ""
    )
  }

  private async getNodeAtCursor(
    document: TextDocument,
    position: Position
  ): Promise<SyntaxNode | null> {
    try {
      const parser = await getParser(document.uri.fsPath)
      if (!parser) return null
      return getNodeAtPosition(parser.parse(document.getText()), position)
    } catch {
      return null
    }
  }

  /** What is asked of the model, in terms no provider can tell apart. */
  private buildFimRequest(
    prompt: string,
    provider: TwinnyProvider,
    stopWords: string[],
    prefixSuffix: PrefixSuffix,
    wordFragment = "",
    context?: FimStructuredContext
  ): FimRequest {
    const messages = getFimChat(
      provider.modelName,
      provider.fimTemplate,
      prompt,
      wordFragment
    )
    return {
      model: provider.modelName,
      prompt: messages ? renderChatML(messages) : prompt,
      messages,
      prefix: prefixSuffix.prefix,
      suffix: prefixSuffix.suffix,
      context,
      stop: stopWords,
      maxTokens: this.config.get<number>("numPredictFim", 512),
      temperature: this.config.get<number>("temperature", 0.2),
      keepAlive: this.config.get<string>("keepAlive")
    }
  }

  private getPromptHeader(languageId: string, uri: Uri) {
    const lang = supportedLanguages[languageId as keyof typeof supportedLanguages]
    if (!lang) return ""

    const start = lang.syntaxComments?.start || ""
    const end = lang.syntaxComments?.end || ""
    const language = `${start} Language: ${lang.langName} (${languageId}) ${end}`
    const filePath = `${start} Path: ${workspace.asRelativePath(uri)} ${end}`
    return `${language}\n${filePath}\n`
  }

  /**
   * Files worth showing the model before the current one: what this file
   * imports first (that is where the symbols being used are declared), then
   * the most relevant recently-used files, windowed around the lines the user
   * touched. Capped by a character budget so the prompt stays small.
   */
  private async getContextFiles(
    currentDocument: TextDocument
  ): Promise<FimContextFile[]> {
    this._fileInteractionCache.addOpenFilesWithPriority()
    const halfWindow = Math.floor(FIM_CONTEXT_WINDOW_LINES / 2)

    const candidates: { path: string; focusLine: number }[] = getImportedFiles(
      currentDocument
    ).map((path) => ({ path, focusLine: halfWindow }))

    for (const interaction of this._fileInteractionCache.getAll()) {
      const filePath = interaction.name
      if (!filePath || candidates.some((c) => c.path === filePath)) continue
      const activeLines = interaction.activeLines
      const focusLine = activeLines.length
        ? Math.round(
            activeLines.reduce((sum, { line }) => sum + line, 0) /
              activeLines.length
          )
        : 0
      candidates.push({ path: filePath, focusLine })
    }

    const files: FimContextFile[] = []
    let budget = FIM_MAX_CONTEXT_CHARS

    for (const candidate of candidates) {
      if (files.length >= FIM_MAX_CONTEXT_FILES || budget <= 0) break
      if (candidate.path === currentDocument.fileName) continue

      let document: TextDocument
      try {
        document = await workspace.openTextDocument(Uri.file(candidate.path))
      } catch {
        continue
      }

      const start = new Position(Math.max(0, candidate.focusLine - halfWindow), 0)
      const end = new Position(
        Math.min(document.lineCount, candidate.focusLine + halfWindow),
        0
      )
      const text = document.getText(new Range(start, end)).slice(0, budget)
      if (!text.trim()) continue

      budget -= text.length
      files.push({ name: workspace.asRelativePath(document.uri), text })
    }

    return files
  }

  private async getPrompt(request: CompletionRequest) {
    const { document, provider } = request
    const prefixSuffix = request.wordFragment
      ? {
          prefix: request.prefixSuffix.prefix.slice(0, -request.wordFragment.length),
          suffix: request.prefixSuffix.suffix
        }
      : request.prefixSuffix

    const wantsContext =
      this.config.get<boolean>("fileContextEnabled") || provider.repositoryLevel
    const wantsLsp = this.config.get<boolean>("lspContextEnabled", true)
    const visibleLines: [number, number] = [
      request.position.line - (prefixSuffix.prefix.split("\n").length - 1),
      request.position.line + (prefixSuffix.suffix.split("\n").length - 1)
    ]
    const [files, definitions, lspContext] = await Promise.all([
      wantsContext ? this.getContextFiles(document) : Promise.resolve([]),
      wantsLsp
        ? this._definitions.get(document, request.position, visibleLines, request.token)
        : Promise.resolve([]),
      wantsLsp
        ? this._lspContext.get(document, request.position, request.token)
        : Promise.resolve("")
    ])
    // Nearest the prefix goes last: what the model reads just before the
    // hole matters most, so the broader file windows come first, then what
    // the user just changed, then the definitions of the names being used
    // and the signature at the cursor.
    const offered = [...files]
    if (this.config.get<boolean>("recentEditsEnabled", true)) {
      const recent = this._recentEdits.get(document, request.position.line)
      if (recent) offered.push(recent)
    }
    if (wantsLsp) {
      offered.push(
        ...this._heldDefinitions.hold(request.scope, request.position.line, definitions, DEFINITION_CHARS)
      )
    }
    // Whatever was sent with the request before keeps its place, so the
    // server reads again only from the first block that is new. What the
    // language server says about the cursor changes most, and stays last.
    const contextFiles = this._contextOrder.arrange(request.scope, offered)
    if (lspContext) {
      contextFiles.push({ name: "IntelliSense context", text: lspContext })
    }

    if (contextFiles.length) {
      logger.debug(
        `FIM #${request.id} context: ` +
          contextFiles
            .map((file) => `${file.name} (${formatCount(file.text.length)})`)
            .join(", ")
      )
    }

    return this.renderPrompt(provider, document, prefixSuffix, contextFiles)
  }

  /** The prompt for a place in a document, in the model's own FIM dialect. */
  private async renderPrompt(
    provider: TwinnyProvider,
    document: TextDocument,
    prefixSuffix: PrefixSuffix,
    contextFiles: FimContextFile[]
  ): Promise<{ prompt: string; context: FimStructuredContext; contextFiles: FimContextFile[] }> {
    const languageId = document.languageId
    const fileName = workspace.asRelativePath(document.uri)
    const repoName = sanitizeWorkspaceName(workspace.name) || "untitled"
    const context: FimStructuredContext = {
      language: languageId,
      fileName,
      repoName,
      prefix: prefixSuffix.prefix,
      suffix: prefixSuffix.suffix,
      files: contextFiles
    }

    if (provider.fimTemplate === FIM_TEMPLATE_FORMAT.custom) {
      const template = await this._templateProvider.readTemplate<FimTemplateData>(
        "fim",
        {
          prefix: prefixSuffix.prefix,
          suffix: prefixSuffix.suffix,
          context: contextFiles
            .map((file) => `// File: ${file.name}\n${file.text}`)
            .join("\n\n"),
          fileName: document.uri.fsPath,
          language: languageId
        }
      )
      if (template) return { prompt: template, context, contextFiles }
    }

    const templateArgs = {
      contextFiles,
      prefixSuffix,
      header: this.getPromptHeader(languageId, document.uri),
      language: languageId,
      fileName,
      repoName
    }

    return {
      prompt: provider.repositoryLevel
        ? getFimTemplateRepositoryLevel(templateArgs, provider.modelName, provider.fimTemplate)
        : getFimPrompt(provider.modelName, provider.fimTemplate, templateArgs),
      context,
      contextFiles
    }
  }

  /** Called by the activation code once the editor has inserted a suggestion. */
  public setAcceptedLastCompletion(value: boolean) {
    this._acceptedLastCompletion = value
    if (value) this._lastSuggestion = undefined
  }

  /** The editor moved on (cursor moved, stop pressed): drop whatever is in flight. */
  public abortCompletion() {
    this._requestId++
    if (this._run) {
      logger.debug(`FIM #${this._requestId - 1} aborted: the cursor moved or generation was stopped`)
      this._run.abort()
    }
    this._run = null
    this.checkPrefetch()
  }

  /**
   * Lets go of the prefetch once the cursor is somewhere it does not lead
   * to. Accepting the suggestion moves the cursor too, and typing it out
   * changes the document: both are on the way, and keep it.
   */
  private checkPrefetch() {
    const prefetch = this._prefetch
    if (!prefetch) return
    const editor = window.activeTextEditor
    if (editor?.document !== prefetch.document) return this.dropPrefetch()
    const current = getPrefixSuffix(
      this.config.get<number>("contextLength", 100),
      editor.document,
      editor.selection.active
    )
    if (!this.onTheWay(prefetch, editor.document, current)) this.dropPrefetch()
  }
}

import {
  CancellationToken,
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
import { FimRequest, isCancelled, resolveInferenceProvider } from "../inference"
import { Base } from "../providers/base"
import { describeProviderErrorPlain } from "../providers/errors"
import { TwinnyProvider } from "../providers/manager"
import { TwinnyStatusBar } from "../status-bar"
import { TemplateProvider } from "../templates/provider"
import {
  getIsMiddleOfWord,
  getPrefixSuffix,
  getShouldUseMultiline,
  notifyKnownErrors,
  sanitizeWorkspaceName
} from "../utils"

import { cache, getSuggestionContinuation, LastSuggestion } from "./cache"
import { DefinitionContext } from "./definitions"
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
import { RecentEdits } from "./recent-edits"
import { CompletionStream } from "./stream"

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
   * Set while the suggest widget is open: VS Code only shows a completion
   * that begins with the item it highlights, so the request is made as if
   * that item were already accepted and the result is returned with it.
   */
  selected?: SelectedCompletionInfo
  provider: TwinnyProvider
  token: CancellationToken
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
  private _abortController: AbortController | null = null
  private _acceptedLastCompletion = false
  private _definitions = new DefinitionContext()
  private _fileInteractionCache: FileInteractionCache
  private _lastSuggestion: LastSuggestion | undefined
  private _lspContext = new LspContext()
  private _recentEdits = new RecentEdits()
  private _requestId = 0
  private _statusBar: TwinnyStatusBar
  private _templateProvider: TemplateProvider
  public lastCompletionText = ""

  constructor(
    statusBar: TwinnyStatusBar,
    fileInteractionCache: FileInteractionCache,
    templateProvider: TemplateProvider,
    context: ExtensionContext
  ) {
    super(context)
    this._statusBar = statusBar
    this._fileInteractionCache = fileInteractionCache
    this._templateProvider = templateProvider
  }

  public dispose() {
    super.dispose()
    this._recentEdits.dispose()
  }

  public async provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    context: InlineCompletionContext,
    token: CancellationToken
  ): Promise<InlineCompletionItem[] | undefined> {
    // Invalidate even when this invocation returns early or uses the cache.
    this.abortCompletion()
    if (token.isCancellationRequested) return
    const provider = this.getFimProvider()
    if (!this.config.get<boolean>("enabled", true) || !provider) return

    if (IGNORED_SCHEMES.has(document.uri.scheme)) return
    if (!this.isLanguageEnabled(document.languageId)) return

    const isManualTrigger =
      context.triggerKind === InlineCompletionTriggerKind.Invoke
    if (!isManualTrigger && !this.config.get<boolean>("autoSuggestEnabled")) {
      return
    }

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

    // Mid-word the model would only finish the word; with the widget open
    // the highlighted item already does that and the request starts after it.
    if (!selected && getIsMiddleOfWord(document, position)) return

    const request: CompletionRequest = {
      id: this._requestId,
      version: document.version,
      scope,
      cacheScope,
      document,
      position,
      prefixSuffix,
      lineBefore,
      lineAfter,
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

  private async complete(
    request: CompletionRequest
  ): Promise<InlineCompletionItem[] | undefined> {
    const { document, position, prefixSuffix, provider, token } = request

    this._statusBar.busy()
    const elapsed = logger.timer()
    const where = `${workspace.asRelativePath(document.uri)}:${position.line + 1}`

    if (this.isStale(request)) return
    const [node, prompt] = await Promise.all([
      this.getNodeAtCursor(document, position),
      this.getPrompt(request)
    ])
    if (!prompt || this.isStale(request)) {
      this.setIdle()
      return
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
      unwrapFences: isChatFimFormat(provider.modelName, provider.fimTemplate)
    })

    const inference = resolveInferenceProvider(provider)
    const controller = new AbortController()
    this._abortController = controller
    // Why the request was stopped, when it was: a timeout keeps what has
    // arrived, the editor moving on wants nothing.
    let stoppedBy: "timeout" | "editor" | undefined
    const timeout = setTimeout(() => {
      logger.warn(
        `FIM #${request.id} gave up after ${FIM_STREAM_TIMEOUT_MS / 1000}s; ` +
          `keeping the ${stream.value.length} chars received`
      )
      stoppedBy = "timeout"
      controller.abort()
    }, FIM_STREAM_TIMEOUT_MS)
    const cancellation = token.onCancellationRequested(() => {
      logger.debug(`FIM #${request.id} cancelled by the editor after ${elapsed()}`)
      stoppedBy = "editor"
      controller.abort()
    })

    let completion = ""
    // Whether the backend finished on its own. Stopping early (enough
    // lines, reached the suffix) is normal and aborts to free the GPU; a
    // stream that ended by itself must not be reported as cancelled.
    let streamEnded = false
    try {
      const chunks = inference.fim(
        this.buildFimRequest(prompt, provider, stopWords, prefixSuffix),
        { signal: controller.signal }
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
      if (!streamEnded) controller.abort()
      if (this._abortController === controller) this._abortController = null
    }

    const outcome = (what: string) =>
      `FIM #${request.id} ← ${elapsed()} · ${what}` +
      (stream.stoppedBy ? ` · ended by ${stream.stoppedBy}` : "")

    if (this.isStale(request)) {
      logger.debug(outcome("dropped, the document moved on"))
      this.setIdle()
      return
    }
    if (!completion) {
      logger.info(outcome("nothing usable"))
      this.setIdle()
      return
    }

    const editor = window.activeTextEditor
    if (!editor || editor.document !== document) {
      logger.debug(outcome("dropped, editor changed"))
      this.setIdle()
      return
    }

    const formatted = new CompletionFormatter(editor, position).format(
      completion
    )

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

    if (!formatted) {
      this.setIdle()
      return
    }

    if (this.config.get<boolean>("completionCacheEnabled")) {
      cache.setCache(prefixSuffix, formatted, request.cacheScope)
    }

    this._lastSuggestion = { ...prefixSuffix, completion: formatted, scope: request.scope }
    return this.toInlineCompletion(formatted, position, request.selected)
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
    this.setIdle()
    this.lastCompletionText = text
    if (selected) {
      return [new InlineCompletionItem(selected.text + text, selected.range)]
    }
    return [new InlineCompletionItem(text, new Range(position, position))]
  }

  private setIdle() {
    this._statusBar.idle()
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
    prefixSuffix: PrefixSuffix
  ): FimRequest {
    const messages = getFimChat(provider.modelName, provider.fimTemplate, prompt)
    return {
      model: provider.modelName,
      prompt: messages ? renderChatML(messages) : prompt,
      messages,
      prefix: prefixSuffix.prefix,
      suffix: prefixSuffix.suffix,
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
    const { document, prefixSuffix, provider } = request
    const languageId = document.languageId
    const fileName = workspace.asRelativePath(document.uri)

    const wantsContext =
      this.config.get<boolean>("fileContextEnabled") || provider.repositoryLevel
    const wantsLsp = this.config.get<boolean>("lspContextEnabled", true)
    const visibleLines: [number, number] = [
      request.position.line - (prefixSuffix.prefix.split("\n").length - 1),
      request.position.line + (prefixSuffix.suffix.split("\n").length - 1)
    ]
    const [contextFiles, definitions, lspContext] = await Promise.all([
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
    if (this.config.get<boolean>("recentEditsEnabled", true)) {
      const recent = this._recentEdits.get(document, request.position.line)
      if (recent) contextFiles.push(recent)
    }
    contextFiles.push(...definitions)
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

    if (provider.fimTemplate === FIM_TEMPLATE_FORMAT.custom) {
      const context = contextFiles
        .map((file) => `// File: ${file.name}\n${file.text}`)
        .join("\n\n")
      const template = await this._templateProvider.readTemplate<FimTemplateData>(
        "fim",
        {
          prefix: prefixSuffix.prefix,
          suffix: prefixSuffix.suffix,
          context,
          fileName: document.uri.fsPath,
          language: languageId
        }
      )
      if (template) return template
    }

    const templateArgs = {
      contextFiles,
      prefixSuffix,
      header: this.getPromptHeader(languageId, document.uri),
      language: languageId,
      fileName,
      repoName: sanitizeWorkspaceName(workspace.name) || "untitled"
    }

    if (provider.repositoryLevel) {
      return getFimTemplateRepositoryLevel(
        templateArgs,
        provider.modelName,
        provider.fimTemplate
      )
    }

    return getFimPrompt(provider.modelName, provider.fimTemplate, templateArgs)
  }

  /** Called by the activation code once the editor has inserted a suggestion. */
  public setAcceptedLastCompletion(value: boolean) {
    this._acceptedLastCompletion = value
    if (value) this._lastSuggestion = undefined
  }

  public onError = () => {
    this.abortCompletion()
  }

  /** The editor moved on (cursor moved, stop pressed): drop whatever is in flight. */
  public abortCompletion() {
    this._requestId++
    if (this._abortController) {
      logger.debug(`FIM #${this._requestId - 1} aborted: the cursor moved or generation was stopped`)
      this._abortController.abort()
    }
    this._abortController = null
    this.setIdle()
  }
}

import {
  CancellationToken,
  ExtensionContext,
  InlineCompletionContext,
  InlineCompletionItem,
  InlineCompletionItemProvider,
  InlineCompletionTriggerKind,
  Position,
  Range,
  StatusBarItem,
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
import { logger } from "../../common/logger"
import {
  FimContextFile,
  FimTemplateData,
  PrefixSuffix,
  StreamRequestOptions
} from "../../common/types"
import { Base } from "../base"
import { cache, getSuggestionContinuation, LastSuggestion } from "../cache"
import { CompletionFormatter } from "../completion-formatter"
import { CompletionStream } from "../completion-stream"
import { FileInteractionCache } from "../file-interaction"
import {
  getFimPrompt,
  getFimTemplateRepositoryLevel,
  getStopWords
} from "../fim-templates"
import { getImportedFiles } from "../imports"
import { llm } from "../llm"
import { getNodeAtPosition, getParser } from "../parser"
import { TwinnyProvider } from "../provider-manager"
import { createStreamRequestBodyFim } from "../provider-options"
import { TemplateProvider } from "../template-provider"
import {
  getFimDataFromProvider,
  getIsMiddleOfWord,
  getPrefixSuffix,
  getShouldUseMultiline,
  sanitizeWorkspaceName
} from "../utils"

/** Everything one inline-completion request needs, kept off the instance. */
interface CompletionRequest {
  id: number
  document: TextDocument
  position: Position
  prefixSuffix: PrefixSuffix
  provider: TwinnyProvider
  token: CancellationToken
}

const STATUS_IDLE = "$(code)"
const STATUS_BUSY = "$(loading~spin)"

export class CompletionProvider
  extends Base
  implements InlineCompletionItemProvider
{
  private _abortController: AbortController | null = null
  private _acceptedLastCompletion = false
  private _fileInteractionCache: FileInteractionCache
  private _lastSuggestion: LastSuggestion | undefined
  private _requestId = 0
  private _statusBar: StatusBarItem
  private _templateProvider: TemplateProvider
  public lastCompletionText = ""

  constructor(
    statusBar: StatusBarItem,
    fileInteractionCache: FileInteractionCache,
    templateProvider: TemplateProvider,
    context: ExtensionContext
  ) {
    super(context)
    this._statusBar = statusBar
    this._fileInteractionCache = fileInteractionCache
    this._templateProvider = templateProvider
  }

  public async provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    context: InlineCompletionContext,
    token: CancellationToken
  ): Promise<InlineCompletionItem[] | undefined> {
    const provider = this.getFimProvider()
    if (!this.config.get<boolean>("enabled", true) || !provider) return

    if (!this.isLanguageEnabled(document.languageId)) return

    const isManualTrigger =
      context.triggerKind === InlineCompletionTriggerKind.Invoke
    if (!isManualTrigger && !this.config.get<boolean>("autoSuggestEnabled")) {
      return
    }

    // Any request still running is for an older cursor position.
    this.abortCompletion()

    const prefixSuffix = getPrefixSuffix(
      this.config.get<number>("contextLength", 100),
      document,
      position
    )

    const continuation = getSuggestionContinuation(
      this._lastSuggestion,
      prefixSuffix
    )
    if (continuation) {
      return this.toInlineCompletion(continuation, position)
    }

    if (this.config.get<boolean>("completionCacheEnabled")) {
      const cached = cache.getCache(prefixSuffix)
      if (cached) return this.toInlineCompletion(cached, position)
    }

    if (
      this._acceptedLastCompletion &&
      !this.config.get<boolean>("enableSubsequentCompletions", true)
    ) {
      return
    }

    if (getIsMiddleOfWord(document, position)) return

    const request: CompletionRequest = {
      id: ++this._requestId,
      document,
      position,
      prefixSuffix,
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
    return request.id !== this._requestId || request.token.isCancellationRequested
  }

  private async complete(
    request: CompletionRequest
  ): Promise<InlineCompletionItem[] | undefined> {
    const { document, position, prefixSuffix, provider, token } = request

    this._statusBar.text = STATUS_BUSY
    this._statusBar.command = "twinny.stopGeneration"

    const node = await this.getNodeAtCursor(document, position)
    const prompt = await this.getPrompt(request)
    if (!prompt || this.isStale(request)) {
      this.setIdle()
      return
    }

    const stopWords = getStopWords(provider.modelName, provider.fimTemplate)
    const lineText = document.lineAt(position.line).text
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
      textBeforeCursor: lineText.slice(0, position.character),
      suffixFirstLine: this.getFirstNonBlankLine(prefixSuffix.suffix)
    })

    const { body, options } = this.buildFimRequest(prompt, provider, stopWords)

    const completion = await new Promise<string>((resolve) => {
      let controller: AbortController | null = null
      let settled = false
      const settle = (text: string) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        cancellation.dispose()
        resolve(text)
      }
      const timeout = setTimeout(() => {
        logger.log(`FIM request ${request.id} timed out`)
        controller?.abort()
        settle(stream.finish())
      }, FIM_STREAM_TIMEOUT_MS)
      const cancellation = token.onCancellationRequested(() => {
        controller?.abort()
        settle("")
      })

      llm({
        body,
        options,
        onStart: (abortController) => {
          controller = abortController
          this._abortController = abortController
        },
        onData: (data) => {
          const text = getFimDataFromProvider(provider.provider, data)
          if (text === undefined) return
          const { done } = stream.push(text)
          if (done) {
            controller?.abort()
            settle(stream.value)
          }
        },
        onEnd: () => settle(stream.finish()),
        onError: (error) => {
          logger.error(error)
          settle("")
        }
      }).catch((error) => {
        logger.error(error)
        settle("")
      })
    })

    if (this._abortController && request.id === this._requestId) {
      this._abortController = null
    }

    if (this.isStale(request) || !completion) {
      this.setIdle()
      return
    }

    const editor = window.activeTextEditor
    if (!editor || editor.document !== document) {
      this.setIdle()
      return
    }

    const formatted = new CompletionFormatter(editor, position).format(
      completion
    )

    logger.log(
      `FIM request ${request.id} (${document.uri.fsPath})\n` +
        `  multiline: ${multiline}\n` +
        `  raw: ${JSON.stringify(completion)}\n` +
        `  formatted: ${JSON.stringify(formatted)}`
    )

    if (!formatted) {
      this.setIdle()
      return
    }

    if (this.config.get<boolean>("completionCacheEnabled")) {
      cache.setCache(prefixSuffix, formatted)
    }

    this._lastSuggestion = { ...prefixSuffix, completion: formatted }
    return this.toInlineCompletion(formatted, position)
  }

  private toInlineCompletion(text: string, position: Position) {
    this.setIdle()
    this.lastCompletionText = text
    return [new InlineCompletionItem(text, new Range(position, position))]
  }

  private setIdle() {
    this._statusBar.text = STATUS_IDLE
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

  private buildFimRequest(
    prompt: string,
    provider: TwinnyProvider,
    stopWords: string[]
  ) {
    const body = createStreamRequestBodyFim(provider.provider, prompt, {
      model: provider.modelName,
      numPredictFim: this.config.get<number>("numPredictFim", 512),
      temperature: this.config.get<number>("temperature", 0.2),
      keepAlive: this.config.get<string>("keepAlive"),
      stop: stopWords
    })

    const options: StreamRequestOptions = {
      hostname: provider.apiHostname || "",
      port: provider.apiPort ? Number(provider.apiPort) : undefined,
      path: provider.apiPath || "",
      protocol: provider.apiProtocol || "",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: provider.apiKey ? `Bearer ${provider.apiKey}` : ""
      }
    }

    return { options, body }
  }

  private getPromptHeader(languageId: string, uri: Uri) {
    const lang = supportedLanguages[languageId as keyof typeof supportedLanguages]
    if (!lang) return ""

    const start = lang.syntaxComments?.start || ""
    const end = lang.syntaxComments?.end || ""
    return `${start} Path: ${workspace.asRelativePath(uri)} ${end}\n`
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
    const contextFiles = wantsContext ? await this.getContextFiles(document) : []

    if (provider.fimTemplate === FIM_TEMPLATE_FORMAT.custom) {
      const systemMessage =
        await this._templateProvider.readSystemMessageTemplate("fim")
      const context = contextFiles
        .map((file) => `// File: ${file.name}\n${file.text}`)
        .join("\n\n")
      const template = await this._templateProvider.readTemplate<FimTemplateData>(
        "fim",
        {
          prefix: prefixSuffix.prefix,
          suffix: prefixSuffix.suffix,
          systemMessage,
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
      return getFimTemplateRepositoryLevel(templateArgs)
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

  public abortCompletion() {
    this._abortController?.abort()
    this._abortController = null
    this.setIdle()
  }
}

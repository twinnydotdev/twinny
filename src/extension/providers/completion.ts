import AsyncLock from "async-lock"
import {
  ExtensionContext,
  InlineCompletionContext,
  InlineCompletionItem,
  InlineCompletionItemProvider,
  InlineCompletionList,
  InlineCompletionTriggerKind,
  Position,
  Range,
  StatusBarItem,
  TextDocument,
  Uri,
  window,
  workspace
} from "vscode"
import Parser, { SyntaxNode } from "web-tree-sitter"

import "string_score"

import {
  ACTIVE_FIM_PROVIDER_STORAGE_KEY,
  FILE_IGNORE_LIST,
  FIM_TEMPLATE_FORMAT,
  LINE_BREAK_REGEX,
  MAX_CONTEXT_LINE_COUNT,
  MAX_EMPTY_COMPLETION_CHARS,
  MIN_COMPLETION_CHUNKS,
  MULTI_LINE_DELIMITERS,
  MULTILINE_INSIDE,
  MULTILINE_OUTSIDE
} from "../../common/constants"
import { supportedLanguages } from "../../common/languages"
import { logger } from "../../common/logger"
import {
  FimTemplateData,
  PrefixSuffix,
  RepositoryLevelData as RepositoryDocment,
  ResolvedInlineCompletion,
  StreamRequestOptions,
  StreamResponse
} from "../../common/types"
import { getLineBreakCount } from "../../webview/utils"
import { streamResponse } from "../api"
import { cache } from "../cache"
import { CompletionFormatter } from "../completion-formatter"
import { FileInteractionCache } from "../file-interaction"
import {
  getFimPrompt,
  getFimTemplateRepositoryLevel,
  getStopWords
} from "../fim-templates"
import { getNodeAtPosition, getParser } from "../parser"
import { TwinnyProvider } from "../provider-manager"
import { createStreamRequestBodyFim } from "../provider-options"
import { TemplateProvider } from "../template-provider"
import {
  getCurrentLineText,
  getFimDataFromProvider as getProviderFimData,
  getIsMiddleOfString,
  getIsMultilineCompletion,
  getPrefixSuffix,
  getShouldSkipCompletion
} from "../utils"

export class CompletionProvider implements InlineCompletionItemProvider {
  private _config = workspace.getConfiguration("twinny")
  private _abortController: AbortController | null
  private _acceptedLastCompletion = false
  private _completionCacheEnabled = this._config.get(
    "completionCacheEnabled"
  ) as boolean
  private _chunkCount = 0
  private _completion = ""
  private _nodeAtPosition: SyntaxNode | null = null
  private _debouncer: NodeJS.Timeout | undefined
  private _debounceWait = this._config.get("debounceWait") as number
  private _autoSuggestEnabled = this._config.get(
    "autoSuggestEnabled"
  ) as boolean
  private _document: TextDocument | null
  private _enabled = this._config.get("enabled")
  private enableSubsequentCompletions = this._config.get(
    "enableSubsequent"
  ) as boolean
  private _extensionContext: ExtensionContext
  private _fileInteractionCache: FileInteractionCache
  private _isMultilineCompletion = false
  private _keepAlive = this._config.get("keepAlive") as string | number
  private _lastCompletionMultiline = false
  public lastCompletionText = ""
  private _lock: AsyncLock
  private _maxLines = this._config.get("maxLines") as number
  private _multilineCompletionsEnabled = this._config.get(
    "multilineCompletionsEnabled"
  ) as boolean
  private _nonce = 0
  private _numLineContext = this._config.get("contextLength") as number
  private _numPredictFim = this._config.get("numPredictFim") as number
  private _parser: Parser | undefined
  private _position: Position | null
  private _prefixSuffix: PrefixSuffix = { prefix: "", suffix: "" }
  private _statusBar: StatusBarItem
  private _temperature = this._config.get("temperature") as number
  private _templateProvider: TemplateProvider
  private _fileContextEnabled = this._config.get(
    "fileContextEnabled"
  ) as boolean
  private _enabledLanguages = this._config.get("enabledLanguages") as Record<
    string,
    boolean
  >
  private _usingFimTemplate = false
  private _provider: TwinnyProvider | undefined

  constructor(
    statusBar: StatusBarItem,
    fileInteractionCache: FileInteractionCache,
    templateProvider: TemplateProvider,
    extensionContext: ExtensionContext
  ) {
    this._abortController = null
    this._document = null
    this._lock = new AsyncLock()
    this._position = null
    this._statusBar = statusBar
    this._fileInteractionCache = fileInteractionCache
    this._templateProvider = templateProvider
    this._extensionContext = extensionContext
  }

  public async provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    context: InlineCompletionContext
  ): Promise<InlineCompletionItem[] | InlineCompletionList | null | undefined> {
    const editor = window.activeTextEditor
    this._provider = this.getProvider()
    const isLastCompletionAccepted =
      this._acceptedLastCompletion && !this.enableSubsequentCompletions

    this._prefixSuffix = getPrefixSuffix(
      this._numLineContext,
      document,
      position
    )

    const languageEnabled =
      this._enabledLanguages[document.languageId] ??
      this._enabledLanguages["*"] ??
      true

    if (!languageEnabled) return

    const cachedCompletion = cache.getCache(this._prefixSuffix)
    if (cachedCompletion && this._completionCacheEnabled) {
      this._completion = cachedCompletion
      return this.provideInlineCompletion()
    }

    if (
      context.triggerKind === InlineCompletionTriggerKind.Invoke &&
      this._autoSuggestEnabled
    ) {
      this._completion = this.lastCompletionText
      return this.provideInlineCompletion()
    }

    if (
      !this._enabled ||
      !editor ||
      isLastCompletionAccepted ||
      this._lastCompletionMultiline ||
      getShouldSkipCompletion(context, this._autoSuggestEnabled) ||
      getIsMiddleOfString()
    ) {
      this._statusBar.text = "$(code)"
      return
    }

    this._chunkCount = 0
    this._document = document
    this._position = position
    this._nonce = this._nonce + 1
    this._statusBar.text = "$(loading~spin)"
    this._statusBar.command = "twinny.stopGeneration"
    await this.tryParseDocument(document)

    this._isMultilineCompletion = getIsMultilineCompletion({
      node: this._nodeAtPosition,
      prefixSuffix: this._prefixSuffix
    })

    if (this._debouncer) clearTimeout(this._debouncer)

    const prompt = await this.getPrompt(this._prefixSuffix)

    if (!prompt) return

    return new Promise<ResolvedInlineCompletion>((resolve, reject) => {
      this._debouncer = setTimeout(() => {
        this._lock.acquire("twinny.completion", async () => {
          const provider = this.getProvider()
          if (!provider) return
          const request = this.buildStreamRequest(prompt, provider)
          try {
            await streamResponse({
              body: request.body,
              options: request.options,
              onStart: (controller) => (this._abortController = controller),
              onEnd: () => this.onEnd(resolve),
              onError: this.onError,
              onData: (data) => {
                const completion = this.onData(data as StreamResponse)
                if (completion) {
                  this._abortController?.abort()
                }
              }
            })
          } catch (error) {
            this.onError()
            reject([])
          }
        })
      }, this._debounceWait)
    })
  }

  private async tryParseDocument(document: TextDocument) {
    try {
      if (!this._position || !this._document) return
      const parser = await getParser(document.uri.fsPath)

      if (!parser || !parser.parse) return

      this._parser = parser

      this._nodeAtPosition = getNodeAtPosition(
        this._parser?.parse(this._document.getText()),
        this._position
      )
    } catch (e) {
      return
    }
  }

  private buildStreamRequest(prompt: string, provider: TwinnyProvider) {
    const body = createStreamRequestBodyFim(provider.provider, prompt, {
      model: provider.modelName,
      numPredictFim: this._numPredictFim,
      temperature: this._temperature,
      keepAlive: this._keepAlive
    })

    const options: StreamRequestOptions = {
      hostname: provider.apiHostname,
      port: provider.apiPort ? Number(provider.apiPort) : undefined,
      path: provider.apiPath,
      protocol: provider.apiProtocol,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: provider.apiKey ? `Bearer ${provider.apiKey}` : ""
      }
    }

    return { options, body }
  }

  private onData(data: StreamResponse | undefined): string {
    if (!this._provider) return ""

    const stopWords = getStopWords(
      this._provider.modelName,
      this._provider.fimTemplate || FIM_TEMPLATE_FORMAT.automatic
    )

    try {
      const providerFimData = getProviderFimData(this._provider.provider, data)
      if (providerFimData === undefined) return ""

      this._completion = this._completion + providerFimData
      this._chunkCount = this._chunkCount + 1

      if (
        this._completion.length > MAX_EMPTY_COMPLETION_CHARS &&
        this._completion.trim().length === 0
      ) {
        this.abortCompletion()
        logger.log(
          `Streaming response end as llm in empty completion loop:  ${this._nonce}`
        )
      }

      if (stopWords.some((stopWord) => this._completion.includes(stopWord))) {
        return this._completion
      }

      if (
        !this._multilineCompletionsEnabled &&
        this._chunkCount >= MIN_COMPLETION_CHUNKS &&
        LINE_BREAK_REGEX.test(this._completion.trimStart())
      ) {
        logger.log(
          `Streaming response end due to single line completion:  ${this._nonce} \nCompletion: ${this._completion}`
        )
        return this._completion
      }

      const isMultilineCompletionRequired =
        !this._isMultilineCompletion &&
        this._multilineCompletionsEnabled &&
        this._chunkCount >= MIN_COMPLETION_CHUNKS &&
        LINE_BREAK_REGEX.test(this._completion.trimStart())
      if (isMultilineCompletionRequired) {
        logger.log(
          `Streaming response end due to multiline not required  ${this._nonce} \nCompletion: ${this._completion}`
        )
        return this._completion
      }

      try {
        if (this._nodeAtPosition) {
          const takeFirst =
            MULTILINE_OUTSIDE.includes(this._nodeAtPosition?.type) ||
            (MULTILINE_INSIDE.includes(this._nodeAtPosition?.type) &&
              this._nodeAtPosition?.childCount > 2)

          const lineText = getCurrentLineText(this._position) || ""
          if (!this._parser) return ""

          if (providerFimData.includes("\n")) {
            const { rootNode } = this._parser.parse(
              `${lineText}${this._completion}`
            )

            const { hasError } = rootNode

            if (
              this._parser &&
              this._nodeAtPosition &&
              this._isMultilineCompletion &&
              this._chunkCount >= 2 &&
              takeFirst &&
              !hasError
            ) {
              if (
                MULTI_LINE_DELIMITERS.some((delimiter) =>
                  this._completion.endsWith(delimiter)
                )
              ) {
                logger.log(
                  `Streaming response end due to delimiter ${this._nonce} \nCompletion: ${this._completion}`
                )
                return this._completion
              }
            }
          }
        }
      } catch (e) {
        // Currently doesnt catch when parser fucks up
        console.error(e)
        this.abortCompletion()
      }

      if (getLineBreakCount(this._completion) >= this._maxLines) {
        logger.log(
          `
            Streaming response end due to max line count ${this._nonce} \nCompletion: ${this._completion}
          `
        )
        return this._completion
      }

      return ""
    } catch (e) {
      console.error(e)
      return ""
    }
  }

  private onEnd(resolve: (completion: ResolvedInlineCompletion) => void) {
    return resolve(this.provideInlineCompletion())
  }

  public onError = () => {
    this._abortController?.abort()
  }

  private getPromptHeader(languageId: string | undefined, uri: Uri) {
    const lang =
      supportedLanguages[languageId as keyof typeof supportedLanguages]

    if (!lang) {
      return ""
    }

    const language = `${lang.syntaxComments?.start || ""} Language: ${
      lang?.langName
    } (${languageId}) ${lang.syntaxComments?.end || ""}`

    const path = `${
      lang.syntaxComments?.start || ""
    } File uri: ${uri.toString()} (${languageId}) ${
      lang.syntaxComments?.end || ""
    }`

    return `\n${language}\n${path}\n`
  }

  public getIgnoreDirectory(fileName: string): boolean {
    return FILE_IGNORE_LIST.some((ignoreItem: string) =>
      fileName.includes(ignoreItem)
    )
  }

  private async getRelevantDocuments(): Promise<RepositoryDocment[]> {
    const interactions = this._fileInteractionCache.getAll()
    const currentFileName = this._document?.fileName || ""
    const openTextDocuments = workspace.textDocuments

    const openDocumentsData: RepositoryDocment[] = openTextDocuments
      .filter((doc) => {
        const isCurrentFile = doc.fileName === currentFileName
        const isGitFile =
          doc.fileName.includes(".git") || doc.fileName.includes("git/")
        const isIgnored = this.getIgnoreDirectory(doc.fileName)
        return !isCurrentFile && !isGitFile && !isIgnored
      })
      .map((doc) => {
        const interaction = interactions.find((i) => i.name === doc.fileName)
        return {
          uri: doc.uri,
          text: doc.getText(),
          name: doc.fileName,
          isOpen: true,
          relevanceScore: interaction?.relevanceScore || 0
        }
      })

    const otherDocumentsData: RepositoryDocment[] = (
      await Promise.all(
        interactions
          .filter(
            (interaction) =>
              !openTextDocuments.some(
                (doc) => doc.fileName === interaction.name
              )
          )
          .filter(
            (interaction) => !this.getIgnoreDirectory(interaction.name || "")
          )
          .map(async (interaction) => {
            const filePath = interaction.name
            if (!filePath) return null
            if (
              filePath.toString().match(".git") ||
              currentFileName === filePath
            )
              return null
            const uri = Uri.file(filePath)
            try {
              const document = await workspace.openTextDocument(uri)
              return {
                uri,
                text: document.getText(),
                name: filePath,
                isOpen: false,
                relevanceScore: interaction.relevanceScore
              }
            } catch (error) {
              console.error(`Error opening document ${filePath}:`, error)
              return null
            }
          })
      )
    ).filter((doc): doc is RepositoryDocment => doc !== null)

    const allDocuments = [...openDocumentsData, ...otherDocumentsData].sort(
      (a, b) => b.relevanceScore - a.relevanceScore
    )

    return allDocuments.slice(0, 3)
  }

  private async getFileInteractionContext() {
    const interactions = this._fileInteractionCache.getAll()
    const currentFileName = this._document?.fileName || ""

    const fileChunks: string[] = []
    for (const interaction of interactions) {
      const filePath = interaction.name

      if (!filePath) return

      if (filePath.toString().match(".git")) continue

      const uri = Uri.file(filePath)

      if (currentFileName === filePath) continue

      const activeLines = interaction.activeLines

      const document = await workspace.openTextDocument(uri)
      const lineCount = document.lineCount

      if (lineCount > MAX_CONTEXT_LINE_COUNT) {
        const averageLine =
          activeLines.reduce((acc, curr) => acc + curr.line, 0) /
          activeLines.length
        const start = new Position(
          Math.max(0, Math.ceil(averageLine || 0) - 100),
          0
        )
        const end = new Position(
          Math.min(lineCount, Math.ceil(averageLine || 0) + 100),
          0
        )
        fileChunks.push(
          `
          // File: ${filePath}
          // Content: \n ${document.getText(new Range(start, end))}
        `.trim()
        )
      } else {
        fileChunks.push(
          `
          // File: ${filePath}
          // Content: \n ${document.getText()}
        `.trim()
        )
      }
    }

    return fileChunks.join("\n")
  }

  private removeStopWords(completion: string) {
    if (!this._provider) return completion
    let filteredCompletion = completion
    const stopWords = getStopWords(
      this._provider.modelName,
      this._provider.fimTemplate || FIM_TEMPLATE_FORMAT.automatic
    )
    stopWords.forEach((stopWord) => {
      filteredCompletion = filteredCompletion.split(stopWord).join("")
    })
    return filteredCompletion
  }

  private async getPrompt(prefixSuffix: PrefixSuffix) {
    if (!this._provider) return ""
    if (!this._document || !this._position || !this._provider) return ""

    const documentLanguage = this._document.languageId
    const fileInteractionContext = await this.getFileInteractionContext()

    if (this._provider.fimTemplate === FIM_TEMPLATE_FORMAT.custom) {
      const systemMessage =
        await this._templateProvider.readSystemMessageTemplate("fim-system.hbs")

      const fimTemplate =
        await this._templateProvider.readTemplate<FimTemplateData>("fim", {
          prefix: prefixSuffix.prefix,
          suffix: prefixSuffix.suffix,
          systemMessage,
          context: fileInteractionContext || "",
          fileName: this._document.uri.fsPath,
          language: documentLanguage
        })

      if (fimTemplate) {
        this._usingFimTemplate = true
        return fimTemplate
      }
    }

    if (this._provider.repositoryLevel) {
      const repositoryLevelData = await this.getRelevantDocuments()
      const repoName = workspace.name
      const currentFile = await this._document.uri.fsPath
      return getFimTemplateRepositoryLevel(
        repoName || "untitled",
        repositoryLevelData,
        prefixSuffix,
        currentFile
      )
    }

    return getFimPrompt(
      this._provider.modelName,
      this._provider.fimTemplate || FIM_TEMPLATE_FORMAT.automatic,
      {
        context: fileInteractionContext || "",
        prefixSuffix,
        header: this.getPromptHeader(documentLanguage, this._document.uri),
        fileContextEnabled: this._fileContextEnabled,
        language: documentLanguage
      }
    )
  }

  private getProvider = () => {
    return this._extensionContext.globalState.get<TwinnyProvider>(
      ACTIVE_FIM_PROVIDER_STORAGE_KEY
    )
  }

  public setAcceptedLastCompletion(value: boolean) {
    this._acceptedLastCompletion = value
    this._lastCompletionMultiline = getLineBreakCount(this._completion) > 1
  }

  public abortCompletion() {
    this._abortController?.abort()
    this._statusBar.text = "$(code)"
  }

  private logCompletion(formattedCompletion: string) {
    logger.log(
      `
      *** Twinny completion triggered for file: ${this._document?.uri} ***
      Original completion: ${this._completion}
      Formatted completion: ${formattedCompletion}
      Max Lines: ${this._maxLines}
      Use file context: ${this._fileContextEnabled}
      Completed lines count ${getLineBreakCount(formattedCompletion)}
      Using custom FIM template fim.bhs?: ${this._usingFimTemplate}
    `.trim()
    )
  }

  private provideInlineCompletion(): InlineCompletionItem[] {
    const editor = window.activeTextEditor

    if (!editor || !this._position) return []

    const formattedCompletion = new CompletionFormatter(editor).format(
      this.removeStopWords(this._completion)
    )

    this.logCompletion(formattedCompletion)

    if (this._completionCacheEnabled)
      cache.setCache(this._prefixSuffix, formattedCompletion)

    this._completion = ""
    this._statusBar.text = "$(code)"
    this.lastCompletionText = formattedCompletion
    this._lastCompletionMultiline = getLineBreakCount(this._completion) > 1

    return [
      new InlineCompletionItem(
        formattedCompletion,
        new Range(this._position, this._position)
      )
    ]
  }

  public updateConfig() {
    this._config = workspace.getConfiguration("twinny")
    this._completionCacheEnabled = this._config.get(
      "completionCacheEnabled"
    ) as boolean
    this._debounceWait = this._config.get("debounceWait") as number
    this._autoSuggestEnabled = this._config.get("autoSuggestEnabled") as boolean
    this.enableSubsequentCompletions = this._config.get(
      "enableSubsequentCompletions"
    ) as boolean
    this._keepAlive = this._config.get("keepAlive") as string | number
    this._maxLines = this._config.get("maxLines") as number
    this._numLineContext = this._config.get("contextLength") as number
    this._numPredictFim = this._config.get("numPredictFim") as number
    this._temperature = this._config.get("temperature") as number
    this._enabledLanguages = this._config.get("enabledLanguages") as Record<
      string,
      boolean
    >
    this._fileContextEnabled = this._config.get("fileContextEnabled") as boolean
    this._multilineCompletionsEnabled = this._config.get(
      "multilineCompletionsEnabled"
    ) as boolean
  }
}

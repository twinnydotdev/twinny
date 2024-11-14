import * as fs from "fs/promises"
import * as path from "path"
import {
  commands,
  DiagnosticSeverity,
  ExtensionContext,
  languages,
  StatusBarItem,
  Webview,
  window,
  workspace,
} from "vscode"

import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  DEFAULT_RELEVANT_CODE_COUNT,
  DEFAULT_RELEVANT_FILE_COUNT,
  DEFAULT_RERANK_THRESHOLD,
  DEFAULT_VECTOR_SEARCH_METRIC,
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  EXTENSION_SESSION_NAME,
  SYMMETRY_EMITTER_KEY,
  SYSTEM,
  USER,
  WEBUI_TABS,
} from "../common/constants"
import { CodeLanguageDetails } from "../common/languages"
import { logger } from "../common/logger"
import {
  Message,
  RequestBodyBase,
  ServerMessage,
  StreamRequestOptions,
  StreamResponse,
  TemplateData,
} from "../common/types"
import { kebabToSentence } from "../webview/utils"

import { streamResponse } from "./api"
import { Base } from "./base"
import { EmbeddingDatabase } from "./embeddings"
import { TwinnyProvider } from "./provider-manager"
import { createStreamRequestBody } from "./provider-options"
import { Reranker } from "./reranker"
import { SessionManager } from "./session-manager"
import { SymmetryService } from "./symmetry-service"
import { TemplateProvider } from "./template-provider"
import {
  getChatDataFromProvider,
  getLanguage,
  updateLoadingMessage,
} from "./utils"

export class ChatService extends Base {
  private _completion = ""
  private _context?: ExtensionContext
  private _controller?: AbortController
  private _db?: EmbeddingDatabase
  private _promptTemplate = ""
  private _reranker: Reranker
  private _statusBar: StatusBarItem
  private _symmetryService?: SymmetryService
  private _templateProvider?: TemplateProvider
  private _webView?: Webview
  private _sessionManager: SessionManager | undefined

  constructor(
    statusBar: StatusBarItem,
    templateDir: string | undefined,
    extensionContext: ExtensionContext,
    webView: Webview,
    db: EmbeddingDatabase | undefined,
    sessionManager: SessionManager | undefined,
    symmetryService: SymmetryService
  ) {
    super()
    this._webView = webView
    this._statusBar = statusBar
    this._templateProvider = new TemplateProvider(templateDir)
    this._reranker = new Reranker()
    this._context = extensionContext
    this._db = db
    this._sessionManager = sessionManager
    this._symmetryService = symmetryService
    this.setupSymmetryListeners()
  }

  private setupSymmetryListeners() {
    this._symmetryService?.on(
      SYMMETRY_EMITTER_KEY.inference,
      (completion: string) => {
        this._webView?.postMessage({
          type: EVENT_NAME.twinnyOnCompletion,
          value: {
            completion: completion.trimStart(),
            data: getLanguage(),
          },
        } as ServerMessage)
      }
    )
  }

  private async getRelevantFiles(
    text: string | undefined
  ): Promise<[string, number][]> {
    if (!this._db || !text || !workspace.name) return []

    const table = `${workspace.name}-file-paths`
    if (await this._db.hasEmbeddingTable(table)) {
      const embedding = await this._db.fetchModelEmbedding(text)

      if (!embedding) return []

      const relevantFileCountContext = `${EVENT_NAME.twinnyGlobalContext}-${EXTENSION_CONTEXT_NAME.twinnyRelevantFilePaths}`
      const stored = this._context?.globalState.get(
        relevantFileCountContext
      ) as number
      const relevantFileCount = Number(stored) || DEFAULT_RELEVANT_FILE_COUNT

      const storedMetric = this._context?.globalState.get(
        `${EVENT_NAME.twinnyGlobalContext}-${EXTENSION_CONTEXT_NAME.twinnyVectorSearchMetric}`
      ) as number

      const metric = storedMetric || DEFAULT_VECTOR_SEARCH_METRIC

      const filePaths =
        (await this._db.getDocuments(
          embedding,
          relevantFileCount,
          table,
          metric as "cosine" | "l2" | "dot"
        )) || []

      if (!filePaths.length) return []

      return this.rerankFiles(
        text,
        filePaths.map((f) => f.content)
      )
    }

    return []
  }

  private getRerankThreshold() {
    const rerankThresholdContext = `${EVENT_NAME.twinnyGlobalContext}-${EXTENSION_CONTEXT_NAME.twinnyRerankThreshold}`
    const stored = this._context?.globalState.get(
      rerankThresholdContext
    ) as number
    const rerankThreshold = stored || DEFAULT_RERANK_THRESHOLD

    return rerankThreshold
  }

  private async rerankFiles(
    text: string | undefined,
    filePaths: string[] | undefined
  ) {
    if (!this._db || !text || !workspace.name || !filePaths?.length) return []

    const rerankThreshold = this.getRerankThreshold()

    logger.log(
      `
      Reranking threshold: ${rerankThreshold}
    `.trim()
    )

    const fileNames = filePaths?.map((filePath) => path.basename(filePath))

    const scores = await this._reranker.rerank(text, fileNames)

    if (!scores) return []

    const fileScorePairs: [string, number][] = filePaths.map(
      (filePath, index) => {
        return [filePath, scores[index]]
      }
    )

    return fileScorePairs
  }

  private async readFileContent(
    filePath: string | undefined,
    maxFileSize: number = 5 * 1024
  ): Promise<string | null> {
    if (!filePath) return null

    try {
      const stats = await fs.stat(filePath)

      if (stats.size > maxFileSize) {
        return null
      }

      if (stats.size === 0) {
        return ""
      }

      const content = await fs.readFile(filePath, "utf-8")
      return content
    } catch (error) {
      return null
    }
  }

  private async getRelevantCode(
    text: string | undefined,
    relevantFiles: [string, number][]
  ): Promise<string> {
    if (!this._db || !text || !workspace.name) return ""

    const table = `${workspace.name}-documents`
    const rerankThreshold = this.getRerankThreshold()

    if (await this._db.hasEmbeddingTable(table)) {
      const relevantCodeCountContext = `${EVENT_NAME.twinnyGlobalContext}-${EXTENSION_CONTEXT_NAME.twinnyRelevantCodeSnippets}`
      const stored = this._context?.globalState.get(
        relevantCodeCountContext
      ) as number
      const relevantCodeCount = Number(stored) || DEFAULT_RELEVANT_CODE_COUNT

      const embedding = await this._db.fetchModelEmbedding(text)

      if (!embedding) return ""

      const storedMetric = this._context?.globalState.get(
        `${EVENT_NAME.twinnyGlobalContext}-${EXTENSION_CONTEXT_NAME.twinnyVectorSearchMetric}`
      ) as number
      const metric = storedMetric || DEFAULT_VECTOR_SEARCH_METRIC

      const query = relevantFiles?.length
        ? `file IN ("${relevantFiles.map((file) => file[0]).join("\",\"")}")`
        : ""

      const queryEmbeddedDocuments =
        (await this._db.getDocuments(
          embedding,
          Math.round(relevantCodeCount / 2),
          table,
          metric as "cosine" | "l2" | "dot",
          query
        )) || []

      const embeddedDocuments =
        (await this._db.getDocuments(
          embedding,
          Math.round(relevantCodeCount / 2),
          table,
          metric as "cosine" | "l2" | "dot"
        )) || []

      const documents = [...embeddedDocuments, ...queryEmbeddedDocuments]

      const documentScores = await this._reranker.rerank(
        text,
        documents.map((item) => (item.content ? item.content.trim() : ""))
      )

      if (!documentScores) return ""

      const readThreshould = rerankThreshold

      const readFileChunks = []

      for (let i = 0; i < relevantFiles.length; i++) {
        if (relevantFiles[i][1] > readThreshould) {
          try {
            const fileContent = await this.readFileContent(relevantFiles[i][0])
            readFileChunks.push(fileContent)
          } catch (error) {
            console.error(`Error reading file ${relevantFiles[i][0]}:`, error)
          }
        }
      }

      const documentChunks = documents
        .filter((_, index) => documentScores[index] > rerankThreshold)
        .map(({ content }) => content)

      return [readFileChunks.filter(Boolean), documentChunks.filter(Boolean)]
        .join("\n\n")
        .trim()
    }

    return ""
  }

  private getProvider = () => {
    const provider = this._context?.globalState.get<TwinnyProvider>(
      ACTIVE_CHAT_PROVIDER_STORAGE_KEY
    )
    return provider
  }

  private buildStreamRequest(messages?: Message[] | Message[]) {
    const provider = this.getProvider()

    if (!provider) return

    const requestOptions: StreamRequestOptions = {
      hostname: provider.apiHostname,
      port: provider.apiPort ? Number(provider.apiPort) : undefined,
      path: provider.apiPath,
      protocol: provider.apiProtocol,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
    }

    const requestBody = createStreamRequestBody(provider.provider, {
      model: provider.modelName,
      numPredictChat: this.config.numPredictChat,
      temperature: this.config.temperature,
      messages,
      keepAlive: this.config.keepAlive,
    })

    return { requestOptions, requestBody }
  }

  private onStreamData = (
    streamResponse: StreamResponse,
    onEnd?: (completion: string) => void
  ) => {
    const provider = this.getProvider()
    if (!provider) return

    try {
      const data = getChatDataFromProvider(provider.provider, streamResponse)
      this._completion = this._completion + data
      if (onEnd) return
      this._webView?.postMessage({
        type: EVENT_NAME.twinnyOnCompletion,
        value: {
          completion: this._completion.trimStart(),
          data: getLanguage(),
          type: this._promptTemplate,
        },
      } as ServerMessage)
    } catch (error) {
      console.error("Error parsing JSON:", error)
      return
    }
  }

  private onStreamEnd = (onEnd?: (completion: string) => void) => {
    this._statusBar.text = "$(code)"
    commands.executeCommand(
      "setContext",
      EXTENSION_CONTEXT_NAME.twinnyGeneratingText,
      false
    )
    if (onEnd) {
      onEnd(this._completion)
      this._webView?.postMessage({
        type: EVENT_NAME.twinnyOnEnd,
      } as ServerMessage)
      return
    }
    this._webView?.postMessage({
      type: EVENT_NAME.twinnyOnEnd,
      value: {
        completion: this._completion.trimStart(),
        data: getLanguage(),
        type: this._promptTemplate,
      },
    } as ServerMessage)
  }

  private onStreamError = (error: Error) => {
    this._webView?.postMessage({
      type: EVENT_NAME.twinnyOnEnd,
      value: {
        error: true,
        errorMessage: `==## ERROR ##== : ${error.message}`, // Highlight errors on webview
      },
    } as ServerMessage)
  }
  
  private onStreamStart = (controller: AbortController) => {
    this._controller = controller
    commands.executeCommand(
      "setContext",
      EXTENSION_CONTEXT_NAME.twinnyGeneratingText,
      true
    )
    this._webView?.onDidReceiveMessage((data: { type: string }) => {
      if (data.type === EVENT_NAME.twinnyStopGeneration) {
        this._controller?.abort()
      }
    })
  }

  public destroyStream = () => {
    this._controller?.abort()
    this._statusBar.text = "$(code)"
    commands.executeCommand(
      "setContext",
      EXTENSION_CONTEXT_NAME.twinnyGeneratingText,
      true
    )
    this._webView?.postMessage({
      type: EVENT_NAME.twinnyOnEnd,
      value: {
        completion: this._completion.trimStart(),
        data: getLanguage(),
        type: this._promptTemplate,
      },
    } as ServerMessage)
  }

  private buildTemplatePrompt = async (
    template: string,
    language: CodeLanguageDetails,
    context?: string
  ) => {
    const editor = window.activeTextEditor
    const selection = editor?.selection
    const selectionContext =
      editor?.document.getText(selection) || context || ""

    const prompt = await this._templateProvider?.readTemplate<TemplateData>(
      template,
      {
        code: selectionContext || "",
        language: language?.langName || "unknown",
      }
    )
    return { prompt: prompt || "", selection: selectionContext }
  }

  private streamResponse({
    requestBody,
    requestOptions,
    onEnd,
  }: {
    requestBody: RequestBodyBase
    requestOptions: StreamRequestOptions
    onEnd?: (completion: string) => void
  }) {
    return streamResponse({
      body: requestBody,
      options: requestOptions,
      onData: (streamResponse) =>
        this.onStreamData(streamResponse as StreamResponse, onEnd),
      onEnd: () => this.onStreamEnd(onEnd),
      onStart: this.onStreamStart,
      onError: this.onStreamError,
    })
  }

  private sendEditorLanguage = () => {
    this._webView?.postMessage({
      type: EVENT_NAME.twinnySendLanguage,
      value: {
        data: getLanguage(),
      },
    } as ServerMessage)
  }

  private focusChatTab = () => {
    this._webView?.postMessage({
      type: EVENT_NAME.twinnySetTab,
      value: {
        data: WEBUI_TABS.chat,
      },
    } as ServerMessage<string>)
  }

  getProblemsContext(): string {
    const problems = workspace.textDocuments
      .flatMap((document) =>
        languages.getDiagnostics(document.uri).map((diagnostic) => ({
          severity: DiagnosticSeverity[diagnostic.severity],
          message: diagnostic.message,
          code: document.getText(diagnostic.range),
          line: document.lineAt(diagnostic.range.start.line).text,
          lineNumber: diagnostic.range.start.line + 1,
          character: diagnostic.range.start.character + 1,
          source: diagnostic.source,
          diagnosticCode: diagnostic.code,
        }))
      )
      .map((problem) => JSON.stringify(problem))
      .join("\n")

    return problems
  }

  public async getRagContext(text?: string): Promise<string | null> {
    const symmetryConnected = this._sessionManager?.get(
      EXTENSION_SESSION_NAME.twinnySymmetryConnection
    )

    let combinedContext = ""

    const workspaceMentioned = text?.includes("@workspace")

    const problemsMentioned = text?.includes("@problems")

    if (symmetryConnected) return null

    let problemsContext = ""

    if (problemsMentioned) {
      problemsContext = this.getProblemsContext()
      if (problemsContext) combinedContext += problemsContext + "\n\n"
    }

    const prompt = text?.replace(/@workspace|@problems/g, "")

    let relevantFiles: [string, number][] | null = []
    let relevantCode: string | null = ""

    if (workspaceMentioned) {
      updateLoadingMessage(this._webView, "Exploring knowledge base")
      relevantFiles = await this.getRelevantFiles(prompt)
      relevantCode = await this.getRelevantCode(prompt, relevantFiles)
    }

    if (relevantFiles?.length) {
      const filesTemplate =
        await this._templateProvider?.readTemplate<TemplateData>(
          "relevant-files",
          { code: relevantFiles.map((file) => file[0]).join(", ") }
        )
      combinedContext += filesTemplate + "\n\n"
    }

    if (relevantCode) {
      const codeTemplate =
        await this._templateProvider?.readTemplate<TemplateData>(
          "relevant-code",
          { code: relevantCode }
        )
      combinedContext += codeTemplate
    }

    return combinedContext.trim() || null
  }

  public async streamChatCompletion(
    messages: Message[],
  ) {
    this._completion = ""
    this.sendEditorLanguage()
    const editor = window.activeTextEditor
    const selection = editor?.selection
    const userSelection = editor?.document.getText(selection)
    const lastMessage = messages[messages.length - 1]
    const text = lastMessage.content

    const systemMessage = {
      role: SYSTEM,
      content: await this._templateProvider?.readSystemMessageTemplate(
        this._promptTemplate
      ),
    }

    let additionalContext = ""

    if (userSelection) {
      additionalContext += `Selected Code:\n${userSelection}\n\n`
    }

    const ragContext = await this.getRagContext(text)

    const cleanedText = text?.replace(/@workspace/g, "").trim()

    if (ragContext) {
      additionalContext += `Additional Context:\n${ragContext}\n\n`
    }

    const provider = this.getProvider()

    if (!provider) return

    const conversation = []

    conversation.push(...messages.slice(0, -1))

    if (!provider.modelName.includes("claude")) {
      conversation.unshift(systemMessage)
    }

    if (additionalContext) {
      const lastMessageContent = `${cleanedText}\n\n${additionalContext.trim()}`
      conversation.push({
        role: USER,
        content: lastMessageContent,
      })
    } else {
      conversation.push({
        ...lastMessage,
        content: cleanedText,
      })
    }
    updateLoadingMessage(this._webView, "Thinking")
    const request = this.buildStreamRequest(conversation)
    if (!request) return
    const { requestBody, requestOptions } = request
    return this.streamResponse({ requestBody, requestOptions })
  }

  public async getTemplateMessages(
    template: string,
    context?: string,
    skipMessage?: boolean
  ): Promise<Message[]> {
    this._statusBar.text = "$(loading~spin)"
    const { language } = getLanguage()
    this._completion = ""
    this._promptTemplate = template
    this.sendEditorLanguage()

    const { prompt, selection } = await this.buildTemplatePrompt(
      template,
      language,
      context
    )

    if (!skipMessage) {
      this.focusChatTab()
      this._webView?.postMessage({
        type: EVENT_NAME.twinnyOnLoading,
      })
      this._webView?.postMessage({
        type: EVENT_NAME.twinnyAddMessage,
        value: {
          completion: kebabToSentence(template) + "\n\n" + "```\n" + selection,
          data: getLanguage(),
        },
      } as ServerMessage)
    }

    const systemMessage = {
      role: SYSTEM,
      content: await this._templateProvider?.readSystemMessageTemplate(
        this._promptTemplate
      ),
    }

    let ragContext = undefined

    if (["explain"].includes(template)) {
      ragContext = await this.getRagContext(selection)
    }

    const userContent = ragContext
      ? `${prompt}\n\nAdditional Context:\n${ragContext}`
      : prompt

    const provider = this.getProvider()

    if (!provider) return []

    const conversation = []

    conversation.push({
      role: USER,
      content: userContent,
    })

    if (!provider.modelName.includes("claude")) {
      conversation.unshift(systemMessage)
    }

    return conversation
  }

  public async streamTemplateCompletion(
    promptTemplate: string,
    context?: string,
    onEnd?: (completion: string) => void,
    skipMessage?: boolean
  ) {
    const messages = await this.getTemplateMessages(
      promptTemplate,
      context,
      skipMessage
    )
    const request = this.buildStreamRequest(messages)

    if (!request) return
    const { requestBody, requestOptions } = request
    return this.streamResponse({ requestBody, requestOptions, onEnd })
  }
}

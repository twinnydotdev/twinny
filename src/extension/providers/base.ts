import { serverMessageKeys } from "symmetry-core"
import { ChatCompletionMessageParam, models } from "token.js"
import * as vscode from "vscode"

import {
  ACTIVE_FIM_PROVIDER_STORAGE_KEY,
  EVENT_NAME,
  EXTENSION_SESSION_NAME,
  SYMMETRY_EMITTER_KEY,
  SYSTEM,
  TWINNY_COMMAND_NAME,
} from "../../common/constants"
import { logger } from "../../common/logger"
import {
  ApiModel,
  ChatCompletionMessage,
  ClientMessage,
  FileItem,
  InferenceRequest,
  LanguageType,
  ServerMessage,
  ThemeType
} from "../../common/types"
import { ChatService } from "../chat-service"
import { ConversationHistory } from "../conversation-history"
import { DiffManager } from "../diff"
import { EmbeddingDatabase } from "../embeddings"
import { OllamaService } from "../ollama"
import { ProviderManager, TwinnyProvider } from "../provider-manager"
import { GithubService as ReviewService } from "../review-service"
import { SessionManager } from "../session-manager"
import { SymmetryService } from "../symmetry-service"
import { TemplateProvider } from "../template-provider"
import { FileTreeProvider } from "../tree"
import {
  createSymmetryMessage,
  getGitChanges,
  getLanguage,
  getTextSelection,
  getTheme,
} from "../utils"

export class BaseProvider {
  private _chatService: ChatService | undefined
  private _diffManager = new DiffManager()
  private _embeddingDatabase: EmbeddingDatabase | undefined
  private _fileTreeProvider: FileTreeProvider
  private _ollamaService: OllamaService | undefined
  private _sessionManager: SessionManager | undefined
  private _statusBarItem: vscode.StatusBarItem
  private _symmetryService?: SymmetryService
  private _templateDir: string | undefined
  private _templateProvider: TemplateProvider
  public context: vscode.ExtensionContext
  public conversationHistory: ConversationHistory | undefined
  public reviewService: ReviewService | undefined
  public webView?: vscode.Webview

  constructor(
    context: vscode.ExtensionContext,
    templateDir: string,
    statusBar: vscode.StatusBarItem,
    db?: EmbeddingDatabase,
    sessionManager?: SessionManager
  ) {
    this.context = context
    this._fileTreeProvider = new FileTreeProvider()
    this._embeddingDatabase = db
    this._ollamaService = new OllamaService()
    this._sessionManager = sessionManager
    this._statusBarItem = statusBar
    this._templateDir = templateDir
    this._templateProvider = new TemplateProvider(templateDir)
  }

  public registerWebView(webView: vscode.Webview) {
    this.webView = webView
    this.initializeServices()
    this.registerEventListeners()
  }

  private initializeServices() {
    if (!this.webView) return
    this._symmetryService = new SymmetryService(
      this.webView,
      this._sessionManager,
      this.context
    )

    this._chatService = new ChatService(
      this._statusBarItem,
      this._templateDir,
      this.context,
      this.webView,
      this._embeddingDatabase,
      this._sessionManager,
      this._symmetryService
    )

    this.conversationHistory = new ConversationHistory(
      this.context,
      this.webView,
      this._sessionManager,
      this._symmetryService
    )

    this.reviewService = new ReviewService(
      this.context,
      this.webView,
      this._sessionManager,
      this._symmetryService,
      this._templateDir
    )

    new ProviderManager(this.context, this.webView)
  }

  private registerEventListeners() {
    vscode.window.onDidChangeActiveColorTheme(this.handleThemeChange)
    vscode.window.onDidChangeTextEditorSelection(this.handleTextSelection)

    const eventHandlers = {
      [EVENT_NAME.twinnyAcceptSolution]: this.acceptSolution,
      [EVENT_NAME.twinnyChatMessage]: this.streamChatCompletion,
      [EVENT_NAME.twinnyClickSuggestion]: this.clickSuggestion,
      [EVENT_NAME.twinnyEmbedDocuments]: this.embedDocuments,
      [EVENT_NAME.twinnyFetchOllamaModels]: this.fetchOllamaModels,
      [EVENT_NAME.twinnyGetConfigValue]: this.getConfigurationValue,
      [EVENT_NAME.twinnyGetGitChanges]: this.getGitCommitMessage,
      [EVENT_NAME.twinnyGetWorkspaceContext]: this.getTwinnyWorkspaceContext,
      [EVENT_NAME.twinnyGlobalContext]: this.getGlobalContext,
      [EVENT_NAME.twinnyHideBackButton]: this.twinnyHideBackButton,
      [EVENT_NAME.twinnyListTemplates]: this.listTemplates,
      [EVENT_NAME.twinnyNewDocument]: this.createNewUntitledDocument,
      [EVENT_NAME.twinnyNotification]: this.sendNotification,
      [EVENT_NAME.twinnyOpenDiff]: this.openDiff,
      [EVENT_NAME.twinnySendLanguage]: this.getCurrentLanguage,
      [EVENT_NAME.twinnySendTheme]: this.getTheme,
      [EVENT_NAME.twinnySessionContext]: this.getSessionContext,
      [EVENT_NAME.twinnySetConfigValue]: this.setConfigurationValue,
      [EVENT_NAME.twinnySetGlobalContext]: this.setGlobalContext,
      [EVENT_NAME.twinnySetTab]: this.setTab,
      [EVENT_NAME.twinnySetWorkspaceContext]: this.setWorkspaceContext,
      [EVENT_NAME.twinnyTextSelection]: this.getSelectedText,
      [EVENT_NAME.twinnyFileListRequest]: this.fileListRequest,
      [EVENT_NAME.twinnyNewConversation]: this.twinnyNewConversation,
      [EVENT_NAME.twinnyEditDefaultTemplates]: this.editDefaultTemplates,
      [EVENT_NAME.twinntGetLocale]: this.sendLocaleToWebView,
      [EVENT_NAME.twinnyGetModels]: this.sendModelsToWebView,
      [EVENT_NAME.twinnyStopGeneration]: this.destroyStream,
      [TWINNY_COMMAND_NAME.settings]: this.openSettings
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.webView?.onDidReceiveMessage((message: any) => {
      const eventHandler = eventHandlers[message.type as string]
      if (eventHandler) eventHandler(message)
    })
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("twinny")) return
      this.sendLocaleToWebView()
    })
  }

  public getFimProvider = () => {
    return this.context.globalState.get<TwinnyProvider>(
      ACTIVE_FIM_PROVIDER_STORAGE_KEY
    )
  }

  private sendModelsToWebView = () => {
    this.webView?.postMessage({
      type: EVENT_NAME.twinnyGetModels,
      data: models,
    })
  }

  private sendLocaleToWebView = () => {
    this.webView?.postMessage({
      type: EVENT_NAME.twinnySetLocale,
      data: vscode.workspace.getConfiguration("twinny").get("locale") as string
    })
  }

  private handleThemeChange = () => {
    this.sendThemeToWebView()
  }

  private handleTextSelection = (
    event: vscode.TextEditorSelectionChangeEvent
  ) => {
    const text = event.textEditor.document.getText(event.selections[0])
    this.sendTextSelectionToWebView(text)
  }

  public newSymmetryConversation() {
    this._symmetryService?.write(
      createSymmetryMessage(serverMessageKeys.newConversation)
    )
  }

  public editDefaultTemplates = async () => {
    if (!this._templateDir) return
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(this._templateDir),
      true
    )
  }

  public destroyStream = () => {
    this._chatService?.abort()
    this.reviewService?.abort()
    this.webView?.postMessage({
      type: EVENT_NAME.twinnyStopGeneration
    })
  }

  public async streamTemplateCompletion(template: string) {
    const symmetryConnected = this._sessionManager?.get(
      EXTENSION_SESSION_NAME.twinnySymmetryConnection
    )
    if (symmetryConnected && this._chatService) {
      const messages = await this._chatService.getTemplateMessages(template)
      logger.log(`
        Using symmetry for inference
        Messages: ${JSON.stringify(messages)}
      `)
      return this._symmetryService?.write(
        createSymmetryMessage<InferenceRequest>(serverMessageKeys.inference, {
          messages,
          key: SYMMETRY_EMITTER_KEY.inference
        })
      )
    }
    this._chatService?.streamTemplateCompletion(template)
  }

  public getGitCommitMessage = async () => {
    const diff = await getGitChanges()
    if (!diff.length) {
      vscode.window.showInformationMessage(
        "No changes found in the current workspace."
      )
      return
    }
    this.conversationHistory?.resetConversation()
  }

  private twinnyNewConversation = () => {
    this.conversationHistory?.resetConversation()
    this.newSymmetryConversation()
    this.webView?.postMessage({
      type: EVENT_NAME.twinnyNewConversation
    } as ServerMessage<string>)
  }

  private openSettings = () => {
    vscode.commands.executeCommand(TWINNY_COMMAND_NAME.settings)
  }

  private setTab = (tab: ClientMessage) => {
    this.webView?.postMessage({
      type: EVENT_NAME.twinnySetTab,
      data: tab,
    } as ServerMessage<string>)
  }

  private embedDocuments = async () => {
    const dirs = vscode.workspace.workspaceFolders
    if (!dirs?.length) {
      vscode.window.showErrorMessage("No workspace loaded.")
      return
    }
    if (!this._embeddingDatabase) return
    for (const dir of dirs) {
      (
        await this._embeddingDatabase.injestDocuments(dir.uri.fsPath)
      ).populateDatabase()
    }
  }

  private getConfigurationValue = (message: ClientMessage) => {
    if (!message.key) return
    const config = vscode.workspace.getConfiguration("twinny")
    this.webView?.postMessage({
      type: EVENT_NAME.twinnyGetConfigValue,
      data: config.get(message.key),
    } as ServerMessage<string>)
  }

  private fileListRequest = async (message: ClientMessage) => {
    if (message.type === EVENT_NAME.twinnyFileListRequest) {
      const files = await this._fileTreeProvider?.getAllFiles()
      this.webView?.postMessage({
        type: EVENT_NAME.twinnyFileListResponse,
        data: files
      })
    }
  }

  private setConfigurationValue = (message: ClientMessage) => {
    if (!message.key) return
    const config = vscode.workspace.getConfiguration("twinny")
    config.update(message.key, message.data, vscode.ConfigurationTarget.Global)
  }

  private fetchOllamaModels = async () => {
    try {
      const models = await this._ollamaService?.fetchModels()
      if (!models?.length) {
        return
      }
      this.webView?.postMessage({
        type: EVENT_NAME.twinnyFetchOllamaModels,
        data: models
      } as ServerMessage<ApiModel[]>)
    } catch (e) {
      return
    }
  }

  private listTemplates = () => {
    const templates = this._templateProvider.listTemplates()
    this.webView?.postMessage({
      type: EVENT_NAME.twinnyListTemplates,
      data: templates
    } as ServerMessage<string[]>)
  }

  private sendNotification = (message: ClientMessage) => {
    vscode.window.showInformationMessage(message.data as string)
  }

  private clickSuggestion = (message: ClientMessage) => {
    vscode.commands.executeCommand(
      "twinny.templateCompletion",
      message.data as string
    )
  }

  private streamChatCompletion = async (data: ClientMessage<ChatCompletionMessageParam[]>) => {
    const symmetryConnected = this._sessionManager?.get(
      EXTENSION_SESSION_NAME.twinnySymmetryConnection
    )
    if (symmetryConnected) {
      const systemMessage = {
        role: SYSTEM,
        content: await this._templateProvider?.readSystemMessageTemplate()
      }

      const messages = [systemMessage, ...(data.data as ChatCompletionMessage[])]

      logger.log(`
        Using symmetry for inference
        Messages: ${JSON.stringify(messages)}
      `)

      return this._symmetryService?.write(
        createSymmetryMessage(serverMessageKeys.inference, {
          messages,
          key: SYMMETRY_EMITTER_KEY.inference
        })
      )
    }

    this._chatService?.streamChatCompletion(
      data.data || [],
      data.meta as FileItem[]
    )
  }

  private getSelectedText = () => {
    this.sendTextSelectionToWebView(getTextSelection())
  }

  private openDiff = async (message: ClientMessage) => {
    await this._diffManager.openDiff(message)
  }

  private acceptSolution = async (message: ClientMessage) => {
    await this._diffManager.acceptSolution(message)
  }

  private createNewUntitledDocument = async (message: ClientMessage) => {
    const lang = getLanguage()
    const document = await vscode.workspace.openTextDocument({
      content: message.data as string,
      language: lang.languageId
    })
    await vscode.window.showTextDocument(document)
  }

  private getGlobalContext = (message: ClientMessage) => {
    const storedData = this.context?.globalState.get(
      `${EVENT_NAME.twinnyGlobalContext}-${message.key}`
    )
    this.webView?.postMessage({
      type: `${EVENT_NAME.twinnyGlobalContext}-${message.key}`,
      data: storedData
    })
  }

  private getTheme = () => {
    this.sendThemeToWebView()
  }

  private getCurrentLanguage = () => {
    this.webView?.postMessage({
      type: EVENT_NAME.twinnySendLanguage,
      data: getLanguage()
    } as ServerMessage<LanguageType>)
  }

  private getSessionContext = (data: ClientMessage) => {
    if (!data.key) return undefined
    return this.webView?.postMessage({
      type: `${EVENT_NAME.twinnySessionContext}-${data.key}`,
      data: this._sessionManager?.get(data.key)
    })
  }

  private setGlobalContext = (message: ClientMessage) => {
    this.context?.globalState.update(
      `${EVENT_NAME.twinnyGlobalContext}-${message.key}`,
      message.data
    )
  }

  private getTwinnyWorkspaceContext = (message: ClientMessage) => {
    const storedData = this.context?.workspaceState.get(
      `${EVENT_NAME.twinnyGetWorkspaceContext}-${message.key}`
    )
    this.webView?.postMessage({
      type: `${EVENT_NAME.twinnyGetWorkspaceContext}-${message.key}`,
      data: storedData
    } as ServerMessage)
  }

  private setWorkspaceContext = <T>(message: ClientMessage<T>) => {
    const data = message.data
    this.context.workspaceState.update(
      `${EVENT_NAME.twinnyGetWorkspaceContext}-${message.key}`,
      data
    )
    this.webView?.postMessage({
      type: `${EVENT_NAME.twinnyGetWorkspaceContext}-${message.key}`,
      data
    })
  }

  private twinnyHideBackButton() {
    vscode.commands.executeCommand(TWINNY_COMMAND_NAME.hideBackButton)
  }

  // Helper methods
  private sendThemeToWebView() {
    this.webView?.postMessage({
      type: EVENT_NAME.twinnySendTheme,
      data: getTheme()
    } as ServerMessage<ThemeType>)
  }

  private sendTextSelectionToWebView(text: string) {
    this.webView?.postMessage({
      type: EVENT_NAME.twinnyTextSelection,
      data: text
    })
  }
}

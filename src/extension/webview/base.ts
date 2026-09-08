import { models } from "fluency.js"
import * as vscode from "vscode"

import {
  ACTIVE_FIM_PROVIDER_STORAGE_KEY,
  EVENT_NAME,
  TWINNY_COMMAND_NAME,
  WORKSPACE_STORAGE_KEY
} from "../../common/constants"
import { logger } from "../../common/logger"
import { ContextValue } from "../../common/messaging/protocol"
import {
  AnyContextItem,
  ModelCatalogue,
  TwinnyProvider
} from "../../common/types"
import { Chat } from "../chat"
import { ConversationHistory } from "../chat/conversation-history"
import { EmbeddingDatabase } from "../embeddings/database"
import { EmbeddingService } from "../embeddings/service"
import { ExtensionBridge } from "../messaging/bridge"
import { P2pBridge } from "../p2p/bridge"
import { resolveProviderEndpoint } from "../p2p/endpoint"
import { P2pRuntime } from "../p2p/runtime"
import { ProviderManager } from "../providers/manager"
import { ReviewService } from "../review/service"
import { SessionManager } from "../session-manager"
import { TwinnyStatusBar } from "../status-bar"
import { TemplateProvider } from "../templates/provider"
import { getLanguage, getTextSelection, getTheme } from "../utils"

import { FileHandler } from "./file-handler"
import { FileTreeProvider } from "./file-tree"

/** Prefix under which a scoped context value lives in extension storage. */
const storageKeyFor = (scope: string, key: string) => `${scope}-${key}`

export class BaseProvider {
  private _embeddingDatabase: EmbeddingDatabase | undefined
  private _fileTreeProvider: FileTreeProvider
  private _p2p: P2pRuntime | undefined
  private _p2pBridge: P2pBridge | undefined
  private _sessionManager: SessionManager | undefined
  private _statusBarItem: TwinnyStatusBar
  private _templateDir: string | undefined
  private _templateProvider: TemplateProvider
  private _disposables: vscode.Disposable[] = []
  public bridge: ExtensionBridge | undefined
  public chat: Chat | undefined
  public context: vscode.ExtensionContext
  public conversationHistory: ConversationHistory | undefined
  public reviewService: ReviewService | undefined
  public webView?: vscode.Webview

  private _sidebarReadyHandler?: () => void

  public registerSidebarReadyHandler(handler: () => void) {
    this._sidebarReadyHandler = handler
  }

  constructor(
    context: vscode.ExtensionContext,
    templateDir: string,
    statusBar: TwinnyStatusBar,
    db?: EmbeddingDatabase,
    sessionManager?: SessionManager,
    p2p?: P2pRuntime
  ) {
    this.context = context
    this._fileTreeProvider = new FileTreeProvider()
    this._embeddingDatabase = db
    this._p2p = p2p
    this._sessionManager = sessionManager
    this._statusBarItem = statusBar
    this._templateDir = templateDir
    this._templateProvider = new TemplateProvider(templateDir)
  }

  public registerWebView(webView: vscode.Webview) {
    this.dispose()
    this.webView = webView
    this.bridge = new ExtensionBridge(webView)
    this.initializeServices(this.bridge)
    this.registerHandlers(this.bridge)
    this.registerEditorListeners(this.bridge)
    logger.log("Webview registered successfully")
  }

  public dispose() {
    this.bridge?.dispose()
    this.bridge = undefined
    this._p2pBridge?.dispose()
    this._p2pBridge = undefined
    this.chat?.dispose()
    this.conversationHistory?.dispose()
    this._disposables.forEach((disposable) => disposable.dispose())
    this._disposables = []
  }

  private initializeServices(bridge: ExtensionBridge) {
    this.chat = new Chat(
      this._statusBarItem,
      this._templateDir,
      this.context,
      bridge,
      this._embeddingDatabase
    )

    this.conversationHistory = new ConversationHistory(
      this.context,
      bridge,
      this.chat
    )

    this.reviewService = new ReviewService(
      this.context,
      bridge,
      this._templateDir,
      this.chat,
      this.conversationHistory
    )

    const providerManager = new ProviderManager(this.context, bridge)
    if (this._p2p) {
      this._p2pBridge = new P2pBridge(this._p2p, bridge, providerManager)
    }
    new EmbeddingService(this.context, bridge, this._embeddingDatabase)
    new FileHandler(bridge)

    logger.log("Provider services initialized successfully")
  }

  /**
   * Every channel this provider owns, in one table.
   *
   * Handlers are plain functions of their payload: return a value and the
   * bridge routes it back to whoever asked (or broadcasts it if nobody is
   * waiting on a specific reply). Nothing here mentions `postMessage`.
   */
  private registerHandlers(bridge: ExtensionBridge) {
    bridge.handleAll({
      [EVENT_NAME.twinntGetLocale]: () => this.getLocale(),
      [EVENT_NAME.twinnyAcceptSolution]: (code) =>
        void vscode.commands.executeCommand(TWINNY_COMMAND_NAME.applyCode, code),
      [EVENT_NAME.twinnyChatMessage]: ({ messages, mentions, conversationId }) =>
        void this.chat?.completion(messages, mentions, conversationId),
      [EVENT_NAME.twinnyClickSuggestion]: (template) =>
        void vscode.commands.executeCommand(
          TWINNY_COMMAND_NAME.templateCompletion,
          template
        ),
      [EVENT_NAME.twinnyEditDefaultTemplates]: () => this.editDefaultTemplates(),
      [EVENT_NAME.twinnyFileListRequest]: () =>
        this._fileTreeProvider.getAllFiles(),
      [EVENT_NAME.twinnyGetConfigValue]: ({ key }) => ({
        key,
        value: vscode.workspace.getConfiguration("twinny").get(key)
      }),
      [EVENT_NAME.twinnyGetContextItems]: () =>
        this.broadcastContextItems(this.readContextItems()),
      [EVENT_NAME.twinnyGetGitChanges]: () =>
        void vscode.commands.executeCommand(
          TWINNY_COMMAND_NAME.generateCommitMessage
        ),
      [EVENT_NAME.twinnyGetModels]: () => models as unknown as ModelCatalogue,
      [EVENT_NAME.twinnyGlobalContext]: ({ key }) =>
        this.readGlobalContext(key),
      [EVENT_NAME.twinnyGetWorkspaceContext]: ({ key }) =>
        this.readWorkspaceContext(key),
      [EVENT_NAME.twinnySessionContext]: ({ key }) =>
        this.readSessionContext(key),
      [EVENT_NAME.twinnySetGlobalContext]: (value) =>
        this.writeGlobalContext(value),
      [EVENT_NAME.twinnySetWorkspaceContext]: (value) =>
        this.writeWorkspaceContext(value),
      [EVENT_NAME.twinnySetSessionContext]: (value) =>
        this.writeSessionContext(value),
      [EVENT_NAME.twinnyHideBackButton]: () =>
        void vscode.commands.executeCommand(TWINNY_COMMAND_NAME.hideBackButton),
      [EVENT_NAME.twinnyOpenProviders]: () =>
        void vscode.commands.executeCommand(TWINNY_COMMAND_NAME.manageProviders),
      [EVENT_NAME.twinnyListTemplates]: () =>
        this._templateProvider.listTemplates(),
      [EVENT_NAME.twinnyNewConversation]: () => this.newConversation(),
      [EVENT_NAME.twinnyNewDocument]: (content) =>
        this.createNewUntitledDocument(content),
      [EVENT_NAME.twinnyNotification]: (message) =>
        void vscode.window.showInformationMessage(message),
      [EVENT_NAME.twinnyRemoveContextItem]: (id) => this.removeContextItem(id),
      [EVENT_NAME.twinnySendLanguage]: () => getLanguage(),
      [EVENT_NAME.twinnySendTheme]: () => getTheme(),
      [EVENT_NAME.twinnySetConfigValue]: ({ key, value }) =>
        void vscode.workspace
          .getConfiguration("twinny")
          .update(key, value, vscode.ConfigurationTarget.Global),
      [EVENT_NAME.twinnySidebarReady]: () => this._sidebarReadyHandler?.(),
      [EVENT_NAME.twinnyStopGeneration]: () => this.destroyStream(),
      [EVENT_NAME.twinnyTextSelection]: () => getTextSelection()
    })
  }

  private registerEditorListeners(bridge: ExtensionBridge) {
    this._disposables.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        bridge.emit(EVENT_NAME.twinnySendTheme, getTheme())
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        bridge.emit(
          EVENT_NAME.twinnyTextSelection,
          event.textEditor.document.getText(event.selections[0])
        )
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("twinny")) return
        bridge.emit(EVENT_NAME.twinnySetLocale, this.getLocale())
      })
    )
  }

  private getLocale() {
    return vscode.workspace.getConfiguration("twinny").get<string>("locale") || "en"
  }

  public getFimProvider = () => {
    return resolveProviderEndpoint(
      this.context.globalState.get<TwinnyProvider>(ACTIVE_FIM_PROVIDER_STORAGE_KEY)
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
    this.chat?.abort()
    this.bridge?.emit(EVENT_NAME.twinnyStopGeneration)
  }

  public async streamTemplateCompletion(template: string) {
    this.chat?.templateCompletion(template)
  }

  /* ---------------------------------------------------------------------- */
  /*  Context items                                                          */
  /* ---------------------------------------------------------------------- */

  private readContextItems = () =>
    this.context?.workspaceState.get<AnyContextItem[]>(
      WORKSPACE_STORAGE_KEY.contextItems
    ) || []

  addContextItem = (item: AnyContextItem) => {
    const items = this.readContextItems()
    const index = items.findIndex((existing) => existing.id === item.id)
    const updated = [...items]
    if (index > -1) updated[index] = item
    else updated.push(item)
    this.saveContextItems(updated)
  }

  removeContextItem = (id: string) => {
    this.saveContextItems(this.readContextItems().filter((i) => i.id !== id))
  }

  private saveContextItems = (items: AnyContextItem[]) => {
    this.context?.workspaceState.update(
      WORKSPACE_STORAGE_KEY.contextItems,
      items
    )
    this.broadcastContextItems(items)
  }

  private broadcastContextItems = (items: AnyContextItem[]) => {
    this.bridge?.emit(EVENT_NAME.twinnyUpdateContextItems, items)
  }

  /* ---------------------------------------------------------------------- */
  /*  Scoped context storage                                                 */
  /* ---------------------------------------------------------------------- */

  private readGlobalContext = (key: string): ContextValue => ({
    key,
    value: this.context?.globalState.get(
      storageKeyFor(EVENT_NAME.twinnyGlobalContext, key)
    )
  })

  private writeGlobalContext = ({ key, value }: ContextValue) => {
    this.context?.globalState.update(
      storageKeyFor(EVENT_NAME.twinnyGlobalContext, key),
      value
    )
    this.bridge?.emit(EVENT_NAME.twinnyGlobalContext, { key, value })
  }

  private readWorkspaceContext = (key: string): ContextValue => ({
    key,
    value: this.context?.workspaceState.get(
      storageKeyFor(EVENT_NAME.twinnyGetWorkspaceContext, key)
    )
  })

  private writeWorkspaceContext = ({ key, value }: ContextValue) => {
    this.context?.workspaceState.update(
      storageKeyFor(EVENT_NAME.twinnyGetWorkspaceContext, key),
      value
    )
    this.bridge?.emit(EVENT_NAME.twinnyGetWorkspaceContext, { key, value })
  }

  private readSessionContext = (key: string): ContextValue => ({
    key,
    value: this._sessionManager?.get(key)
  })

  private writeSessionContext = ({ key, value }: ContextValue) => {
    this._sessionManager?.set(key, value)
    this.bridge?.emit(EVENT_NAME.twinnySessionContext, { key, value })
  }

  /* ---------------------------------------------------------------------- */

  private newConversation = () => {
    this.conversationHistory?.resetConversation()
    this.bridge?.emit(EVENT_NAME.twinnyNewConversation)
  }

  private createNewUntitledDocument = async (content: string) => {
    const document = await vscode.workspace.openTextDocument({
      content,
      language: getLanguage().languageId
    })
    await vscode.window.showTextDocument(document)
  }
}

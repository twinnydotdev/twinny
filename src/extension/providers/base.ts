import * as vscode from 'vscode'

import {
  createSymmetryMessage,
  getGitChanges,
  getLanguage,
  getTextSelection,
  getTheme,
  updateLoadingMessage
} from '../utils'
import {
  WORKSPACE_STORAGE_KEY,
  EXTENSION_SESSION_NAME,
  EVENT_NAME,
  TWINNY_COMMAND_NAME,
  SYMMETRY_DATA_MESSAGE,
  SYMMETRY_EMITTER_KEY,
  SYSTEM
} from '../../common/constants'
import { ChatService } from '../chat-service'
import {
  ClientMessage,
  Message,
  ApiModel,
  ServerMessage,
  InferenceRequest,
  SymmetryModelProvider,
  FileItem
} from '../../common/types'
import { TemplateProvider } from '../template-provider'
import { OllamaService } from '../ollama'
import { ConversationHistory } from '../conversation-history'
import { EmbeddingDatabase } from '../embeddings'
import { SymmetryService } from '../symmetry-service'
import { SessionManager } from '../session-manager'
import { Logger } from '../../common/logger'
import { DiffManager } from '../diff'
import { ProviderManager } from '../provider-manager'
import { FileTreeProvider } from '../tree'

const logger = new Logger()

export class BaseProvider {
  public context: vscode.ExtensionContext
  public webView?: vscode.Webview
  public conversationHistory: ConversationHistory | undefined = undefined
  private _config = vscode.workspace.getConfiguration('twinny')
  private _chatService: ChatService | undefined = undefined
  private _diffManager = new DiffManager()
  private _embeddingDatabase: EmbeddingDatabase | undefined
  private _fileTreeProvider: FileTreeProvider
  private _ollamaService: OllamaService | undefined = undefined
  private _sessionManager: SessionManager | undefined = undefined
  private _statusBarItem: vscode.StatusBarItem
  private _symmetryService?: SymmetryService | undefined
  private _templateDir: string | undefined
  private _templateProvider: TemplateProvider

  constructor(
    context: vscode.ExtensionContext,
    templateDir: string,
    statusBar: vscode.StatusBarItem,
    db?: EmbeddingDatabase | undefined,
    sessionManager?: SessionManager
  ) {
    this._fileTreeProvider = new FileTreeProvider()
    this.context = context
    this._embeddingDatabase = db
    this._ollamaService = new OllamaService()
    this._sessionManager = sessionManager
    this._statusBarItem = statusBar
    this._templateDir = templateDir
    this._templateProvider = new TemplateProvider(templateDir)
  }

  public registerWebView(webView: vscode.Webview) {
    this.webView = webView

    this._symmetryService = new SymmetryService(
      webView,
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

    new ProviderManager(this.context, this.webView)

    vscode.window.onDidChangeActiveColorTheme(() => {
      this.webView?.postMessage({
        type: EVENT_NAME.twinnySendTheme,
        value: {
          data: getTheme()
        }
      })
    })

    vscode.window.onDidChangeTextEditorSelection(
      (event: vscode.TextEditorSelectionChangeEvent) => {
        const text = event.textEditor.document.getText(event.selections[0])
        this.webView?.postMessage({
          type: EVENT_NAME.twinnyTextSelection,
          value: {
            type: WORKSPACE_STORAGE_KEY.selection,
            completion: text
          }
        })
      }
    )

    vscode.window.onDidChangeActiveColorTheme(() => {
      this.webView?.postMessage({
        type: EVENT_NAME.twinnySendTheme,
        value: {
          data: getTheme()
        }
      })
    })

    this.webView?.onDidReceiveMessage((message) => {
      const eventHandlers = {
        [EVENT_NAME.twinnyAcceptSolution]: this.acceptSolution,
        [EVENT_NAME.twinnyChatMessage]: this.streamChatCompletion,
        [EVENT_NAME.twinnyClickSuggestion]: this.clickSuggestion,
        [EVENT_NAME.twinnyConnectSymmetry]: this.connectToSymmetry,
        [EVENT_NAME.twinnyDisconnectSymmetry]: this.disconnectSymmetry,
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
        [EVENT_NAME.twinnyStartSymmetryProvider]: this.createSymmetryProvider,
        [EVENT_NAME.twinnyStopSymmetryProvider]: this.stopSymmetryProvider,
        [EVENT_NAME.twinnyTextSelection]: this.getSelectedText,
        [EVENT_NAME.twinnyFileListRequest]: this.fileListRequest,
        [TWINNY_COMMAND_NAME.settings]: this.openSettings
      }
      eventHandlers[message.type as string]?.(message)
    })
  }

  public newConversation() {
    this._symmetryService?.write(
      createSymmetryMessage(SYMMETRY_DATA_MESSAGE.newConversation)
    )
  }

  public destroyStream = () => {
    this._chatService?.destroyStream()
    this.webView?.postMessage({
      type: EVENT_NAME.twinnyStopGeneration
    })
  }

  private openSettings() {
    vscode.commands.executeCommand(TWINNY_COMMAND_NAME.settings)
  }

  private setTab(tab: ClientMessage) {
    this.webView?.postMessage({
      type: EVENT_NAME.twinnySetTab,
      value: {
        data: tab as string
      }
    } as ServerMessage<string>)
  }

  private embedDocuments = async () => {
    const dirs = vscode.workspace.workspaceFolders
    if (!dirs?.length) {
      vscode.window.showErrorMessage('No workspace loaded.')
      return
    }
    if (!this._embeddingDatabase) return
    for (const dir of dirs) {
      (await this._embeddingDatabase.injestDocuments(dir.uri.fsPath)).populateDatabase()
    }
  }

  private getConfigurationValue = (message: ClientMessage) => {
    if (!message.key) return
    const config = vscode.workspace.getConfiguration('twinny')
    this.webView?.postMessage({
      type: EVENT_NAME.twinnyGetConfigValue,
      value: {
        data: config.get(message.key as string),
        type: message.key
      }
    } as ServerMessage<string>)
  }

  private fileListRequest = async (message: ClientMessage) => {
    if (message.type === EVENT_NAME.twinnyFileListRequest) {
      const files = await this._fileTreeProvider?.getAllFiles()
      this.webView?.postMessage({
        type: EVENT_NAME.twinnyFileListResponse,
        value: {
          data: files
        }
      })
    }
  }

  private setConfigurationValue = (message: ClientMessage) => {
    if (!message.key) return
    const config = vscode.workspace.getConfiguration('twinny')
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
        value: {
          data: models
        }
      } as ServerMessage<ApiModel[]>)
    } catch (e) {
      return
    }
  }

  private listTemplates = () => {
    const templates = this._templateProvider.listTemplates()
    this.webView?.postMessage({
      type: EVENT_NAME.twinnyListTemplates,
      value: {
        data: templates
      }
    } as ServerMessage<string[]>)
  }

  private sendNotification = (message: ClientMessage) => {
    vscode.window.showInformationMessage(message.data as string)
  }

  private clickSuggestion = (message: ClientMessage) => {
    vscode.commands.executeCommand(
      'twinny.templateCompletion',
      message.data as string
    )
  }

  private streamChatCompletion = async (data: ClientMessage<Message[]>) => {
    const symmetryConnected = this._sessionManager?.get(
      EXTENSION_SESSION_NAME.twinnySymmetryConnection
    )
    if (symmetryConnected) {
      const systemMessage = {
        role: SYSTEM,
        content: await this._templateProvider?.readSystemMessageTemplate()
      }

      const messages = [systemMessage, ...(data.data as Message[])]

      updateLoadingMessage(this.webView, 'Using symmetry for inference')

      logger.log(`
        Using symmetry for inference
        Messages: ${JSON.stringify(messages)}
      `)

      return this._symmetryService?.write(
        createSymmetryMessage<InferenceRequest>(
          SYMMETRY_DATA_MESSAGE.inference,
          {
            messages,
            key: SYMMETRY_EMITTER_KEY.inference
          }
        )
      )
    }

    this._chatService?.streamChatCompletion(
      data.data || [],
      data.meta as FileItem[]
    )
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
        createSymmetryMessage<InferenceRequest>(
          SYMMETRY_DATA_MESSAGE.inference,
          {
            messages,
            key: SYMMETRY_EMITTER_KEY.inference
          }
        )
      )
    }
    this._chatService?.streamTemplateCompletion(template)
  }

  private getSelectedText = () => {
    this.webView?.postMessage({
      type: EVENT_NAME.twinnyTextSelection,
      value: {
        type: WORKSPACE_STORAGE_KEY.selection,
        completion: getTextSelection()
      }
    })
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
      value: storedData
    })
  }

  private getTheme = () => {
    this.webView?.postMessage({
      type: EVENT_NAME.twinnySendTheme,
      value: {
        data: getTheme()
      }
    })
  }

  private getCurrentLanguage = () => {
    this.webView?.postMessage({
      type: EVENT_NAME.twinnySendLanguage,
      value: {
        data: getLanguage()
      }
    } as ServerMessage)
  }

  public getGitCommitMessage = async () => {
    const diff = await getGitChanges()
    if (!diff.length) {
      vscode.window.showInformationMessage(
        'No changes found in the current workspace.'
      )
      return
    }
    this.conversationHistory?.resetConversation()
    this._chatService?.streamTemplateCompletion(
      'commit-message',
      diff,
      (completion: string) => {
        vscode.commands.executeCommand('twinny.sendTerminalText', completion)
      },
      true
    )
  }

  private getSessionContext = (data: ClientMessage) => {
    if (!data.key) return undefined
    return this.webView?.postMessage({
      type: `${EVENT_NAME.twinnySessionContext}-${data.key}`,
      value: this._sessionManager?.get(data.key)
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
      value: storedData
    } as ServerMessage)
  }

  private setWorkspaceContext = <T>(message: ClientMessage<T>) => {
    const value = message.data
    this.context.workspaceState.update(
      `${EVENT_NAME.twinnyGetWorkspaceContext}-${message.key}`,
      value
    )
    this.webView?.postMessage({
      type: `${EVENT_NAME.twinnyGetWorkspaceContext}-${message.key}`,
      value
    })
  }

  private connectToSymmetry = (data: ClientMessage<SymmetryModelProvider>) => {
    if (this._config.symmetryServerKey) {
      this._symmetryService?.connect(
        this._config.symmetryServerKey,
        data.data?.model_name,
        data.data?.provider
      )
    }
  }

  private disconnectSymmetry = async () => {
    if (this._config.symmetryServerKey) {
      await this._symmetryService?.disconnect()
    }
  }

  private createSymmetryProvider = () => {
    this._symmetryService?.startSymmetryProvider()
  }

  private stopSymmetryProvider = () => {
    this._symmetryService?.stopSymmetryProvider()
  }

  private twinnyHideBackButton() {
    vscode.commands.executeCommand(TWINNY_COMMAND_NAME.hideBackButton)
  }
}

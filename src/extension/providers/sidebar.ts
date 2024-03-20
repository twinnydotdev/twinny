import * as vscode from 'vscode'

import { getGitChanges as getChangedUnidiff, getLanguage, getTextSelection, getTheme } from '../utils'
import { MESSAGE_KEY, MESSAGE_NAME } from '../../common/constants'
import { ChatService } from '../chat-service'
import {
  ClientMessage,
  MessageType,
  ApiModel,
  ServerMessage
} from '../../common/types'
import { TemplateProvider } from '../template-provider'
import { OllamaService } from '../ollama-service'

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _context: vscode.ExtensionContext
  private _statusBar: vscode.StatusBarItem
  private _templateDir: string
  private _templateProvider: TemplateProvider
  private _ollamaService: OllamaService | undefined = undefined
  public chatService: ChatService | undefined = undefined
  public view?: vscode.WebviewView

  constructor(
    statusBar: vscode.StatusBarItem,
    context: vscode.ExtensionContext,
    templateDir: string
  ) {
    this._statusBar = statusBar
    this._context = context
    this._templateDir = templateDir
    this._templateProvider = new TemplateProvider(templateDir)
    this._ollamaService = new OllamaService()
  }

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this.chatService = new ChatService(
      this._statusBar,
      this._templateDir,
      webviewView
    )
    this.view = webviewView

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context?.extensionUri]
    }

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview)

    vscode.window.onDidChangeTextEditorSelection(
      (event: vscode.TextEditorSelectionChangeEvent) => {
        const text = event.textEditor.document.getText(event.selections[0])
        webviewView.webview.postMessage({
          type: MESSAGE_NAME.twinnyTextSelection,
          value: {
            type: MESSAGE_KEY.selection,
            completion: text
          }
        })
      }
    )

    vscode.window.onDidChangeActiveColorTheme(() => {
      webviewView.webview.postMessage({
        type: MESSAGE_NAME.twinnySendTheme,
        value: {
          data: getTheme()
        }
      })
    })

    webviewView.webview.onDidReceiveMessage(
      (
        message: ClientMessage<string | boolean> & ClientMessage<MessageType[]>
      ) => {
        const eventHandlers = {
          [MESSAGE_NAME.twinnyAcceptSolution]: this.acceptSolution,
          [MESSAGE_NAME.twinnyChatMessage]: this.streamChatCompletion,
          [MESSAGE_NAME.twinnyClickSuggestion]: this.clickSuggestion,
          [MESSAGE_NAME.twinnyFetchOllamaModels]: this.fetchOllamaModels,
          [MESSAGE_NAME.twinnyGlobalContext]: this.getGlobalContext,
          [MESSAGE_NAME.twinnyListTemplates]: this.listTemplates,
          [MESSAGE_NAME.twinnyNewDocument]: this.createNewUntitledDocument,
          [MESSAGE_NAME.twinnyNotification]: this.sendNotification,
          [MESSAGE_NAME.twinnySendLanguage]: this.getCurrentLanguage,
          [MESSAGE_NAME.twinnySendTheme]: this.getTheme,
          [MESSAGE_NAME.twinnySetGlobalContext]: this.setGlobalContext,
          [MESSAGE_NAME.twinnySetWorkspaceContext]:
            this.setTwinnyWorkspaceContext,
          [MESSAGE_NAME.twinnyTextSelection]: this.getSelectedText,
          [MESSAGE_NAME.twinnyWorkspaceContext]: this.getTwinnyWorkspaceContext,
          [MESSAGE_NAME.twinnySetConfigValue]: this.setConfigurationValue,
          [MESSAGE_NAME.twinnyGetConfigValue]: this.getConfigurationValue,
          [MESSAGE_NAME.twinnyGetGitChanges]: this.getGitCommitMessage
        }
        eventHandlers[message.type as string]?.(message)
      }
    )
  }

  public getGitCommitMessage = async () => {
    const unidiff = await getChangedUnidiff()
    if (!unidiff?.length) return
    this.setTwinnyWorkspaceContext({
      key: MESSAGE_KEY.lastConversation,
      data: []
    })
    this.chatService?.streamTemplateCompletion('commit-message', unidiff)
  }

  public getConfigurationValue = (data: ClientMessage) => {
    if (!data.key) return
    const config = vscode.workspace.getConfiguration('twinny')
    this.view?.webview.postMessage({
      type: MESSAGE_NAME.twinnyGetConfigValue,
      value: {
        data: config.get(data.key as string),
        type: data.key
      }
    } as ServerMessage<string>)
  }

  public setConfigurationValue = (data: ClientMessage) => {
    if (!data.key) return
    const config = vscode.workspace.getConfiguration('twinny')
    config.update(data.key, data.data, vscode.ConfigurationTarget.Global)
  }

  public fetchOllamaModels = async () => {
    try {
      const models = await this._ollamaService?.fetchModels()
      if (!models) return
      this.view?.webview.postMessage({
        type: MESSAGE_NAME.twinnyFetchOllamaModels,
        value: {
          data: models
        }
      } as ServerMessage<ApiModel[]>)
    } catch (e) {
      return
    }
  }

  public listTemplates = () => {
    const templates = this._templateProvider.listTemplates()
    this.view?.webview.postMessage({
      type: MESSAGE_NAME.twinnyListTemplates,
      value: {
        data: templates
      }
    } as ServerMessage<string[]>)
  }

  public sendNotification = (data: ClientMessage) => {
    vscode.window.showInformationMessage(data.data as string)
  }

  public clickSuggestion = (data: ClientMessage) => {
    vscode.commands.executeCommand(
      'twinny.templateCompletion',
      data.data as string
    )
  }

  public streamChatCompletion = (data: ClientMessage<MessageType[]>) => {
    this.chatService?.streamChatCompletion(data.data || [])
  }

  public getSelectedText = () => {
    this.view?.webview.postMessage({
      type: MESSAGE_NAME.twinnyTextSelection,
      value: {
        type: MESSAGE_KEY.selection,
        completion: getTextSelection()
      }
    })
  }

  public acceptSolution = (data: ClientMessage) => {
    const editor = vscode.window.activeTextEditor
    const selection = editor?.selection
    if (!selection) return
    vscode.window.activeTextEditor?.edit((editBuilder) => {
      editBuilder.replace(selection, data.data as string)
    })
  }

  public createNewUntitledDocument = async (data: ClientMessage) => {
    const lang = getLanguage()
    const document = await vscode.workspace.openTextDocument({
      content: data.data as string,
      language: lang.languageId
    })
    await vscode.window.showTextDocument(document)
  }

  public getGlobalContext = (data: ClientMessage) => {
    const storedData = this._context?.globalState.get(
      `${MESSAGE_NAME.twinnyGlobalContext}-${data.key}`
    )
    this.view?.webview.postMessage({
      type: `${MESSAGE_NAME.twinnyGlobalContext}-${data.key}`,
      value: storedData
    })
  }

  public getTheme = () => {
    this.view?.webview.postMessage({
      type: MESSAGE_NAME.twinnySendTheme,
      value: {
        data: getTheme()
      }
    })
  }

  public getCurrentLanguage = () => {
    this.view?.webview.postMessage({
      type: MESSAGE_NAME.twinnySendLanguage,
      value: {
        data: getLanguage()
      }
    } as ServerMessage)
  }

  public setGlobalContext = (data: ClientMessage) => {
    this._context?.globalState.update(
      `${MESSAGE_NAME.twinnyGlobalContext}-${data.key}`,
      data.data
    )
  }

  public getTwinnyWorkspaceContext = (data: ClientMessage) => {
    const storedData = this._context?.workspaceState.get(
      `${MESSAGE_NAME.twinnyWorkspaceContext}-${data.key}`
    )
    this.view?.webview.postMessage({
      type: `${MESSAGE_NAME.twinnyWorkspaceContext}-${data.key}`,
      value: storedData
    } as ServerMessage)
  }

  public setTwinnyWorkspaceContext = <T>(data: ClientMessage<T>) => {
    const value = data.data
    this._context.workspaceState.update(
      `${MESSAGE_NAME.twinnyWorkspaceContext}-${data.key}`,
      value
    )
    this.view?.webview.postMessage({
      type: `${MESSAGE_NAME.twinnyWorkspaceContext}-${data.key}`,
      value
    })
  }

  public destroyStream = () => {
    this.chatService?.destroyStream()
    this.view?.webview.postMessage({
      type: MESSAGE_NAME.twinnyStopGeneration
    })
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'out', 'sidebar.js')
    )

    const codiconCssUri = vscode.Uri.joinPath(
      this._context.extensionUri,
      'assets',
      'codicon.css'
    )

    const codiconCssWebviewUri = webview.asWebviewUri(codiconCssUri)

    const nonce = getNonce()

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <link href="${codiconCssWebviewUri}" rel="stylesheet">
        <meta charset="UTF-8">
				<meta
          http-equiv="Content-Security-Policy"
          content="default-src 'self' http://localhost:11434;
          img-src vscode-resource: https:;
          font-src vscode-webview-resource:;
          script-src 'nonce-${nonce}';style-src vscode-resource: 'unsafe-inline' http: https: data:;"
        >
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Sidebar</title>
        <style>
          body { padding: 10px }
        </style>
    </head>
    <body>
        <div id="root"></div>
        <script nonce="${nonce}" src="${scriptUri}"></script>
    </body>
    </html>`
  }
}

function getNonce() {
  let text = ''
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
}

import * as vscode from 'vscode'
import { getLanguage, getTextSelection, getTheme } from '../utils'
import { MESSAGE_KEY, MESSAGE_NAME } from '../constants'
import { ChatService } from '../chat-service'
import { ClientMessage, MessageType, ServerMessage } from '../types'
import { TemplateProvider } from '../template-provider'

export class SidebarProvider implements vscode.WebviewViewProvider {
  view?: vscode.WebviewView
  _doc?: vscode.TextDocument
  public chatService: ChatService | undefined = undefined
  private _statusBar: vscode.StatusBarItem
  private context: vscode.ExtensionContext
  private _templateDir: string
  private _templateProvider: TemplateProvider

  constructor(
    statusBar: vscode.StatusBarItem,
    context: vscode.ExtensionContext,
    templateDir: string
  ) {
    this._statusBar = statusBar
    this.context = context
    this._templateDir = templateDir
    this._templateProvider = new TemplateProvider(templateDir)
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
      localResourceRoots: [this.context?.extensionUri]
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
          [MESSAGE_NAME.twinnyChatMessage]: this.streamChatCompletion,
          [MESSAGE_NAME.twinnyClickSuggestion]: this.clickSuggestion,
          [MESSAGE_NAME.twinnyTextSelection]: this.getSelectedText,
          [MESSAGE_NAME.twinnyAcceptSolution]: this.acceptSolution,
          [MESSAGE_NAME.twinnyGlobalContext]: this.getGlobalContext,
          [MESSAGE_NAME.twinnySetGlobalContext]: this.setGlobalContext,
          [MESSAGE_NAME.twinnyWorkspaceContext]: this.getTwinnyWorkspaceContext,
          [MESSAGE_NAME.twinnySetWorkspaceContext]:
            this.setTwinnyWorkspaceContext,
          [MESSAGE_NAME.twinnySendLanguage]: this.getCurrentLanguage,
          [MESSAGE_NAME.twinnySendTheme]: this.getTheme,
          [MESSAGE_NAME.twinnyNotification]: this.sendNotification,
          [MESSAGE_NAME.twinnyListTemplates]: this.listTemplates
        }
        eventHandlers[message.type as string]?.(message)
      }
    )
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
    vscode.commands.executeCommand('twinny.templateCompletion', data.data as string)
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

  public getGlobalContext = (data: ClientMessage) => {
    const storedData = this.context?.globalState.get(
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
    this.context?.globalState.update(
      `${MESSAGE_NAME.twinnyGlobalContext}-${data.key}`,
      data.data
    )
  }

  public getTwinnyWorkspaceContext = (data: ClientMessage) => {
    const storedData = this.context?.workspaceState.get(
      `${MESSAGE_NAME.twinnyWorkspaceContext}-${data.key}`
    )
    this.view?.webview.postMessage({
      type: `${MESSAGE_NAME.twinnyWorkspaceContext}-${data.key}`,
      value: storedData
    } as ServerMessage)
  }

  public setTwinnyWorkspaceContext = <T>(data: ClientMessage<T>) => {
    const value = data.data
    this.context.workspaceState.update(
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
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'sidebar.js')
    )

    const nonce = getNonce()

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'self' http://localhost:11434; img-src vscode-resource: https:; script-src 'nonce-${nonce}';style-src vscode-resource: 'unsafe-inline' http: https: data:;">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Sidebar</title>
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

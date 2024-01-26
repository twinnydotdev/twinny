import * as vscode from 'vscode'
import { getTextSelection, getTheme, openDiffView } from '../utils'
import { getContext } from '../context'
import { EXTENSION_NAME, MESSAGE_KEY, MESSAGE_NAME } from '../constants'
import { StreamService } from '../stream-service'
import { MessageType } from '../types'

export class SidebarProvider implements vscode.WebviewViewProvider {
  view?: vscode.WebviewView
  _doc?: vscode.TextDocument
  private _config = vscode.workspace.getConfiguration('twinny')
  private _model = this._config.get('chatModelName') as string
  public streamService: StreamService | undefined = undefined
  private _statusBar: vscode.StatusBarItem

  constructor(
    private readonly _extensionUri: vscode.Uri,
    statusBar: vscode.StatusBarItem
  ) {
    this._statusBar = statusBar
  }

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this.streamService = new StreamService(this._statusBar, webviewView)

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (data: any) => {
        const context = getContext()
        if (data.type === MESSAGE_NAME.twinnyChatMessage) {
          this.streamService?.streamChatCompletion(data.data as MessageType[])
        }
        if (data.type === MESSAGE_NAME.twinnyOpenDiff) {
          const editor = vscode.window.activeTextEditor
          const selection = editor?.selection
          const text = editor?.document.getText(selection)
          openDiffView(text || '', data.data as string)
        }
        if (data.type === MESSAGE_NAME.twinnyOpenSettings) {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            EXTENSION_NAME
          )
        }
        if (data.type === MESSAGE_NAME.twinnyClickSuggestion) {
          vscode.commands.executeCommand(data.data)
        }
        if (data.type === MESSAGE_NAME.twinnyTextSelection) {
          webviewView.webview.postMessage({
            type: MESSAGE_NAME.twinnyTextSelection,
            value: {
              type: MESSAGE_KEY.selection,
              completion: getTextSelection()
            }
          })
        }
        if (data.type === MESSAGE_NAME.twinnyAcceptSolution) {
          const editor = vscode.window.activeTextEditor
          const selection = editor?.selection
          if (!selection) return
          vscode.window.activeTextEditor?.edit((editBuilder) => {
            editBuilder.replace(selection, data.data as string)
          })
        }
        if (data.type === MESSAGE_NAME.twinnyGlobalContext) {
          const storedData = context?.globalState.get(
            `${MESSAGE_NAME.twinnyGlobalContext}-${data.key}`
          )
          webviewView.webview.postMessage({
            type: `${MESSAGE_NAME.twinnyGlobalContext}-${data.key}`,
            value: storedData
          })
        }
        if (data.type === MESSAGE_NAME.twinnySetGlobalContext) {
          context?.globalState.update(
            `${MESSAGE_NAME.twinnyGlobalContext}-${data.key}`,
            data.data
          )
        }
        if (data.type === MESSAGE_NAME.twinnyWorkspaceContext) {
          const storedData = context?.workspaceState.get(
            `${MESSAGE_NAME.twinnyWorkspaceContext}-${data.key}`
          )
          webviewView.webview.postMessage({
            type: `${MESSAGE_NAME.twinnyWorkspaceContext}-${data.key}`,
            value: storedData
          })
        }
        if (data.type === MESSAGE_NAME.twinnySetWorkspaceContext) {
          context?.workspaceState.update(
            `${MESSAGE_NAME.twinnyWorkspaceContext}-${data.key}`,
            data.data
          )
        }
        if (data.type === MESSAGE_NAME.twinnySendTheme) {
          webviewView.webview.postMessage({
            type: MESSAGE_NAME.twinnySendTheme,
            value: {
              data: getTheme()
            }
          })
        }
        if (data.type === MESSAGE_NAME.twinnyNotification) {
          vscode.window.showInformationMessage(data.data)
        }
      }
    )
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'out', 'sidebar.js')
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

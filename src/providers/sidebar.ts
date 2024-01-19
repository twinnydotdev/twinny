import * as vscode from 'vscode'
import { getTextSelection, openDiffView } from '../utils'
import { getContext } from '../context'
import { EXTENSION_NAME, MESSAGE_KEY, MESSAGE_NAME, MODEL } from '../constants'
import { ChatService } from '../chat-service'
import {
  chatMessageDeepSeek,
  chatMessageLlama,
  getPromptModel
} from '../prompts'

export class SidebarProvider implements vscode.WebviewViewProvider {
  view?: vscode.WebviewView
  _doc?: vscode.TextDocument
  private _config = vscode.workspace.getConfiguration('twinny')
  private _model = this._config.get('chatModelName') as string
  public chatService: ChatService | undefined = undefined

  constructor(private readonly _extensionUri: vscode.Uri) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public getPrompt = (data: any, selection: string) => {
    const modelType = getPromptModel(this._model)
    if (this._model.includes(MODEL.deepseek)) {
      return chatMessageDeepSeek(data.data as Message[], selection, modelType)
    }
    return chatMessageLlama(data.data as Message[], selection, modelType)
  }

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this.chatService = new ChatService(webviewView)

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

    webviewView.webview.onDidReceiveMessage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (data: any) => {
        const context = getContext()
        if (data.type === MESSAGE_NAME.twinnyChatMessage) {
          this.chatService?.streamChatCompletion(MESSAGE_NAME.twinnyChat, (selection) =>
            this.getPrompt(data, selection)
          )
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
        if (data.type === MESSAGE_NAME.twinnyWorkspaceContext) {
          const storedData = context?.workspaceState.get(
            `${MESSAGE_NAME.twinnyWorkspaceContext}-${data.key}`
          )
          webviewView.webview.postMessage({
            type: `${MESSAGE_NAME.twinnyWorkspaceContext}-${data.key}`,
            value: storedData || ''
          })
        }
        if (data.type === MESSAGE_NAME.twinnySetWorkspaceContext) {
          context?.workspaceState.update(
            `${MESSAGE_NAME.twinnyWorkspaceContext}-${data.key}`,
            data.data
          )
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

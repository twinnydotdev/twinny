import * as vscode from 'vscode'
import { chatCompletion, getTextSelection, openDiffView } from '../utils'
import { chatMessageDeepSeek, chatMessageLlama } from '../prompts'
import { getContext } from '../context'

export class SidebarProvider implements vscode.WebviewViewProvider {
  view?: vscode.WebviewView
  _doc?: vscode.TextDocument
  private _config = vscode.workspace.getConfiguration('twinny')
  private _model = this._config.get('chatModelName') as string

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView

    webviewView.webview.options = {
      enableScripts: true,

      localResourceRoots: [this._extensionUri]
    }

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview)

    vscode.window.onDidChangeTextEditorSelection(
      (event: vscode.TextEditorSelectionChangeEvent) => {
        const text = event.textEditor.document.getText(event.selections[0])
        this.view?.webview.postMessage({
          type: 'textSelection',
          value: {
            type: 'selection',
            completion: text
          }
        })
      }
    )

    webviewView.webview.onDidReceiveMessage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (data: any) => {
        const context = getContext()
        const modelType = this._model.includes('llama') ? 'llama' : 'deepseek'

        if (data.type === 'chatMessage') {
          chatCompletion('chat', this.view, (selection: string) => {
            if (this._model.includes('deepseek')) {
              return chatMessageDeepSeek(
                data.data as Message[],
                selection,
                modelType
              )
            }
            return chatMessageLlama(
              data.data as Message[],
              selection,
              modelType
            )
          })
        }
        if (data.type === 'openDiff') {
          const editor = vscode.window.activeTextEditor
          const selection = editor?.selection
          const text = editor?.document.getText(selection)
          openDiffView(text || '', data.data as string)
        }
        if (data.type === 'openSettings') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            '@ext:rjmacarthy.twinny'
          )
        }
        if (data.type === 'getTextSelection') {
          this.view?.webview.postMessage({
            type: 'textSelection',
            value: {
              type: 'selection',
              completion: getTextSelection()
            }
          })
        }
        if (data.type === 'acceptSolution') {
          const editor = vscode.window.activeTextEditor
          const selection = editor?.selection
          if (!selection) return
          vscode.window.activeTextEditor?.edit((editBuilder) => {
            editBuilder.replace(selection, data.data as string)
          })
        }
        if (data.type === 'getTwinnyWorkspaceContext') {
          this.view?.webview.postMessage({
            type: `twinnyWorkSpaceContext-${data.key}`,
            value:
              context?.workspaceState.get(
                `twinnyWorkSpaceContext-${data.key}`
              ) || ''
          })
        }
        if (data.type === 'setTwinnyWorkSpaceContext') {
          context?.workspaceState.update(
            `twinnyWorkSpaceContext-${data.key}`,
            data.data
          )
        }
      }
    )
  }

  public revive(panel: vscode.WebviewView) {
    this.view = panel
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

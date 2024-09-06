import * as vscode from 'vscode'
import { BaseProvider } from './base'
import { getNonce } from '../utils'

// TODO
export class FullScreenProvider extends BaseProvider {
  private _panel?: vscode.WebviewPanel

  constructor(
    context: vscode.ExtensionContext,
    templateDir: string,
    statusBarItem: vscode.StatusBarItem
  ) {
    super(context, templateDir, statusBarItem)
    this.context = context
  }

  public createOrShowPanel() {
    const columnToShowIn = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined

    if (this._panel) {
      this._panel.reveal(columnToShowIn)
    } else {
      this._panel = vscode.window.createWebviewPanel(
        'twinnyFullScreenPanel',
        'twinny',
        columnToShowIn || vscode.ViewColumn.One,
        {
          enableScripts: true,
          localResourceRoots: [this.context.extensionUri],
          retainContextWhenHidden: true
        }
      )

      this._panel.webview.html = this.getHtmlForWebview(this._panel.webview)

      this.registerWebView(this._panel.webview)

      this._panel.onDidDispose(
        () => {
          this._panel = undefined
        },
        null,
        this.context.subscriptions
      )
    }
  }

  private getHtmlForWebview(webview: vscode.Webview) {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'sidebar.js')
    )

    const codiconCssUri = vscode.Uri.joinPath(
      this.context.extensionUri,
      'assets',
      'codicon.css'
    )

    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'sidebar.css')
    )

    const codiconCssWebviewUri = webview.asWebviewUri(codiconCssUri)

    const nonce = getNonce()

    return `<!DOCTYPE html>
    <html lang="en">
      <head>
          <title>twinny</title>
          <link href="${codiconCssWebviewUri}" rel="stylesheet">
          <link href="${css}" rel="stylesheet">
          <meta charset="UTF-8">
          <meta
            http-equiv="Content-Security-Policy"
            content="default-src 'self' http://localhost:11434;
            img-src vscode-resource: https:;
            font-src vscode-webview-resource:;
            script-src 'nonce-${nonce}';style-src vscode-resource: 'unsafe-inline' http: https: data:;"
          >
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>twinny</title>
          <style>
            body { padding: 10px }
          </style>
      </head>
      <body>
          <div id="root-panel"></div>
          <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
      </body>
    </html>`
  }
}

import * as vscode from "vscode"

import { EmbeddingDatabase } from "../embeddings"
import { SessionManager } from "../session-manager"
import { getNonce } from "../utils"

import { BaseProvider } from "./base"

export class SidebarProvider extends BaseProvider {
  constructor(
    statusBarItem: vscode.StatusBarItem,
    context: vscode.ExtensionContext,
    templateDir: string,
    db: EmbeddingDatabase | undefined,
    sessionManager: SessionManager
  ) {
    super(context, templateDir, statusBarItem, db, sessionManager)
    this.context = context
  }

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    if (!this.context) return

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context?.extensionUri],
    }

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview)

    this.registerWebView(webviewView.webview)
  }

  private getHtmlForWebview(webview: vscode.Webview) {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "out", "sidebar.js")
    )

    const codiconCssUri = vscode.Uri.joinPath(
      this.context.extensionUri,
      "assets",
      "codicon.css"
    )

    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "out", "sidebar.css")
    )

    const codiconCssWebviewUri = webview.asWebviewUri(codiconCssUri)

    const nonce = getNonce()

    return `<!DOCTYPE html>
    <html lang="en">
      <head>
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
          <div id="root"></div>
          <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
      </body>
    </html>`
  }
}

import * as vscode from "vscode"

import { logger } from "../../common/logger"
import { EmbeddingDatabase } from "../embeddings"
import { SessionManager } from "../session-manager"
import { getNonce } from "../utils"

import { BaseProvider } from "./base"

export class SidebarProvider extends BaseProvider {
  private _sidebarReadyResolver: (() => void) | null = null
  private _sidebarReadyPromise: Promise<void> = Promise.resolve()

  constructor(
    statusBarItem: vscode.StatusBarItem,
    context: vscode.ExtensionContext,
    templateDir: string,
    db: EmbeddingDatabase | undefined,
    sessionManager: SessionManager
  ) {
    super(context, templateDir, statusBarItem, db, sessionManager)
    this.context = context
    this.registerSidebarReadyHandler(this.handleSidebarReady)
  }

  private resetSidebarReadyPromise() {
    this._sidebarReadyPromise = new Promise<void>((resolve) => {
      this._sidebarReadyResolver = resolve
    })
  }

  public handleSidebarReady = () => {
    if (this._sidebarReadyResolver) {
      this._sidebarReadyResolver()
      this._sidebarReadyResolver = null
    }
  }

  public waitForSidebarReady(): Promise<void> {
    return this._sidebarReadyPromise
  }

  public override registerWebView(webView: vscode.Webview) {
    this.resetSidebarReadyPromise()
    super.registerWebView(webView)
  }

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    if (!this.context) return

    this.resetSidebarReadyPromise()

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context?.extensionUri],
    }

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview)
    logger.log("Sidebar webview view resolved")

    this.registerWebView(webviewView.webview)

    // Reset sidebar ready promise when the Twinny sidebar is hidden (user navigates away)
    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) {
        this.resetSidebarReadyPromise()
      }
    })
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
            img-src vscode-resource: https: data:;
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

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as vscode from "vscode"
import { WebSocket } from "ws"

import { EVENT_NAME, URL_SYMMETRY_WS } from "../common/constants"

export class SymmetryWs {
  private _ws: WebSocket | null = null
  private _webView: vscode.Webview | undefined

  constructor(view: vscode.Webview | undefined) {
    this._webView = view
  }

  public connectSymmetryWs = () => {
    this._ws = new WebSocket(URL_SYMMETRY_WS)

    this._ws.on("message", (data: any) => {
      try {
        const parsedData = JSON.parse(data.toString())
        this._webView?.postMessage({
          type: EVENT_NAME.twinnySymmetryModels,
          value: {
            data: parsedData?.allPeers?.filter((peer: any) => peer.online)
          }
        })
      } catch (error) {
        console.error("Error parsing WebSocket message:", error)
      }
    })

    this._ws.on("error", (error: any) => {
      console.error("WebSocket error:", error)
    })
  }

  public dispose() {
    if (this._ws) {
      this._ws.close()
    }
  }
}

import { WebSocket } from 'ws'
import * as vscode from 'vscode'
import { EVENT_NAME, URL_SYMMETRY_WS } from '../common/constants'

export class SymmetryWs {
  private ws: WebSocket | null = null
  private view: vscode.WebviewView | undefined

  constructor(view: vscode.WebviewView | undefined) {
    this.view = view
  }

  public connectSymmetryWs = () => {
    this.ws = new WebSocket(URL_SYMMETRY_WS)

    this.ws.on('message', (data) => {
      try {
        const parsedData = JSON.parse(data.toString())
        this.view?.webview.postMessage({
          type: EVENT_NAME.twinnySymmetryModeles,
          value: {
            data: parsedData?.allPeers
          }
        })
      } catch (error) {
        console.error('Error parsing WebSocket message:', error)
      }
    })

    this.ws.on('error', (error) => {
      console.error('WebSocket error:', error)
    })
  }

  public dispose() {
    if (this.ws) {
      this.ws.close()
    }
  }
}

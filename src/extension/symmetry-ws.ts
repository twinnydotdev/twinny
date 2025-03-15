/* eslint-disable @typescript-eslint/no-explicit-any */
import * as vscode from "vscode";
import { WebSocket } from "ws";

import { EVENT_NAME, URL_SYMMETRY_WS } from "../common/constants";
import { ServerMessage } from "../common/types";

export class SymmetryWs {
  private _ws: WebSocket | null = null;
  private _webView: vscode.Webview | undefined;
  private _modelData: any = [];
  private _updateInterval: NodeJS.Timeout | null = null;

  constructor(view: vscode.Webview | undefined) {
    this._webView = view;
    this.registerHandlers();
    this.connectSymmetryWs();
  }

  public connectSymmetryWs = () => {
    this._ws = new WebSocket(URL_SYMMETRY_WS, {
      perMessageDeflate: false,
    });

    this._ws.on("message", (data: any) => {
      const parsedData = JSON.parse(data.toString());
      this._modelData = parsedData?.allPeers?.filter((peer: any) => peer.healthy) || [];
      this.sendUpdateToWebview();
    });

    this._ws.on("error", (error: any) => {
      console.error("WebSocket error:", error);
    });

    this._ws.on("close", () => {
      console.log("WebSocket closed, attempting reconnect...");
      this.reconnect();
    });

    this._updateInterval = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.ping();
      }
    }, 30000);
  };

  private sendUpdateToWebview = () => {
    this._webView?.postMessage({
      type: EVENT_NAME.twinnySymmetryModels,
      data: this._modelData,
    });
  };

  private reconnect = () => {
    if (this._ws) {
      this._ws.removeAllListeners();
      this._ws.close();
    }
    setTimeout(() => this.connectSymmetryWs(), 1000);
  };

  public registerHandlers() {
    this._webView?.onDidReceiveMessage((message: ServerMessage<string>) => {
      if (message.type === EVENT_NAME.twinnyGetSymmetryModels) {
        this.sendUpdateToWebview();
      }
    });
  }

  public dispose() {
    if (this._updateInterval) {
      clearInterval(this._updateInterval);
    }
    if (this._ws) {
      this._ws.close();
    }
  }
}

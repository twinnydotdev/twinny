import * as vscode from "vscode"

import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY,
  ACTIVE_FIM_PROVIDER_STORAGE_KEY
} from "../../common/constants"

import { resolveProviderEndpoint } from "./endpoint"
import { TwinnyProvider } from "./manager"

export class Base {
  public config = vscode.workspace.getConfiguration("twinny")
  public context?: vscode.ExtensionContext
  private _configListener: vscode.Disposable

  constructor(context: vscode.ExtensionContext) {
    this.context = context

    this._configListener = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (!event.affectsConfiguration("twinny")) return
        this.updateConfig()
      }
    )
  }

  /** Services are rebuilt whenever a webview is (re)registered; drop the old listener. */
  public dispose() {
    this._configListener.dispose()
  }

  public getFimProvider = () => {
    const provider = this.context?.globalState.get<TwinnyProvider>(
      ACTIVE_FIM_PROVIDER_STORAGE_KEY
    )
    return resolveProviderEndpoint(provider)
  }

  /**
   * The active provider for each job, with a P2P device already pointed at
   * its local gateway. Callers never see a provider without an address.
   */
  public getProvider = () => {
    const provider = this.context?.globalState.get<TwinnyProvider>(
      ACTIVE_CHAT_PROVIDER_STORAGE_KEY
    )
    return resolveProviderEndpoint(provider)
  }

  public getEmbeddingProvider = () => {
    const provider = this.context?.globalState.get<TwinnyProvider>(
      ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY
    )
    return resolveProviderEndpoint(provider)
  }

  public updateConfig() {
    this.config = vscode.workspace.getConfiguration("twinny")
  }
}

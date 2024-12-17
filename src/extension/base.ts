import * as vscode from "vscode"

import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY,
  ACTIVE_FIM_PROVIDER_STORAGE_KEY,
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME
} from "../common/constants"
import { tools } from "../common/tool-definitions"
import {
  Message,
  StreamRequestOptions as LlmRequestOptions
} from "../common/types"

import { TwinnyProvider } from "./provider-manager"
import { createStreamRequestBody } from "./provider-options"

export class Base {
  public config = vscode.workspace.getConfiguration("twinny")
  public context?: vscode.ExtensionContext

  constructor(context: vscode.ExtensionContext) {
    this.context = context
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("twinny")) {
        return
      }
      this.updateConfig()
    })
  }

  public getFimProvider = () => {
    const provider = this.context?.globalState.get<TwinnyProvider>(
      ACTIVE_FIM_PROVIDER_STORAGE_KEY
    )
    return provider
  }

  public getProvider = () => {
    const provider = this.context?.globalState.get<TwinnyProvider>(
      ACTIVE_CHAT_PROVIDER_STORAGE_KEY
    )
    return provider
  }

  public getEmbeddingProvider = () => {
    const provider = this.context?.globalState.get<TwinnyProvider>(
      ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY
    )
    return provider
  }

  public buildStreamRequest(messages?: Message[] | Message[]) {
    const provider = this.getProvider()

    if (!provider) return

    const requestOptions: LlmRequestOptions = {
      hostname: provider.apiHostname,
      port: provider.apiPort ? Number(provider.apiPort) : undefined,
      path: provider.apiPath,
      protocol: provider.apiProtocol,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`
      }
    }

    const useToolsName = `${EVENT_NAME.twinnyGlobalContext}-${EXTENSION_CONTEXT_NAME.twinnyEnableTools}`
    const toolsEnabled = this.context?.globalState.get(useToolsName) as number
    const functionTools = toolsEnabled ? tools : undefined

    const requestBody = createStreamRequestBody(
      provider.provider,
      {
        model: provider.modelName,
        numPredictChat: this.config.numPredictChat,
        temperature: this.config.temperature,
        messages,
        keepAlive: this.config.keepAlive
      },
      functionTools
    )

    return { requestOptions, requestBody }
  }

  public updateConfig() {
    this.config = vscode.workspace.getConfiguration("twinny")
  }
}

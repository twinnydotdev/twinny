import { ReactNode } from "react"
import { v4 as uuidv4 } from "uuid"
import { ExtensionContext, Webview } from "vscode"

import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY,
  ACTIVE_FIM_PROVIDER_STORAGE_KEY,
  API_PROVIDERS,
  EVENT_NAME,
  FIM_TEMPLATE_FORMAT,
  GLOBAL_STORAGE_KEY,
  INFERENCE_PROVIDERS_STORAGE_KEY,
  PROVIDER_EVENT_NAME,
  WEBUI_TABS
} from "../common/constants"
import { ClientMessage, ServerMessage } from "../common/types"

export interface TwinnyProvider {
  apiHostname?: string
  apiKey?: string
  apiPath?: string
  apiPort?: number
  apiProtocol?: string
  features?: string[]
  fimTemplate?: string
  id: string
  label: string
  logo?: ReactNode
  modelName: string
  provider: string
  repositoryLevel?: boolean
  type: string
}

type Providers = Record<string, TwinnyProvider> | undefined

export class ProviderManager {
  _context: ExtensionContext
  _webView: Webview

  constructor(context: ExtensionContext, webviewView: Webview) {
    this._context = context
    this._webView = webviewView
    this.setUpEventListeners()
    this.addDefaultProviders()
  }

  setUpEventListeners() {
    this._webView?.onDidReceiveMessage(
      (message: ClientMessage<TwinnyProvider>) => {
        this.handleMessage(message)
      }
    )
  }

  handleMessage(message: ClientMessage<TwinnyProvider>) {
    const { data: provider } = message
    switch (message.type) {
      case PROVIDER_EVENT_NAME.addProvider:
        return this.addProvider(provider)
      case PROVIDER_EVENT_NAME.removeProvider:
        return this.removeProvider(provider)
      case PROVIDER_EVENT_NAME.updateProvider:
        return this.updateProvider(provider)
      case PROVIDER_EVENT_NAME.getActiveChatProvider:
        return this.getActiveChatProvider()
      case PROVIDER_EVENT_NAME.getActiveFimProvider:
        return this.getActiveFimProvider()
      case PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider:
        return this.getActiveEmbeddingsProvider()
      case PROVIDER_EVENT_NAME.setActiveChatProvider:
        return this.setActiveChatProvider(provider)
      case PROVIDER_EVENT_NAME.setActiveFimProvider:
        return this.setActiveFimProvider(provider)
      case PROVIDER_EVENT_NAME.setActiveEmbeddingsProvider:
        return this.setActiveEmbeddingsProvider(provider)
      case PROVIDER_EVENT_NAME.copyProvider:
        return this.copyProvider(provider)
      case PROVIDER_EVENT_NAME.getAllProviders:
        return this.getAllProviders()
      case PROVIDER_EVENT_NAME.resetProvidersToDefaults:
        return this.resetProvidersToDefaults()
    }
  }

  public focusProviderTab = () => {
    this._webView.postMessage({
      type: PROVIDER_EVENT_NAME.focusProviderTab,
      data: WEBUI_TABS.providers
    } as ServerMessage<string>)
  }

  getTwinnyProvider() {
    return {
      apiHostname: "twinny.dev",
      apiPath: "/v1",
      apiProtocol: "https",
      id: "symmetry-default",
      label: "Twinny.dev (Symmetry)",
      modelName: "llama3.2:latest",
      provider: API_PROVIDERS.Twinny,
      type: "chat",
    } as TwinnyProvider
  }

  getDefaultLocalProvider() {
    return {
        apiHostname: "localhost",
        apiPath: "/v1",
        apiPort: 11434,
        apiProtocol: "http",
        id: "openai-compatible-default",
        label: "Ollama",
        modelName: "codellama:7b-instruct",
        provider: API_PROVIDERS.Ollama,
        type: "chat",
      }
  }

  getDefaultEmbeddingsProvider() {
    return {
      apiHostname: "0.0.0.0",
      apiPath: "/api/embed",
      apiPort: 11434,
      apiProtocol: "http",
      id: uuidv4(),
      label: "Ollama Embedding",
      modelName: "all-minilm:latest",
      provider: API_PROVIDERS.Ollama,
      type: "embedding"
    } as TwinnyProvider
  }

  getDefaultFimProvider() {
    return {
      apiHostname: "0.0.0.0",
      apiPath: "/api/generate",
      apiPort: 11434,
      apiProtocol: "http",
      fimTemplate: FIM_TEMPLATE_FORMAT.codellama,
      label: "Ollama FIM",
      id: uuidv4(),
      modelName: "codellama:7b-code",
      provider: API_PROVIDERS.Ollama,
      type: "fim"
    } as TwinnyProvider
  }

  addDefaultProviders() {
    this.addDefaultChatProvider()
    this.addDefaultFimProvider()
    this.addDefaultEmbeddingsProvider()
    this.addTwinnyProvider()
  }

  addDefaultLocalProvider(): TwinnyProvider {
    const provider = this.getDefaultLocalProvider()
    if (!this._context.globalState.get(ACTIVE_CHAT_PROVIDER_STORAGE_KEY)) {
      this.addDefaultProvider(provider)
    }
    return provider
  }

  addDefaultChatProvider(): TwinnyProvider {
    const provider = this.getDefaultLocalProvider()
    if (!this._context.globalState.get(ACTIVE_CHAT_PROVIDER_STORAGE_KEY)) {
      this.addDefaultProvider(provider)
    }
    return provider
  }

  addDefaultFimProvider(): TwinnyProvider {
    const provider = this.getDefaultFimProvider()
    if (!this._context.globalState.get(ACTIVE_FIM_PROVIDER_STORAGE_KEY)) {
      this.addDefaultProvider(provider)
    }
    return provider
  }

  addDefaultEmbeddingsProvider(): TwinnyProvider {
    const provider = this.getDefaultEmbeddingsProvider()

    if (
      !this._context.globalState.get(ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY)
    ) {
      this.addDefaultProvider(provider)
    }
    return provider
  }

  addTwinnyProvider(): TwinnyProvider | null {
    const provider = this.getTwinnyProvider()
    const providers = this.getProviders()
    if (!providers) return this.addProvider(provider)
    const twinnyProvider = Object.values(providers).find(p => p.apiHostname === "twinny.dev")
    if (!twinnyProvider) this.addProvider(provider)
    return provider
  }

  addDefaultProvider(provider: TwinnyProvider): void {
    if (provider.type === "chat") {
      this._context.globalState.update(
        ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
        provider
      )
    } else if (provider.type === "fim") {
      this._context.globalState.update(
        ACTIVE_FIM_PROVIDER_STORAGE_KEY,
        provider
      )
    } else {
      this._context.globalState.update(
        ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY,
        provider
      )
    }
    this.addProvider(provider)
  }

  getProviders(): Providers {
    const providers = this._context.globalState.get<
      Record<string, TwinnyProvider>
    >(INFERENCE_PROVIDERS_STORAGE_KEY)
    return providers
  }

  getAllProviders() {
    const providers = this.getProviders() || {}
    this._webView?.postMessage({
      type: PROVIDER_EVENT_NAME.getAllProviders,
      data: providers
    })
  }

  getActiveChatProvider() {
    const provider = this._context.globalState.get<TwinnyProvider>(
      ACTIVE_CHAT_PROVIDER_STORAGE_KEY
    )
    this._webView?.postMessage({
      type: PROVIDER_EVENT_NAME.getActiveChatProvider,
      data: provider
    })
    return provider
  }

  getActiveFimProvider() {
    const provider = this._context.globalState.get<TwinnyProvider>(
      ACTIVE_FIM_PROVIDER_STORAGE_KEY
    )
    this._webView?.postMessage({
      type: PROVIDER_EVENT_NAME.getActiveFimProvider,
      data: provider
    })
    return provider
  }

  getActiveEmbeddingsProvider() {
    const provider = this._context.globalState.get<TwinnyProvider>(
      ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY
    )
    this._webView?.postMessage({
      type: PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider,
      data: provider
    })
    return provider
  }

  setActiveChatProvider(provider?: TwinnyProvider) {
    if (!provider) return
    this._context.globalState.update(ACTIVE_CHAT_PROVIDER_STORAGE_KEY, provider)
    return this.getActiveChatProvider()
  }

  setActiveFimProvider(provider?: TwinnyProvider) {
    if (!provider) return
    this._context.globalState.update(ACTIVE_FIM_PROVIDER_STORAGE_KEY, provider)
    return this.getActiveFimProvider()
  }

  setActiveEmbeddingsProvider(provider?: TwinnyProvider) {
    if (!provider) return
    this._context.globalState.update(
      ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY,
      provider
    )
    return this.getActiveEmbeddingsProvider()
  }

  addProvider(provider?: TwinnyProvider): TwinnyProvider | null {
    const providers = this.getProviders() || {}
    if (!provider) return null
    provider.id = uuidv4()
    providers[provider.id] = provider
    this._context.globalState.update(INFERENCE_PROVIDERS_STORAGE_KEY, providers)

    if (provider.type === "chat") {
      this._context.globalState.update(
        `${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.selectedModel}`,
        provider?.modelName
      )
      if (!this._context.globalState.get(ACTIVE_CHAT_PROVIDER_STORAGE_KEY)) {
        this._context.globalState.update(ACTIVE_CHAT_PROVIDER_STORAGE_KEY, provider)
      }
    } else if (provider.type === "fim") {
      if (!this._context.globalState.get(ACTIVE_FIM_PROVIDER_STORAGE_KEY)) {
        this._context.globalState.update(ACTIVE_FIM_PROVIDER_STORAGE_KEY, provider)
      }
    } else if (provider.type === "embedding") {
      if (!this._context.globalState.get(ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY)) {
        this._context.globalState.update(ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY, provider)
      }
    }

    this.getAllProviders()
    return provider
  }

  copyProvider(provider?: TwinnyProvider) {
    if (!provider) return
    provider.id = uuidv4()
    provider.label = `${provider.label}-copy`
    this.addProvider(provider)
  }

  removeProvider(provider?: TwinnyProvider) {
    const providers = this.getProviders() || {}
    if (!provider) return

    const activeFimProvider = this.getActiveFimProvider()
    const activeChatProvider = this.getActiveChatProvider()
    const activeEmbeddingsProvider = this.getActiveEmbeddingsProvider()

    if (provider.id === activeFimProvider?.id) {
      this._context.globalState.update(ACTIVE_FIM_PROVIDER_STORAGE_KEY, undefined)
    }
    if (provider.id === activeChatProvider?.id) {
      this._context.globalState.update(ACTIVE_CHAT_PROVIDER_STORAGE_KEY, undefined)
    }
    if (provider.id === activeEmbeddingsProvider?.id) {
      this._context.globalState.update(ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY, undefined)
    }

    delete providers[provider.id]
    this._context.globalState.update(INFERENCE_PROVIDERS_STORAGE_KEY, providers)
    this.getAllProviders()
  }

  updateProvider(provider?: TwinnyProvider) {
    const providers = this.getProviders() || {}
    const activeFimProvider = this.getActiveFimProvider()
    const activeChatProvider = this.getActiveChatProvider()
    const activeEmbeddingsProvider = this.getActiveEmbeddingsProvider()
    if (!provider) return
    providers[provider.id] = provider
    this._context.globalState.update(INFERENCE_PROVIDERS_STORAGE_KEY, providers)
    if (provider.id === activeFimProvider?.id)
      this.setActiveFimProvider(provider)
    if (provider.id === activeChatProvider?.id)
      this.setActiveChatProvider(provider)
    if (provider.id === activeEmbeddingsProvider?.id)
      this.setActiveEmbeddingsProvider(provider)
    this.getAllProviders()
  }

  resetProvidersToDefaults(): void {
    this._context.globalState.update(INFERENCE_PROVIDERS_STORAGE_KEY, undefined)
    this._context.globalState.update(
      ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
      undefined
    )
    this._context.globalState.update(
      ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY,
      undefined
    )
    this._context.globalState.update(ACTIVE_FIM_PROVIDER_STORAGE_KEY, undefined)
    const chatProvider = this.addDefaultChatProvider()
    const fimProvider = this.addDefaultFimProvider()
    const embeddingsProvider = this.addDefaultEmbeddingsProvider()
    this.addProvider(this.getTwinnyProvider())
    this.focusProviderTab()
    this.setActiveChatProvider(chatProvider)
    this.setActiveFimProvider(fimProvider)
    this.setActiveEmbeddingsProvider(embeddingsProvider)
    this.getAllProviders()
  }
}

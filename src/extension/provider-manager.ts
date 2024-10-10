import { ExtensionContext, Webview } from 'vscode'
import { apiProviders, ClientMessage, ServerMessage } from '../common/types'
import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY,
  ACTIVE_FIM_PROVIDER_STORAGE_KEY,
  FIM_TEMPLATE_FORMAT,
  INFERENCE_PROVIDERS_STORAGE_KEY,
  PROVIDER_EVENT_NAME,
  WEBUI_TABS
} from '../common/constants'
import { v4 as uuidv4 } from 'uuid'

export interface TwinnyProvider {
  apiHostname: string
  apiPath: string
  apiPort: number
  apiProtocol: string
  id: string
  label: string
  modelName: string
  provider: string
  type: string
  apiKey?: string
  fimTemplate?: string
  repositoryLevel?: boolean
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
      value: {
        data: WEBUI_TABS.providers
      }
    } as ServerMessage<string>)
  }

  getDefaultChatProvider() {
    return {
      apiHostname: '0.0.0.0',
      apiPath: '/v1/chat/completions',
      apiPort: 11434,
      apiProtocol: 'http',
      id: uuidv4(),
      label: 'Ollama 7B Chat',
      modelName: 'codellama:7b-instruct',
      provider: apiProviders.Ollama,
      type: 'chat'
    } as TwinnyProvider
  }

  getDefaultEmbeddingsProvider() {
    return {
      apiHostname: '0.0.0.0',
      apiPath: '/api/embed',
      apiPort: 11434,
      apiProtocol: 'http',
      id: uuidv4(),
      label: 'Ollama Embedding',
      modelName: 'all-minilm:latest',
      provider: apiProviders.Ollama,
      type: 'embedding'
    } as TwinnyProvider
  }

  getDefaultFimProvider() {
    return {
      apiHostname: '0.0.0.0',
      apiPath: '/api/generate',
      apiPort: 11434,
      apiProtocol: 'http',
      fimTemplate: FIM_TEMPLATE_FORMAT.codellama,
      label: 'Ollama 7B FIM',
      id: uuidv4(),
      modelName: 'codellama:7b-code',
      provider: apiProviders.Ollama,
      type: 'fim'
    } as TwinnyProvider
  }

  addDefaultProviders() {
    this.addDefaultChatProvider()
    this.addDefaultFimProvider()
    this.addDefaultEmbeddingsProvider()
  }

  addDefaultChatProvider(): TwinnyProvider {
    const provider = this.getDefaultChatProvider()
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

  addDefaultProvider(provider: TwinnyProvider): void {
    if (provider.type === 'chat') {
      this._context.globalState.update(
        ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
        provider
      )
    } else if (provider.type === 'fim') {
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
      value: {
        data: providers
      }
    })
  }

  getActiveChatProvider() {
    const provider = this._context.globalState.get<TwinnyProvider>(
      ACTIVE_CHAT_PROVIDER_STORAGE_KEY
    )
    this._webView?.postMessage({
      type: PROVIDER_EVENT_NAME.getActiveChatProvider,
      value: {
        data: provider
      }
    })
    return provider
  }

  getActiveFimProvider() {
    const provider = this._context.globalState.get<TwinnyProvider>(
      ACTIVE_FIM_PROVIDER_STORAGE_KEY
    )
    this._webView?.postMessage({
      type: PROVIDER_EVENT_NAME.getActiveFimProvider,
      value: {
        data: provider
      }
    })
    return provider
  }

  getActiveEmbeddingsProvider() {
    const provider = this._context.globalState.get<TwinnyProvider>(
      ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY
    )
    this._webView?.postMessage({
      type: PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider,
      value: {
        data: provider
      }
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

  addProvider(provider?: TwinnyProvider) {
    const providers = this.getProviders() || {}
    if (!provider) return
    provider.id = uuidv4()
    providers[provider.id] = provider
    this._context.globalState.update(INFERENCE_PROVIDERS_STORAGE_KEY, providers)
    this.getAllProviders()
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
    this.focusProviderTab()
    this.setActiveChatProvider(chatProvider)
    this.setActiveFimProvider(fimProvider)
    this.setActiveEmbeddingsProvider(embeddingsProvider)
    this.getAllProviders()
  }
}

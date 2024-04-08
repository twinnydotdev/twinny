import { ExtensionContext, WebviewView } from 'vscode'
import { ApiProviders, ClientMessage, ServerMessage } from '../common/types'
import { FIM_TEMPLATE_FORMAT, UI_TABS } from '../common/constants'
import { v4 as uuidv4 } from 'uuid'

export const PROVIDER_MESSAGE_TYPE = {
  addProvider: 'twinny.add-provider',
  getActiveChatProvider: 'twinny.get-active-provider',
  getActiveFimProvider: 'twinny.get-active-fim-provider',
  getAllProviders: 'twinny.get-providers',
  removeProvider: 'twinny.remove-provider',
  setActiveChatProvider: 'twinny.set-active-chat-provider',
  setActiveFimProvider: 'twinny.set-active-fim-provider',
  updateProvider: 'twinny.update-provider',
  focusProviderTab: 'twinny.focus-provider-tab',
  copyProvider: 'twinny.copy-provider',
  resetProvidersToDefaults: 'twinny.reset-providers-to-defaults'
}

export interface TwinnyProvider {
  apiHostname: string
  apiPath: string
  apiPort: number
  apiProtocol: string
  id: string
  modelName: string
  provider: string
  type: string
  apiKey?: string
  fimTemplate?: string
}

export const ACTIVE_CHAT_PROVIDER_KEY = 'twinny.active-chat-provider'
export const ACTIVE_FIM_PROVIDER_KEY = 'twinny.active-fim-provider'
export const INFERENCE_PROVIDERS_KEY = 'twinny.inference-providers'

type Providers = Record<string, TwinnyProvider> | undefined

export class ProviderManager {
  _context: ExtensionContext
  _webviewView: WebviewView

  constructor(context: ExtensionContext, webviewView: WebviewView) {
    this._context = context
    this._webviewView = webviewView
    this.setUpEventListeners()
    this.addDefaultChatProvider()
    this.addDefaultFimProvider()
  }

  setUpEventListeners() {
    this._webviewView.webview.onDidReceiveMessage(
      (message: ClientMessage<TwinnyProvider>) => {
        this.handleMessage(message)
      }
    )
  }

  handleMessage(message: ClientMessage<TwinnyProvider>) {
    const { data: provider } = message
    switch (message.type) {
      case PROVIDER_MESSAGE_TYPE.addProvider:
        return this.addProvider(provider)
      case PROVIDER_MESSAGE_TYPE.removeProvider:
        return this.removeProvider(provider)
      case PROVIDER_MESSAGE_TYPE.updateProvider:
        return this.updateProvider(provider)
      case PROVIDER_MESSAGE_TYPE.getActiveChatProvider:
        return this.getActiveChatProvider()
      case PROVIDER_MESSAGE_TYPE.getActiveFimProvider:
        return this.getActiveFimProvider()
      case PROVIDER_MESSAGE_TYPE.setActiveChatProvider:
        return this.setActiveChatProvider(provider)
      case PROVIDER_MESSAGE_TYPE.setActiveFimProvider:
        return this.setActiveFimProvider(provider)
      case PROVIDER_MESSAGE_TYPE.copyProvider:
        return this.copyProvider(provider)
      case PROVIDER_MESSAGE_TYPE.getAllProviders:
        return this.getAllProviders()
      case PROVIDER_MESSAGE_TYPE.resetProvidersToDefaults:
        return this.resetProvidersToDefaults()
    }
  }

  public focusProviderTab = () => {
    this._webviewView?.webview.postMessage({
      type: PROVIDER_MESSAGE_TYPE.focusProviderTab,
      value: {
        data: UI_TABS.providers
      }
    } as ServerMessage<string>)
  }

  getDefaultChatProvider() {
    return {
      id: uuidv4(),
      provider: ApiProviders.Ollama,
      type: 'chat',
      modelName: 'codellama:7b-instruct',
      apiHostname: '0.0.0.0',
      apiPort: 11434,
      apiPath: '/v1/chat/completions',
      apiProtocol: 'http'
    } as TwinnyProvider
  }

  getDefaultFimProvider() {
    return {
      id: uuidv4(),
      provider: ApiProviders.Ollama,
      type: 'fim',
      modelName: 'codellama:7b-code',
      apiHostname: '0.0.0.0',
      apiPort: 11434,
      apiPath: '/api/generate',
      apiProtocol: 'http',
      fimTemplate: FIM_TEMPLATE_FORMAT.codellama,
    } as TwinnyProvider
  }

  addDefaultChatProvider(): void {
    if (!this._context.globalState.get(ACTIVE_CHAT_PROVIDER_KEY)) {
      this.addDefaultProvider(this.getDefaultChatProvider())
    }
  }

  addDefaultFimProvider(): void {
    if (!this._context.globalState.get(ACTIVE_FIM_PROVIDER_KEY)) {
      this.addDefaultProvider(this.getDefaultFimProvider())
    }
  }

  addDefaultProvider(provider: TwinnyProvider): void {
    if (provider.type === 'chat') {
      this._context.globalState.update(ACTIVE_CHAT_PROVIDER_KEY, provider)
    } else {
      this._context.globalState.update(ACTIVE_FIM_PROVIDER_KEY, provider)
    }
    this.addProvider(provider)
  }

  getProviders(): Providers {
    const providers = this._context.globalState.get<
      Record<string, TwinnyProvider>
    >(INFERENCE_PROVIDERS_KEY)
    return providers
  }

  getAllProviders() {
    const providers = this.getProviders() || {}
    this._webviewView.webview.postMessage({
      type: PROVIDER_MESSAGE_TYPE.getAllProviders,
      value: {
        data: providers
      }
    })
  }

  getActiveChatProvider() {
    const provider = this._context.globalState.get<TwinnyProvider>(
      ACTIVE_CHAT_PROVIDER_KEY
    )
    this._webviewView.webview.postMessage({
      type: PROVIDER_MESSAGE_TYPE.getActiveChatProvider,
      value: {
        data: provider
      }
    })
  }

  getActiveFimProvider() {
    const provider = this._context.globalState.get<TwinnyProvider>(
      ACTIVE_FIM_PROVIDER_KEY
    )
    this._webviewView.webview.postMessage({
      type: PROVIDER_MESSAGE_TYPE.getActiveFimProvider,
      value: {
        data: provider
      }
    })
  }

  setActiveChatProvider(provider?: TwinnyProvider) {
    if (!provider) return
    this._context.globalState.update(ACTIVE_CHAT_PROVIDER_KEY, provider)
    return this.getActiveChatProvider()
  }

  setActiveFimProvider(provider?: TwinnyProvider) {
    if (!provider) return
    this._context.globalState.update(ACTIVE_FIM_PROVIDER_KEY, provider)
    return this.getActiveFimProvider()
  }

  addProvider(provider?: TwinnyProvider) {
    const providers = this.getProviders() || {}
    if (!provider) return
    provider.id = uuidv4()
    providers[provider.id] = provider
    this._context.globalState.update(INFERENCE_PROVIDERS_KEY, providers)
    this.getAllProviders()
  }

  copyProvider(provider?: TwinnyProvider) {
    if (!provider) return
    provider.id = uuidv4()
    provider.modelName = `${provider.modelName}-copy`
    this.addProvider(provider)
  }

  removeProvider(provider?: TwinnyProvider) {
    const providers = this.getProviders() || {}
    if (!provider) return
    delete providers[provider.id]
    this._context.globalState.update(INFERENCE_PROVIDERS_KEY, providers)
    this.getAllProviders()
  }

  updateProvider(provider?: TwinnyProvider) {
    const providers = this.getProviders() || {}
    if (!provider) return
    providers[provider.id] = provider
    this._context.globalState.update(INFERENCE_PROVIDERS_KEY, providers)
    this.getAllProviders()
  }

  resetProvidersToDefaults(): void {
    this._context.globalState.update(INFERENCE_PROVIDERS_KEY, undefined)
    this._context.globalState.update(ACTIVE_CHAT_PROVIDER_KEY, undefined)
    this._context.globalState.update(ACTIVE_FIM_PROVIDER_KEY, undefined)
    this.addDefaultChatProvider()
    this.addDefaultFimProvider()
    this.focusProviderTab()
    this.setActiveChatProvider(this.getDefaultChatProvider())
    this.setActiveFimProvider(this.getDefaultFimProvider())
    this.getAllProviders()
  }
}

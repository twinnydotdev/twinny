import { ReactNode } from "react"
import { TextEncoder } from "util" // Added TextEncoder
import { v4 as uuidv4 } from "uuid"
import { ExtensionContext, Uri, Webview, window, workspace } from "vscode" // Added window

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
  TWINNY_PROVIDERS_FILENAME,
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
  _storageLocation: string

  constructor(context: ExtensionContext, webviewView: Webview) {
    this._context = context
    this._webView = webviewView
    this._storageLocation =
      workspace
        .getConfiguration("twinny")
        .get("providerStorageLocation") || "globalState"
    this._initializeProviders()
    this.setUpEventListeners()
  }

  private async _initializeProviders(): Promise<void> {
    if (this._storageLocation === "file") {
      let fileProviders = await this._getProvidersFromFile()
      if (!fileProviders || Object.keys(fileProviders).length === 0) {
        const globalStateProviders = this._context.globalState.get<Providers>(
          INFERENCE_PROVIDERS_STORAGE_KEY
        )
        if (globalStateProviders && Object.keys(globalStateProviders).length > 0) {
          await this._saveProvidersToFile(globalStateProviders)
          // Optional: Consider clearing globalStateProviders here
          // await this._context.globalState.update(INFERENCE_PROVIDERS_STORAGE_KEY, undefined);
        } else {
          await this.addDefaultProviders()
        }
      }
    } else {
      const globalStateProviders = this._context.globalState.get<Providers>(
        INFERENCE_PROVIDERS_STORAGE_KEY
      )
      if (!globalStateProviders || Object.keys(globalStateProviders).length === 0) {
        await this.addDefaultProviders()
      }
    }
    await this.getAllProviders()
  }

  setUpEventListeners() {
    this._webView?.onDidReceiveMessage(
      async (message: ClientMessage<TwinnyProvider>) => {
        await this.handleMessage(message)
      }
    )
  }

  async handleMessage(message: ClientMessage<TwinnyProvider>) {
    const { data: provider } = message
    switch (message.type) {
      case PROVIDER_EVENT_NAME.addProvider:
        return await this.addProvider(provider)
      case PROVIDER_EVENT_NAME.removeProvider:
        return await this.removeProvider(provider)
      case PROVIDER_EVENT_NAME.updateProvider:
        return await this.updateProvider(provider)
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
        return await this.getAllProviders()
      case PROVIDER_EVENT_NAME.resetProvidersToDefaults:
        return await this.resetProvidersToDefaults()
      case PROVIDER_EVENT_NAME.exportProviders: // Added new case
        return await this.exportProviders()
    }
  }

  public async exportProviders(): Promise<void> {
    const providers = await this.getProviders()
    if (!providers || Object.keys(providers).length === 0) {
      window.showInformationMessage("No providers to export.")
      return
    }
    try {
      const fileUri = await window.showSaveDialog({
        defaultUri: Uri.file("twinny-providers.json"), // Default file name
        filters: { JSON: ["json"] } // Filter for JSON files
      })
      if (!fileUri) {
        return // User cancelled the dialog
      }
      const jsonString = JSON.stringify(providers, null, 2)
      const writeData = new TextEncoder().encode(jsonString)
      await workspace.fs.writeFile(fileUri, writeData)
      window.showInformationMessage("Providers exported successfully.")
    } catch (error: any) {
      window.showErrorMessage(`Error exporting providers: ${error.message}`)
      console.error("Error exporting providers:", error) // Log error for debugging
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

  async addDefaultProviders() {
    await this.addDefaultChatProvider()
    await this.addDefaultFimProvider()
    await this.addDefaultEmbeddingsProvider()
    await this.addTwinnyProvider()
  }

  async addDefaultLocalProvider(): Promise<TwinnyProvider> {
    const provider = this.getDefaultLocalProvider()
    if (!this._context.globalState.get(ACTIVE_CHAT_PROVIDER_STORAGE_KEY)) {
      await this.addDefaultProvider(provider)
    }
    return provider
  }

  async addDefaultChatProvider(): Promise<TwinnyProvider> {
    const provider = this.getDefaultLocalProvider()
    if (!this._context.globalState.get(ACTIVE_CHAT_PROVIDER_STORAGE_KEY)) {
      await this.addDefaultProvider(provider)
    }
    return provider
  }

  async addDefaultFimProvider(): Promise<TwinnyProvider> {
    const provider = this.getDefaultFimProvider()
    if (!this._context.globalState.get(ACTIVE_FIM_PROVIDER_STORAGE_KEY)) {
      await this.addDefaultProvider(provider)
    }
    return provider
  }

  async addDefaultEmbeddingsProvider(): Promise<TwinnyProvider> {
    const provider = this.getDefaultEmbeddingsProvider()

    if (
      !this._context.globalState.get(ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY)
    ) {
      await this.addDefaultProvider(provider)
    }
    return provider
  }

  async addTwinnyProvider(): Promise<TwinnyProvider | null> {
    const provider = this.getTwinnyProvider()
    const providers = await this.getProviders()
    if (!providers) return await this.addProvider(provider)
    const twinnyProvider = Object.values(providers).find(p => p.apiHostname === "twinny.dev")
    if (!twinnyProvider) await this.addProvider(provider)
    return provider
  }

  async addDefaultProvider(provider: TwinnyProvider): Promise<void> {
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
    await this.addProvider(provider)
  }

  private async _saveProviders(providers: Providers): Promise<void> {
    if (this._storageLocation === "file") {
      await this._saveProvidersToFile(providers)
    } else {
      await this._context.globalState.update(
        INFERENCE_PROVIDERS_STORAGE_KEY,
        providers
      )
    }
  }

  async getProviders(): Promise<Providers> {
    if (this._storageLocation === "file") {
      return await this._getProvidersFromFile()
    } else {
      return this._context.globalState.get<Providers>(
        INFERENCE_PROVIDERS_STORAGE_KEY
      )
    }
  }

  async getAllProviders() {
    const providers = (await this.getProviders()) || {}
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

  async addProvider(provider?: TwinnyProvider): Promise<TwinnyProvider | null> {
    let providers = (await this.getProviders()) || {}
    if (!provider) return null
    provider.id = uuidv4()
    providers[provider.id] = provider
    await this._saveProviders(providers)

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

    await this.getAllProviders()
    return provider
  }

  async copyProvider(provider?: TwinnyProvider) {
    if (!provider) return
    provider.id = uuidv4()
    provider.label = `${provider.label}-copy`
    await this.addProvider(provider)
  }

  async removeProvider(provider?: TwinnyProvider) {
    let providers = (await this.getProviders()) || {}
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
    await this._saveProviders(providers)
    await this.getAllProviders()
  }

  async updateProvider(provider?: TwinnyProvider) {
    let providers = (await this.getProviders()) || {}
    const activeFimProvider = this.getActiveFimProvider()
    const activeChatProvider = this.getActiveChatProvider()
    const activeEmbeddingsProvider = this.getActiveEmbeddingsProvider()
    if (!provider) return
    providers[provider.id] = provider
    await this._saveProviders(providers)
    if (provider.id === activeFimProvider?.id)
      this.setActiveFimProvider(provider)
    if (provider.id === activeChatProvider?.id)
      this.setActiveChatProvider(provider)
    if (provider.id === activeEmbeddingsProvider?.id)
      this.setActiveEmbeddingsProvider(provider)
    await this.getAllProviders()
  }

  async resetProvidersToDefaults(): Promise<void> {
    // Clear global state active providers
    await this._context.globalState.update(ACTIVE_CHAT_PROVIDER_STORAGE_KEY, undefined)
    await this._context.globalState.update(ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY, undefined)
    await this._context.globalState.update(ACTIVE_FIM_PROVIDER_STORAGE_KEY, undefined)

    // Clear based on storage type
    if (this._storageLocation === "file") {
      await this._saveProvidersToFile({}) // Save an empty object to the file
    } else {
      await this._context.globalState.update(INFERENCE_PROVIDERS_STORAGE_KEY, undefined)
    }

    // Add default providers (this will save them to the configured storage)
    const chatProvider = await this.addDefaultChatProvider()
    const fimProvider = await this.addDefaultFimProvider()
    const embeddingsProvider = await this.addDefaultEmbeddingsProvider()
    await this.addProvider(this.getTwinnyProvider())

    this.focusProviderTab()

    // Set active providers (these are still stored in globalState)
    this.setActiveChatProvider(chatProvider)
    this.setActiveFimProvider(fimProvider)
    this.setActiveEmbeddingsProvider(embeddingsProvider)
    await this.getAllProviders()
  }

  private async _getProvidersFromFile(): Promise<Providers | undefined> {
    const fileUri = Uri.joinPath(
      this._context.globalStorageUri,
      TWINNY_PROVIDERS_FILENAME
    )
    try {
      const content = await workspace.fs.readFile(fileUri)
      const providers = JSON.parse(content.toString()) as Providers
      return providers
    } catch (e) {
      // Silently ignore and return undefined if file doesn't exist or is invalid JSON
      return undefined
    }
  }

  private async _saveProvidersToFile(providers: Providers): Promise<void> {
    const fileUri = Uri.joinPath(
      this._context.globalStorageUri,
      TWINNY_PROVIDERS_FILENAME
    )
    try {
      const content = JSON.stringify(providers, null, 2)
      await workspace.fs.writeFile(fileUri, Buffer.from(content))
    } catch (e) {
      console.error(e)
      // Handle error appropriately, e.g. show error message to user
    }
  }
}

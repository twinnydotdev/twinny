import { ReactNode } from "react"
import { TokenJS } from "fluency.js"
import { CompletionNonStreaming, LLMProvider } from "fluency.js/dist/chat"
import { TextEncoder } from "util"
import { v4 as uuidv4 } from "uuid"
import { ExtensionContext, Uri, Webview, window, workspace } from "vscode"

import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY,
  ACTIVE_FIM_PROVIDER_STORAGE_KEY,
  API_PROVIDERS,
  EVENT_NAME,
  FIM_TEMPLATE_FORMAT,
  GLOBAL_STORAGE_KEY,
  INFERENCE_PROVIDERS_STORAGE_KEY,
  OPEN_AI_COMPATIBLE_PROVIDERS,
  PROVIDER_EVENT_NAME,
  TWINNY_PROVIDERS_FILENAME,
  WEBUI_TABS
} from "../common/constants"
import { ClientMessage, ServerMessage } from "../common/types"

import { getIsOpenAICompatible } from "./utils"

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
      workspace.getConfiguration("twinny").get("providerStorageLocation") ||
      "globalState"
    this._initializeProviders()
    this.setUpEventListeners()
  }

  private async _initializeProviders(): Promise<void> {
    if (this._storageLocation === "file") {
      const fileProviders = await this._getProvidersFromFile()
      if (!fileProviders || Object.keys(fileProviders).length === 0) {
        const globalStateProviders = this._context.globalState.get<Providers>(
          INFERENCE_PROVIDERS_STORAGE_KEY
        )
        if (
          globalStateProviders &&
          Object.keys(globalStateProviders).length > 0
        ) {
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
      if (
        !globalStateProviders ||
        Object.keys(globalStateProviders).length === 0
      ) {
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
      case PROVIDER_EVENT_NAME.exportProviders:
        return await this.exportProviders()
      case PROVIDER_EVENT_NAME.importProviders:
        return await this.importProviders()
      case PROVIDER_EVENT_NAME.testProvider:
        return this.testProvider(provider)
    }
  }

  public async importProviders(): Promise<void> {
    try {
      const fileUris = await window.showOpenDialog({
        canSelectMany: false,
        filters: { JSON: ["json"] }
      })

      if (!fileUris || fileUris.length === 0) {
        return
      }

      const fileUri = fileUris[0]
      const readData = await workspace.fs.readFile(fileUri)
      const jsonString = new TextDecoder().decode(readData)

      let importedProvidersData
      try {
        importedProvidersData = JSON.parse(jsonString)
      } catch {
        window.showErrorMessage("Error parsing provider file")
        console.error("Error parsing provider file:")
        return
      }

      if (
        typeof importedProvidersData !== "object" ||
        importedProvidersData === null ||
        Array.isArray(importedProvidersData)
      ) {
        window.showErrorMessage(
          "Invalid provider file format or content: Expected a JSON object of providers."
        )
        console.error(
          "Import validation failed: Data is not an object or is null/array."
        )
        return
      }

      for (const id in importedProvidersData) {
        // eslint-disable-next-line no-prototype-builtins
        if (importedProvidersData.hasOwnProperty(id)) {
          const provider = importedProvidersData[id]
          if (
            typeof provider !== "object" ||
            provider === null ||
            typeof provider?.id !== "string" ||
            typeof provider?.label !== "string" ||
            typeof provider?.modelName !== "string" ||
            typeof provider?.provider !== "string"
          ) {
            window.showErrorMessage(
              `Invalid provider file format or content: Provider with id '${id}' is invalid or missing essential properties.`
            )
            console.error(
              `Import validation failed: Provider '${id}' is invalid.`,
              provider
            )
            return
          }
        }
      }

      const validatedProviders = importedProvidersData as Providers

      await this._saveProviders(validatedProviders)
      await this.getAllProviders()
      window.showInformationMessage("Providers imported successfully.")
    } catch {
      window.showErrorMessage("Error importing providers")
      console.error("Error importing providers")
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
        defaultUri: Uri.file("twinny-providers.json"),
        filters: { JSON: ["json"] }
      })
      if (!fileUri) {
        return
      }
      const jsonString = JSON.stringify(providers, null, 2)
      const writeData = new TextEncoder().encode(jsonString)
      await workspace.fs.writeFile(fileUri, writeData)
      window.showInformationMessage("Providers exported successfully.")
    } catch {
      window.showErrorMessage("Error exporting providers")
      console.error("Error exporting providers")
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
      type: "chat"
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
      type: "chat"
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
    const twinnyProvider = Object.values(providers).find(
      (p) => p.apiHostname === "twinny.dev"
    )
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
    const providers = (await this.getProviders()) || {}
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
        this._context.globalState.update(
          ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
          provider
        )
      }
    } else if (provider.type === "fim") {
      if (!this._context.globalState.get(ACTIVE_FIM_PROVIDER_STORAGE_KEY)) {
        this._context.globalState.update(
          ACTIVE_FIM_PROVIDER_STORAGE_KEY,
          provider
        )
      }
    } else if (provider.type === "embedding") {
      if (
        !this._context.globalState.get(ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY)
      ) {
        this._context.globalState.update(
          ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY,
          provider
        )
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
    const providers = (await this.getProviders()) || {}
    if (!provider) return

    const activeFimProvider = this.getActiveFimProvider()
    const activeChatProvider = this.getActiveChatProvider()
    const activeEmbeddingsProvider = this.getActiveEmbeddingsProvider()

    if (provider.id === activeFimProvider?.id) {
      this._context.globalState.update(
        ACTIVE_FIM_PROVIDER_STORAGE_KEY,
        undefined
      )
    }
    if (provider.id === activeChatProvider?.id) {
      this._context.globalState.update(
        ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
        undefined
      )
    }
    if (provider.id === activeEmbeddingsProvider?.id) {
      this._context.globalState.update(
        ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY,
        undefined
      )
    }

    delete providers[provider.id]
    await this._saveProviders(providers)
    await this.getAllProviders()
  }

  async updateProvider(provider?: TwinnyProvider) {
    const providers = (await this.getProviders()) || {}
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
    await this._context.globalState.update(
      ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
      undefined
    )
    await this._context.globalState.update(
      ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY,
      undefined
    )
    await this._context.globalState.update(
      ACTIVE_FIM_PROVIDER_STORAGE_KEY,
      undefined
    )

    if (this._storageLocation === "file") {
      await this._saveProvidersToFile({})
    } else {
      await this._context.globalState.update(
        INFERENCE_PROVIDERS_STORAGE_KEY,
        undefined
      )
    }

    const chatProvider = await this.addDefaultChatProvider()
    const fimProvider = await this.addDefaultFimProvider()
    const embeddingsProvider = await this.addDefaultEmbeddingsProvider()
    await this.addProvider(this.getTwinnyProvider())

    this.focusProviderTab()

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
    } catch {
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
    }
  }

  private _buildProviderBaseUrl(provider: TwinnyProvider): string {
    const { apiProtocol, apiHostname, apiPort, apiPath = "" } = provider
    let baseUrl = `${apiProtocol || "http"}://${apiHostname}`
    if (apiPort) {
      baseUrl += `:${apiPort}`
    }
    baseUrl += apiPath
    return baseUrl
  }

  private _getProviderTypeForFluency(provider: TwinnyProvider): LLMProvider {
    if (getIsOpenAICompatible(provider)) {
      return OPEN_AI_COMPATIBLE_PROVIDERS.OpenAICompatible as LLMProvider
    }
    return provider.provider as LLMProvider
  }

  async testProvider(provider?: TwinnyProvider) {
    if (!provider) {
      this._webView?.postMessage({
        type: PROVIDER_EVENT_NAME.testProviderResult,
        data: { success: false, error: "Provider details not provided." }
      } as ServerMessage<{ success: boolean; error?: string }>)
      return
    }

    const { apiKey, modelName } = provider

    const tokenJs = new TokenJS({
      baseURL: this._buildProviderBaseUrl(provider),
      apiKey: apiKey
    })

    const requestBody: CompletionNonStreaming<LLMProvider> = {
      messages: [{ role: "user", content: "hi" }],
      model: modelName,
      provider: this._getProviderTypeForFluency(provider),
      max_tokens: 5
    }

    try {
      await tokenJs.chat.completions.create(requestBody)
      this._webView?.postMessage({
        type: PROVIDER_EVENT_NAME.testProviderResult,
        data: { success: true }
      } as ServerMessage<{ success: boolean; error?: string }>)
    } catch (error) {
      let errorMessage = "An unknown error occurred."
      if (error instanceof Error) {
        errorMessage = error.message
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((error as any).response?.data?.error?.message) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          errorMessage = (error as any).response.data.error.message
        }
      } else if (typeof error === "string") {
        errorMessage = error
      }
      this._webView?.postMessage({
        type: PROVIDER_EVENT_NAME.testProviderResult,
        data: { success: false, error: errorMessage }
      } as ServerMessage<{ success: boolean; error?: string }>)
    }
  }
}

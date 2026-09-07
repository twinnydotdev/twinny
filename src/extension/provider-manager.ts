import { TokenJS } from "fluency.js"
import { CompletionNonStreaming, LLMProvider } from "fluency.js/dist/chat"
import { TextEncoder } from "util"
import { v4 as uuidv4 } from "uuid"
import { ExtensionContext, Uri, window, workspace } from "vscode"

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
import { ApiModel, TwinnyProvider } from "../common/types"

import { ExtensionBridge } from "./messaging/bridge"
import { OllamaService } from "./ollama"
import { getIsOpenAICompatible } from "./utils"

export type { TwinnyProvider }

type Providers = Record<string, TwinnyProvider> | undefined

const EMBEDDING_MODEL_PATTERN = /embed|minilm|bge|e5|nomic/i
const FIM_MODEL_PATTERN =
  /code|coder|fim|starcoder|codestral|codegemma|stable-code/i

const FALLBACK_CHAT_MODEL = "codellama:7b-instruct"
const FALLBACK_FIM_MODEL = "codellama:7b-code"
const FALLBACK_EMBEDDINGS_MODEL = "all-minilm:latest"

export class ProviderManager {
  _context: ExtensionContext
  _bridge: ExtensionBridge
  _storageLocation: string

  constructor(context: ExtensionContext, bridge: ExtensionBridge) {
    this._context = context
    this._bridge = bridge
    this._storageLocation =
      workspace.getConfiguration("twinny").get("providerStorageLocation") ||
      "globalState"
    this._initializeProviders()
    this.registerHandlers()
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

  private registerHandlers() {
    this._bridge.handleAll({
      [PROVIDER_EVENT_NAME.addProvider]: (p) => void this.addProvider(p),
      [PROVIDER_EVENT_NAME.copyProvider]: (p) => this.copyProvider(p),
      [PROVIDER_EVENT_NAME.exportProviders]: () => this.exportProviders(),
      [PROVIDER_EVENT_NAME.getActiveChatProvider]: () =>
        void this.getActiveChatProvider(),
      [PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider]: () =>
        void this.getActiveEmbeddingsProvider(),
      [PROVIDER_EVENT_NAME.getActiveFimProvider]: () =>
        void this.getActiveFimProvider(),
      [PROVIDER_EVENT_NAME.getAllProviders]: () => this.getAllProviders(),
      [PROVIDER_EVENT_NAME.importProviders]: () => this.importProviders(),
      [PROVIDER_EVENT_NAME.removeProvider]: (p) => this.removeProvider(p),
      [PROVIDER_EVENT_NAME.resetProvidersToDefaults]: () =>
        this.resetProvidersToDefaults(),
      [PROVIDER_EVENT_NAME.setActiveChatProvider]: (p) =>
        void this.setActiveChatProvider(p),
      [PROVIDER_EVENT_NAME.setActiveEmbeddingsProvider]: (p) =>
        void this.setActiveEmbeddingsProvider(p),
      [PROVIDER_EVENT_NAME.setActiveFimProvider]: (p) =>
        void this.setActiveFimProvider(p),
      [PROVIDER_EVENT_NAME.testProvider]: (p) => this.testProvider(p),
      [PROVIDER_EVENT_NAME.updateProvider]: (p) => this.updateProvider(p)
    })
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
    this._bridge.emit(PROVIDER_EVENT_NAME.focusProviderTab, WEBUI_TABS.providers)
  }

  getTwinnyProvider() {
    return {
      apiHostname: "twinny.dev",
      apiPath: "/v1",
      apiProtocol: "https",
      id: "twinny-default",
      label: "Twinny.dev",
      modelName: "llama3.2:latest",
      provider: API_PROVIDERS.Twinny,
      type: "chat"
    } as TwinnyProvider
  }

  getOllamaConnection() {
    const config = workspace.getConfiguration("twinny")
    return {
      apiHostname: config.get<string>("ollamaHostname") || "0.0.0.0",
      apiPort: config.get<number>("ollamaApiPort") || 11434,
      apiProtocol: config.get<boolean>("ollamaUseTls") ? "https" : "http"
    }
  }

  /**
   * The models installed locally, so the default providers point at something
   * which actually exists instead of a hardcoded name which 404s on first run.
   */
  private async _getInstalledOllamaModels(): Promise<string[]> {
    try {
      const models = (await new OllamaService().fetchModels()) as ApiModel[]
      return models.map((model) => model?.name).filter(Boolean)
    } catch {
      return []
    }
  }

  getDefaultLocalProvider(installedModels: string[] = []) {
    return {
      ...this.getOllamaConnection(),
      apiPath: "/v1",
      id: "openai-compatible-default",
      label: "Ollama",
      modelName:
        installedModels.find(
          (model) => !EMBEDDING_MODEL_PATTERN.test(model)
        ) || FALLBACK_CHAT_MODEL,
      provider: API_PROVIDERS.Ollama,
      type: "chat"
    } as TwinnyProvider
  }

  getDefaultEmbeddingsProvider(installedModels: string[] = []) {
    return {
      ...this.getOllamaConnection(),
      apiPath: "/api/embed",
      id: uuidv4(),
      label: "Ollama Embedding",
      modelName:
        installedModels.find((model) => EMBEDDING_MODEL_PATTERN.test(model)) ||
        FALLBACK_EMBEDDINGS_MODEL,
      provider: API_PROVIDERS.Ollama,
      type: "embedding"
    } as TwinnyProvider
  }

  getDefaultFimProvider(installedModels: string[] = []) {
    const fimModel = installedModels.find(
      (model) =>
        FIM_MODEL_PATTERN.test(model) && !EMBEDDING_MODEL_PATTERN.test(model)
    )
    return {
      ...this.getOllamaConnection(),
      apiPath: "/api/generate",
      fimTemplate: fimModel
        ? FIM_TEMPLATE_FORMAT.automatic
        : FIM_TEMPLATE_FORMAT.codellama,
      label: "Ollama FIM",
      id: uuidv4(),
      modelName: fimModel || FALLBACK_FIM_MODEL,
      provider: API_PROVIDERS.Ollama,
      type: "fim"
    } as TwinnyProvider
  }

  async addDefaultProviders() {
    const installedModels = await this._getInstalledOllamaModels()
    await this.addDefaultChatProvider(installedModels)
    await this.addDefaultFimProvider(installedModels)
    await this.addDefaultEmbeddingsProvider(installedModels)
    await this.addTwinnyProvider()
  }

  async addDefaultLocalProvider(
    installedModels: string[] = []
  ): Promise<TwinnyProvider> {
    const provider = this.getDefaultLocalProvider(installedModels)
    if (!this._context.globalState.get(ACTIVE_CHAT_PROVIDER_STORAGE_KEY)) {
      await this.addDefaultProvider(provider)
    }
    return provider
  }

  async addDefaultChatProvider(
    installedModels: string[] = []
  ): Promise<TwinnyProvider> {
    const provider = this.getDefaultLocalProvider(installedModels)
    if (!this._context.globalState.get(ACTIVE_CHAT_PROVIDER_STORAGE_KEY)) {
      await this.addDefaultProvider(provider)
    }
    return provider
  }

  async addDefaultFimProvider(
    installedModels: string[] = []
  ): Promise<TwinnyProvider> {
    const provider = this.getDefaultFimProvider(installedModels)
    if (!this._context.globalState.get(ACTIVE_FIM_PROVIDER_STORAGE_KEY)) {
      await this.addDefaultProvider(provider)
    }
    return provider
  }

  async addDefaultEmbeddingsProvider(
    installedModels: string[] = []
  ): Promise<TwinnyProvider> {
    const provider = this.getDefaultEmbeddingsProvider(installedModels)

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
    this._bridge.emit(
      PROVIDER_EVENT_NAME.getAllProviders,
      (await this.getProviders()) || {}
    )
  }

  getActiveChatProvider() {
    const provider = this._context.globalState.get<TwinnyProvider>(
      ACTIVE_CHAT_PROVIDER_STORAGE_KEY
    )
    this._bridge.emit(PROVIDER_EVENT_NAME.getActiveChatProvider, provider)
    return provider
  }

  getActiveFimProvider() {
    const provider = this._context.globalState.get<TwinnyProvider>(
      ACTIVE_FIM_PROVIDER_STORAGE_KEY
    )
    this._bridge.emit(PROVIDER_EVENT_NAME.getActiveFimProvider, provider)
    return provider
  }

  getActiveEmbeddingsProvider() {
    const provider = this._context.globalState.get<TwinnyProvider>(
      ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY
    )
    this._bridge.emit(PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider, provider)
    return provider
  }

  setActiveChatProvider(provider?: TwinnyProvider) {
    if (!provider) return
    this._context.globalState.update(ACTIVE_CHAT_PROVIDER_STORAGE_KEY, provider)
    this._setSelectedModel(provider.modelName)
    return this.getActiveChatProvider()
  }

  private _setSelectedModel(modelName?: string) {
    this._context.globalState.update(
      `${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.selectedModel}`,
      modelName
    )
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
      if (!this._context.globalState.get(ACTIVE_CHAT_PROVIDER_STORAGE_KEY)) {
        this._context.globalState.update(
          ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
          provider
        )
        this._setSelectedModel(provider.modelName)
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

    const installedModels = await this._getInstalledOllamaModels()
    const chatProvider = await this.addDefaultChatProvider(installedModels)
    const fimProvider = await this.addDefaultFimProvider(installedModels)
    const embeddingsProvider = await this.addDefaultEmbeddingsProvider(
      installedModels
    )
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
      await workspace.fs.writeFile(fileUri, Buffer.from(content) as Uint8Array)
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
      this._bridge.emit(PROVIDER_EVENT_NAME.testProviderResult, {
        success: false,
        error: "Provider details not provided."
      })
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
      this._bridge.emit(PROVIDER_EVENT_NAME.testProviderResult, {
        success: true
      })
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
      this._bridge.emit(PROVIDER_EVENT_NAME.testProviderResult, {
        success: false,
        error: errorMessage
      })
    }
  }
}

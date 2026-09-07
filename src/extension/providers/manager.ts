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
  PROVIDER_EVENT_NAME,
  TWINNY_PROVIDERS_FILENAME,
  WEBUI_TABS
} from "../../common/constants"
import { ProviderSaveResult } from "../../common/messaging/protocol"
import {
  isProviderLike,
  normalizeProvider,
  ProviderType,
  validateProvider
} from "../../common/provider-validation"
import { ApiModel, TwinnyProvider } from "../../common/types"
import { ExtensionBridge } from "../messaging/bridge"

import { OllamaService } from "./ollama"
import { listProviderModels, testProvider } from "./probe"

export type { TwinnyProvider }

type Providers = Record<string, TwinnyProvider>

const ACTIVE_KEYS: Record<ProviderType, string> = {
  chat: ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  fim: ACTIVE_FIM_PROVIDER_STORAGE_KEY,
  embedding: ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY
}

const ACTIVE_EVENTS = {
  chat: PROVIDER_EVENT_NAME.getActiveChatProvider,
  fim: PROVIDER_EVENT_NAME.getActiveFimProvider,
  embedding: PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider
} as const

const EMBEDDING_MODEL_PATTERN = /embed|minilm|bge|e5|nomic/i
const FIM_MODEL_PATTERN =
  /code|coder|fim|starcoder|codestral|codegemma|stable-code/i

const FALLBACK_CHAT_MODEL = "codellama:7b-instruct"
const FALLBACK_FIM_MODEL = "codellama:7b-code"
const FALLBACK_EMBEDDINGS_MODEL = "all-minilm:latest"

const asType = (type: string): ProviderType =>
  type === "fim" || type === "embedding" ? type : "chat"

/**
 * Owns the list of providers and which one is active for each job.
 *
 * Providers live either in global state or in a JSON file (a setting), and
 * the active chat / FIM / embedding provider is a separate global-state entry
 * each, so the request paths can read it without touching the list.
 */
export class ProviderManager {
  private readonly _context: ExtensionContext
  private readonly _bridge: ExtensionBridge
  private readonly _storageLocation: string

  constructor(context: ExtensionContext, bridge: ExtensionBridge) {
    this._context = context
    this._bridge = bridge
    this._storageLocation =
      workspace.getConfiguration("twinny").get("providerStorageLocation") ||
      "globalState"
    void this._initialize()
    this._registerHandlers()
  }

  private async _initialize(): Promise<void> {
    const providers = await this.getProviders()
    if (Object.keys(providers).length === 0) {
      const legacy = this._context.globalState.get<Providers>(
        INFERENCE_PROVIDERS_STORAGE_KEY
      )
      if (this._storageLocation === "file" && legacy && Object.keys(legacy).length) {
        await this._saveProviders(legacy)
      } else {
        await this.addDefaultProviders()
      }
    }
    await this._repairActiveProviders()
    await this.broadcastProviders()
  }

  private _registerHandlers() {
    this._bridge.handleAll({
      [PROVIDER_EVENT_NAME.addProvider]: (p) => this.addProvider(p),
      [PROVIDER_EVENT_NAME.copyProvider]: (p) => this.copyProvider(p),
      [PROVIDER_EVENT_NAME.exportProviders]: () => this.exportProviders(),
      [PROVIDER_EVENT_NAME.getActiveChatProvider]: () =>
        void this.broadcastActive("chat"),
      [PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider]: () =>
        void this.broadcastActive("embedding"),
      [PROVIDER_EVENT_NAME.getActiveFimProvider]: () =>
        void this.broadcastActive("fim"),
      [PROVIDER_EVENT_NAME.getAllProviders]: () => this.broadcastProviders(),
      [PROVIDER_EVENT_NAME.importProviders]: () => this.importProviders(),
      [PROVIDER_EVENT_NAME.listProviderModels]: (p) =>
        listProviderModels(normalizeProvider(p)),
      [PROVIDER_EVENT_NAME.removeProvider]: (p) => this.removeProvider(p),
      [PROVIDER_EVENT_NAME.resetProvidersToDefaults]: () =>
        this.resetProvidersToDefaults(),
      [PROVIDER_EVENT_NAME.setActiveChatProvider]: (p) =>
        this.setActiveProvider("chat", p),
      [PROVIDER_EVENT_NAME.setActiveEmbeddingsProvider]: (p) =>
        this.setActiveProvider("embedding", p),
      [PROVIDER_EVENT_NAME.setActiveFimProvider]: (p) =>
        this.setActiveProvider("fim", p),
      [PROVIDER_EVENT_NAME.testProvider]: (p) =>
        testProvider(normalizeProvider(p)),
      [PROVIDER_EVENT_NAME.updateProvider]: (p) => this.updateProvider(p)
    })
  }

  /* ------------------------------------------------------------------------ */
  /*  Defaults                                                                */
  /* ------------------------------------------------------------------------ */

  public getOllamaConnection() {
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

  public getDefaultChatProvider(installedModels: string[] = []): TwinnyProvider {
    return {
      ...this.getOllamaConnection(),
      apiPath: "/v1",
      id: uuidv4(),
      label: "Ollama",
      modelName:
        installedModels.find((model) => !EMBEDDING_MODEL_PATTERN.test(model)) ||
        FALLBACK_CHAT_MODEL,
      provider: API_PROVIDERS.Ollama,
      type: "chat"
    }
  }

  public getDefaultEmbeddingsProvider(
    installedModels: string[] = []
  ): TwinnyProvider {
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
    }
  }

  public getDefaultFimProvider(installedModels: string[] = []): TwinnyProvider {
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
      id: uuidv4(),
      label: "Ollama FIM",
      modelName: fimModel || FALLBACK_FIM_MODEL,
      provider: API_PROVIDERS.Ollama,
      type: "fim"
    }
  }

  public async addDefaultProviders(): Promise<TwinnyProvider[]> {
    const installed = await this._getInstalledOllamaModels()
    const defaults = [
      this.getDefaultChatProvider(installed),
      this.getDefaultFimProvider(installed),
      this.getDefaultEmbeddingsProvider(installed)
    ]
    const providers = await this.getProviders()
    for (const provider of defaults) {
      providers[provider.id] = provider
      if (!this.getActiveProvider(asType(provider.type))) {
        await this._storeActive(asType(provider.type), provider)
      }
    }
    await this._saveProviders(providers)
    return defaults
  }

  /* ------------------------------------------------------------------------ */
  /*  Storage                                                                  */
  /* ------------------------------------------------------------------------ */

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

  public async getProviders(): Promise<Providers> {
    const providers =
      this._storageLocation === "file"
        ? await this._getProvidersFromFile()
        : this._context.globalState.get<Providers>(
            INFERENCE_PROVIDERS_STORAGE_KEY
          )
    return providers && typeof providers === "object" ? providers : {}
  }

  public async broadcastProviders() {
    this._bridge.emit(
      PROVIDER_EVENT_NAME.getAllProviders,
      await this.getProviders()
    )
  }

  private _providersFileUri() {
    return Uri.joinPath(this._context.globalStorageUri, TWINNY_PROVIDERS_FILENAME)
  }

  private async _getProvidersFromFile(): Promise<Providers | undefined> {
    try {
      const content = await workspace.fs.readFile(this._providersFileUri())
      return JSON.parse(new TextDecoder().decode(content)) as Providers
    } catch {
      return undefined
    }
  }

  private async _saveProvidersToFile(providers: Providers): Promise<void> {
    try {
      await workspace.fs.createDirectory(this._context.globalStorageUri)
      const content = JSON.stringify(providers, null, 2)
      await workspace.fs.writeFile(
        this._providersFileUri(),
        new TextEncoder().encode(content)
      )
    } catch (e) {
      console.error(e)
      window.showErrorMessage(
        `twinny could not write ${TWINNY_PROVIDERS_FILENAME}: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Active providers                                                         */
  /* ------------------------------------------------------------------------ */

  public getActiveProvider(type: ProviderType): TwinnyProvider | undefined {
    return this._context.globalState.get<TwinnyProvider>(ACTIVE_KEYS[type])
  }

  public getActiveChatProvider() {
    return this.getActiveProvider("chat")
  }

  public getActiveFimProvider() {
    return this.getActiveProvider("fim")
  }

  public getActiveEmbeddingsProvider() {
    return this.getActiveProvider("embedding")
  }

  private async _storeActive(type: ProviderType, provider?: TwinnyProvider) {
    await this._context.globalState.update(ACTIVE_KEYS[type], provider)
    if (type === "chat") {
      await this._context.globalState.update(
        `${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.selectedModel}`,
        provider?.modelName
      )
    }
  }

  public broadcastActive(type: ProviderType) {
    this._bridge.emit(ACTIVE_EVENTS[type], this.getActiveProvider(type))
  }

  public async setActiveProvider(type: ProviderType, provider?: TwinnyProvider) {
    if (!provider) return
    await this._storeActive(type, provider)
    this.broadcastActive(type)
  }

  public setActiveChatProvider(provider?: TwinnyProvider) {
    return this.setActiveProvider("chat", provider)
  }

  public setActiveFimProvider(provider?: TwinnyProvider) {
    return this.setActiveProvider("fim", provider)
  }

  public setActiveEmbeddingsProvider(provider?: TwinnyProvider) {
    return this.setActiveProvider("embedding", provider)
  }

  /**
   * An active entry can point at a provider that no longer exists (deleted
   * from a file, or an older build that never cleared it). Fall back to any
   * provider of the same type so the feature keeps working.
   */
  private async _repairActiveProviders() {
    const providers = Object.values(await this.getProviders())
    for (const type of ["chat", "fim", "embedding"] as ProviderType[]) {
      const active = this.getActiveProvider(type)
      if (active && providers.some((p) => p.id === active.id)) continue
      const replacement = providers.find((p) => p.type === type)
      if (replacement || active) await this._storeActive(type, replacement)
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  CRUD                                                                     */
  /* ------------------------------------------------------------------------ */

  private _prepare(input?: TwinnyProvider): ProviderSaveResult {
    if (!input) return { success: false, errors: { id: "No provider given." } }
    const provider = normalizeProvider(input)
    const { valid, errors } = validateProvider(provider)
    return valid ? { success: true, provider } : { success: false, errors }
  }

  public async addProvider(input?: TwinnyProvider): Promise<ProviderSaveResult> {
    const result = this._prepare(input)
    if (!result.success || !result.provider) return result
    const provider = { ...result.provider, id: uuidv4() }

    const providers = await this.getProviders()
    providers[provider.id] = provider
    await this._saveProviders(providers)

    const type = asType(provider.type)
    if (!this.getActiveProvider(type)) {
      await this._storeActive(type, provider)
      this.broadcastActive(type)
    }

    await this.broadcastProviders()
    return { success: true, provider }
  }

  public async updateProvider(
    input?: TwinnyProvider
  ): Promise<ProviderSaveResult> {
    const result = this._prepare(input)
    if (!result.success || !result.provider) return result
    const provider = result.provider
    if (!provider.id) {
      return { success: false, errors: { id: "The provider has no id." } }
    }

    const providers = await this.getProviders()
    const previous = providers[provider.id]
    providers[provider.id] = provider
    await this._saveProviders(providers)

    for (const type of ["chat", "fim", "embedding"] as ProviderType[]) {
      if (this.getActiveProvider(type)?.id !== provider.id) continue
      // Changing a provider's type leaves its old role without an active
      // entry; the same rules as a delete apply there.
      if (asType(provider.type) === type) {
        await this._storeActive(type, provider)
      } else {
        const replacement = Object.values(providers).find(
          (p) => p.type === type && p.id !== provider.id
        )
        await this._storeActive(type, replacement)
      }
      this.broadcastActive(type)
    }
    if (previous?.type !== provider.type) {
      const type = asType(provider.type)
      if (!this.getActiveProvider(type)) {
        await this._storeActive(type, provider)
        this.broadcastActive(type)
      }
    }

    await this.broadcastProviders()
    return { success: true, provider }
  }

  public async copyProvider(provider?: TwinnyProvider) {
    if (!provider) return
    await this.addProvider({ ...provider, label: `${provider.label} copy` })
  }

  public async removeProvider(provider?: TwinnyProvider) {
    if (!provider) return
    const providers = await this.getProviders()
    delete providers[provider.id]
    await this._saveProviders(providers)

    for (const type of ["chat", "fim", "embedding"] as ProviderType[]) {
      if (this.getActiveProvider(type)?.id !== provider.id) continue
      const replacement = Object.values(providers).find((p) => p.type === type)
      await this._storeActive(type, replacement)
      this.broadcastActive(type)
    }
    await this.broadcastProviders()
  }

  public async resetProvidersToDefaults(): Promise<void> {
    for (const type of ["chat", "fim", "embedding"] as ProviderType[]) {
      await this._storeActive(type, undefined)
    }
    await this._saveProviders({})
    await this.addDefaultProviders()
    for (const type of ["chat", "fim", "embedding"] as ProviderType[]) {
      this.broadcastActive(type)
    }
    await this.broadcastProviders()
    this.focusProviderTab()
  }

  public focusProviderTab = () => {
    this._bridge.emit(PROVIDER_EVENT_NAME.focusProviderTab, WEBUI_TABS.providers)
  }

  /* ------------------------------------------------------------------------ */
  /*  Import / export                                                          */
  /* ------------------------------------------------------------------------ */

  public async importProviders(): Promise<void> {
    const fileUris = await window.showOpenDialog({
      canSelectMany: false,
      filters: { JSON: ["json"] },
      openLabel: "Import providers"
    })
    if (!fileUris?.length) return

    let parsed: unknown
    try {
      const data = await workspace.fs.readFile(fileUris[0])
      parsed = JSON.parse(new TextDecoder().decode(data))
    } catch (e) {
      window.showErrorMessage(
        `Could not read the provider file: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
      return
    }

    // Accept the exported shape (an object keyed by id) and a plain array.
    const entries: unknown[] = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? Object.values(parsed as Record<string, unknown>)
        : []

    const providers = await this.getProviders()
    const problems: string[] = []
    let imported = 0

    for (const entry of entries) {
      if (!isProviderLike(entry)) {
        problems.push("an entry that is not a provider")
        continue
      }
      const provider = normalizeProvider(entry)
      const { valid, errors } = validateProvider(provider)
      if (!valid) {
        problems.push(
          `${provider.label || "unnamed"}: ${Object.values(errors).join(" ")}`
        )
        continue
      }
      // Keep ids so re-importing the same file updates rather than duplicates.
      if (!provider.id) provider.id = uuidv4()
      providers[provider.id] = provider
      imported++
    }

    if (imported === 0) {
      window.showErrorMessage(
        problems.length
          ? `No providers imported. ${problems[0]}`
          : "No providers found in that file."
      )
      return
    }

    await this._saveProviders(providers)
    await this._repairActiveProviders()
    for (const type of ["chat", "fim", "embedding"] as ProviderType[]) {
      this.broadcastActive(type)
    }
    await this.broadcastProviders()

    const skipped = problems.length ? `, ${problems.length} skipped` : ""
    window.showInformationMessage(`Imported ${imported} provider(s)${skipped}.`)
    if (problems.length) console.warn("Skipped providers:", problems)
  }

  public async exportProviders(): Promise<void> {
    const providers = await this.getProviders()
    if (Object.keys(providers).length === 0) {
      window.showInformationMessage("No providers to export.")
      return
    }
    const fileUri = await window.showSaveDialog({
      defaultUri: Uri.file("twinny-providers.json"),
      filters: { JSON: ["json"] },
      saveLabel: "Export providers"
    })
    if (!fileUri) return
    try {
      const content = JSON.stringify(providers, null, 2)
      await workspace.fs.writeFile(fileUri, new TextEncoder().encode(content))
      window.showInformationMessage(
        `Exported ${Object.keys(providers).length} provider(s).`
      )
    } catch (e) {
      window.showErrorMessage(
        `Could not export providers: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }
}

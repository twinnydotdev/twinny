import { TextDecoder, TextEncoder } from "util"
import { ExtensionContext, Uri, window, workspace } from "vscode"

import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY,
  ACTIVE_FIM_PROVIDER_STORAGE_KEY,
  EVENT_NAME,
  GLOBAL_STORAGE_KEY,
  INFERENCE_PROVIDERS_STORAGE_KEY,
  TWINNY_PROVIDERS_FILENAME
} from "../../common/constants"
import { PROVIDER_TYPES, ProviderType } from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"

export type Providers = Record<string, TwinnyProvider>

const ACTIVE_KEYS: Record<ProviderType, string> = {
  chat: ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  fim: ACTIVE_FIM_PROVIDER_STORAGE_KEY,
  embedding: ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY
}

/**
 * Where providers live. The list is either in global state or in a JSON
 * file (a setting); the active chat / FIM / embedding provider is a
 * separate global-state entry each, so the request paths can read it
 * without touching the list.
 *
 * Nothing here talks to the webview: the store is usable from activation,
 * before any sidebar exists, which is when first-run setup happens.
 */
export class ProviderStore {
  private readonly _location: string

  constructor(private readonly _context: ExtensionContext) {
    this._location =
      workspace.getConfiguration("twinny").get("providerStorageLocation") ||
      "globalState"
  }

  /* ---------------------------------------------------------------------- */
  /*  The list                                                               */
  /* ---------------------------------------------------------------------- */

  public async getProviders(): Promise<Providers> {
    const providers =
      this._location === "file"
        ? await this._readFile()
        : this._context.globalState.get<Providers>(INFERENCE_PROVIDERS_STORAGE_KEY)
    return providers && typeof providers === "object" ? providers : {}
  }

  public async saveProviders(providers: Providers): Promise<void> {
    if (this._location === "file") {
      await this._writeFile(providers)
    } else {
      await this._context.globalState.update(
        INFERENCE_PROVIDERS_STORAGE_KEY,
        providers
      )
    }
  }

  public async hasProviders(): Promise<boolean> {
    return Object.keys(await this.getProviders()).length > 0
  }

  /**
   * A file-backed store that is empty may be a fresh switch from global
   * state; carry the old list over rather than starting from nothing.
   */
  public async migrateLegacy(): Promise<boolean> {
    if (this._location !== "file") return false
    if (await this.hasProviders()) return false
    const legacy = this._context.globalState.get<Providers>(
      INFERENCE_PROVIDERS_STORAGE_KEY
    )
    if (!legacy || Object.keys(legacy).length === 0) return false
    await this.saveProviders(legacy)
    return true
  }

  /* ---------------------------------------------------------------------- */
  /*  Active providers                                                       */
  /* ---------------------------------------------------------------------- */

  public getActive(type: ProviderType): TwinnyProvider | undefined {
    return this._context.globalState.get<TwinnyProvider>(ACTIVE_KEYS[type])
  }

  public async setActive(type: ProviderType, provider?: TwinnyProvider) {
    await this._context.globalState.update(ACTIVE_KEYS[type], provider)
    if (type === "chat") {
      await this._context.globalState.update(
        `${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.selectedModel}`,
        provider?.modelName
      )
    }
  }

  /**
   * Adds providers to the list and makes each the active one for its job
   * where that job has none yet. Returns the types whose active entry
   * changed, so a caller with a webview can announce them.
   */
  public async addAll(providers: TwinnyProvider[]): Promise<ProviderType[]> {
    const all = await this.getProviders()
    const activated: ProviderType[] = []
    for (const provider of providers) all[provider.id] = provider
    await this.saveProviders(all)
    for (const provider of providers) {
      const type = asType(provider.type)
      if (this.getActive(type)) continue
      await this.setActive(type, provider)
      activated.push(type)
    }
    return activated
  }

  /**
   * An active entry can point at a provider that no longer exists (deleted
   * from a file, or an older build that never cleared it). Fall back to any
   * provider of the same type so the feature keeps working.
   */
  public async repairActive(): Promise<void> {
    const providers = Object.values(await this.getProviders())
    for (const type of PROVIDER_TYPES) {
      const active = this.getActive(type)
      if (active && providers.some((p) => p.id === active.id)) continue
      const replacement = providers.find((p) => p.type === type)
      if (replacement || active) await this.setActive(type, replacement)
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  File backing                                                            */
  /* ---------------------------------------------------------------------- */

  private _fileUri() {
    return Uri.joinPath(this._context.globalStorageUri, TWINNY_PROVIDERS_FILENAME)
  }

  private async _readFile(): Promise<Providers | undefined> {
    try {
      const content = await workspace.fs.readFile(this._fileUri())
      return JSON.parse(new TextDecoder().decode(content)) as Providers
    } catch {
      return undefined
    }
  }

  private async _writeFile(providers: Providers): Promise<void> {
    try {
      await workspace.fs.createDirectory(this._context.globalStorageUri)
      const content = JSON.stringify(providers, null, 2)
      await workspace.fs.writeFile(
        this._fileUri(),
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
}

export const asType = (type: string): ProviderType =>
  type === "fim" || type === "embedding" ? type : "chat"

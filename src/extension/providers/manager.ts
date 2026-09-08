import { TextEncoder } from "util"
import { v4 as uuidv4 } from "uuid"
import { ExtensionContext, Uri, window, workspace } from "vscode"

import {
  API_PROVIDERS,
  PROVIDER_EVENT_NAME,
  WEBUI_TABS
} from "../../common/constants"
import { ProviderSaveResult } from "../../common/messaging/protocol"
import { DiscoveredServer } from "../../common/provider-discovery"
import {
  isProviderLike,
  normalizeProvider,
  PROVIDER_TYPES,
  ProviderType,
  validateProvider
} from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"
import { ExtensionBridge } from "../messaging/bridge"
import { resolveProviderEndpoint } from "../p2p/endpoint"

import { applyDiscoveredServer, discoverLocalServers } from "./discovery"
import { listProviderModels, testProvider } from "./probe"
import { whenProviderSetupDone } from "./setup"
import { asType, ProviderStore } from "./store"

export type { TwinnyProvider }

const ACTIVE_EVENTS = {
  chat: PROVIDER_EVENT_NAME.getActiveChatProvider,
  fim: PROVIDER_EVENT_NAME.getActiveFimProvider,
  embedding: PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider
} as const

/**
 * The webview's window onto the provider list: every add, edit, switch,
 * test and import comes through here, and every change is announced back.
 * Storage itself is `ProviderStore`, which activation also uses.
 */
export class ProviderManager {
  private readonly _store: ProviderStore
  private readonly _bridge: ExtensionBridge

  constructor(context: ExtensionContext, bridge: ExtensionBridge) {
    this._store = new ProviderStore(context)
    this._bridge = bridge
    void this._initialize()
    this._registerHandlers()
  }

  private async _initialize(): Promise<void> {
    // First-run discovery may still be probing; showing an empty list it
    // is about to fill would send the person off to configure by hand.
    await whenProviderSetupDone()
    await this._store.repairActive()
    await this.broadcastProviders()
    if (!(await this._store.hasProviders())) this.focusProviderTab()
  }

  private _registerHandlers() {
    this._bridge.handleAll({
      [PROVIDER_EVENT_NAME.addProvider]: (p) => this.addProvider(p),
      [PROVIDER_EVENT_NAME.copyProvider]: (p) => this.copyProvider(p),
      [PROVIDER_EVENT_NAME.discoverProviders]: () => discoverLocalServers(),
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
        listProviderModels(resolveProviderEndpoint(normalizeProvider(p))),
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
        testProvider(resolveProviderEndpoint(normalizeProvider(p))),
      [PROVIDER_EVENT_NAME.updateProvider]: (p) => this.updateProvider(p),
      [PROVIDER_EVENT_NAME.useDiscoveredServer]: (server) =>
        this.useDiscoveredServer(server)
    })
  }

  /* ------------------------------------------------------------------------ */
  /*  Reading                                                                  */
  /* ------------------------------------------------------------------------ */

  public getProviders() {
    return this._store.getProviders()
  }

  public async broadcastProviders() {
    this._bridge.emit(
      PROVIDER_EVENT_NAME.getAllProviders,
      await this._store.getProviders()
    )
  }

  public getActiveProvider(type: ProviderType): TwinnyProvider | undefined {
    return this._store.getActive(type)
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

  public broadcastActive(type: ProviderType) {
    this._bridge.emit(ACTIVE_EVENTS[type], this._store.getActive(type))
  }

  private broadcastAllActive() {
    for (const type of PROVIDER_TYPES) this.broadcastActive(type)
  }

  public focusProviderTab = () => {
    this._bridge.emit(PROVIDER_EVENT_NAME.focusProviderTab, WEBUI_TABS.providers)
  }

  /* ------------------------------------------------------------------------ */
  /*  Active providers                                                         */
  /* ------------------------------------------------------------------------ */

  /**
   * Makes a provider the one used for a job. A model picked along the way
   * (the chat header's dropdown) becomes the provider's model: there is one
   * entry and one model, whichever picker last changed it.
   */
  public async setActiveProvider(type: ProviderType, provider?: TwinnyProvider) {
    if (!provider) return
    const providers = await this._store.getProviders()
    const stored = providers[provider.id]
    let active = provider
    if (stored) {
      const modelName = provider.modelName || stored.modelName
      active = { ...stored, modelName }
      if (modelName !== stored.modelName) {
        providers[provider.id] = active
        await this._store.saveProviders(providers)
        await this.broadcastProviders()
      }
    }
    await this._store.setActive(type, active)
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

  /* ------------------------------------------------------------------------ */
  /*  Discovery                                                                */
  /* ------------------------------------------------------------------------ */

  /** The providers tab's "use this one" on a server discovery found. */
  public async useDiscoveredServer(
    server?: DiscoveredServer
  ): Promise<TwinnyProvider[]> {
    if (!server) return []
    const providers = await applyDiscoveredServer(this._store, server)
    this.broadcastAllActive()
    await this.broadcastProviders()
    return providers
  }

  /**
   * Starts over: clears everything, which puts the tab back on its welcome.
   * The welcome then searches for local servers and offers what it finds,
   * so a reset looks exactly like a first run.
   */
  public async resetProvidersToDefaults(): Promise<void> {
    for (const type of PROVIDER_TYPES) await this._store.setActive(type, undefined)
    await this._store.saveProviders({})
    this.broadcastAllActive()
    await this.broadcastProviders()
    this.focusProviderTab()
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

    const activated = await this._store.addAll([provider])
    for (const type of activated) this.broadcastActive(type)
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

    const providers = await this._store.getProviders()
    const previous = providers[provider.id]
    providers[provider.id] = provider
    await this._store.saveProviders(providers)

    for (const type of PROVIDER_TYPES) {
      if (this._store.getActive(type)?.id !== provider.id) continue
      // Changing a provider's type leaves its old role without an active
      // entry; the same rules as a delete apply there.
      if (asType(provider.type) === type) {
        await this._store.setActive(type, provider)
      } else {
        const replacement = Object.values(providers).find(
          (p) => p.type === type && p.id !== provider.id
        )
        await this._store.setActive(type, replacement)
      }
      this.broadcastActive(type)
    }
    if (previous?.type !== provider.type) {
      const type = asType(provider.type)
      if (!this._store.getActive(type)) {
        await this._store.setActive(type, provider)
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
    const providers = await this._store.getProviders()
    delete providers[provider.id]
    await this._store.saveProviders(providers)

    for (const type of PROVIDER_TYPES) {
      if (this._store.getActive(type)?.id !== provider.id) continue
      const replacement = Object.values(providers).find((p) => p.type === type)
      await this._store.setActive(type, replacement)
      this.broadcastActive(type)
    }
    await this.broadcastProviders()
  }

  /** A device that was unpaired takes its providers with it. */
  public async removeProvidersForDevice(deviceId: string): Promise<void> {
    const providers = await this._store.getProviders()
    const doomed = Object.values(providers).filter(
      (p) => p.provider === API_PROVIDERS.TwinnyP2P && p.deviceId === deviceId
    )
    for (const provider of doomed) await this.removeProvider(provider)
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

    const providers = await this._store.getProviders()
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

    await this._store.saveProviders(providers)
    await this._store.repairActive()
    this.broadcastAllActive()
    await this.broadcastProviders()

    const skipped = problems.length ? `, ${problems.length} skipped` : ""
    window.showInformationMessage(`Imported ${imported} provider(s)${skipped}.`)
    if (problems.length) console.warn("Skipped providers:", problems)
  }

  public async exportProviders(): Promise<void> {
    const providers = await this._store.getProviders()
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

import { TextEncoder } from "util"
import { v4 as uuidv4 } from "uuid"
import { commands, ExtensionContext, Uri, window, workspace } from "vscode"

import {
  API_PROVIDERS,
  PROVIDER_EVENT_NAME,
  WEBUI_TABS
} from "../../common/constants"
import { messageOf } from "../../common/errors"
import { ProviderSaveResult } from "../../common/messaging/protocol"
import { DiscoveredServer } from "../../common/provider-discovery"
import {
  isProviderLike,
  isRemoteProvider,
  normalizeProvider,
  PROVIDER_TYPES,
  ProviderType,
  validateProvider
} from "../../common/provider-validation"
import type { TeamOpen } from "../../common/team"
import { TwinnyProvider } from "../../common/types"
import { ExtensionBridge } from "../messaging/bridge"

import { RemoteCredentials } from "./credentials"
import { applyDiscoveredServer, discoverLocalServers } from "./discovery"
import { resolveProviderEndpoint } from "./endpoint"
import {
  describePolicy,
  isTeamProvider,
  policyRefusal,
  TeamPolicyStore,
  teamProviderIdFor
} from "./policy"
import { listProviderModels, testProvider } from "./probe"
import { whenProviderSetupDone } from "./setup"
import { asType, ProviderStore } from "./store"
import { TeamConnection } from "./team"

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
/** What else wants to know when the team connection changes. */
export interface ProviderManagerHooks {
  /** After connecting to a team or leaving one. */
  teamChanged?(): Promise<void> | void
}

const TEAM_FEATURE_LABEL: Record<ProviderType, string> = { chat: "chat", fim: "autocomplete", embedding: "embeddings" }

export class ProviderManager {
  private readonly _store: ProviderStore
  private readonly _bridge: ExtensionBridge
  private readonly _credentials: RemoteCredentials
  private readonly _team: TeamConnection
  /** What an opened link asked the tab to show, until the tab collects it. */
  private _pendingOpen?: TeamOpen
  private readonly _policy: TeamPolicyStore

  constructor(
    context: ExtensionContext,
    bridge: ExtensionBridge,
    private readonly _hooks: ProviderManagerHooks = {}
  ) {
    this._store = new ProviderStore(context)
    this._bridge = bridge
    this._credentials = new RemoteCredentials(context)
    this._policy = new TeamPolicyStore(context.globalState)
    this._team = new TeamConnection(
      this._store,
      this._credentials,
      this._policy
    )
    context.subscriptions.push({ dispose: () => this._team.cancel() })
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
    // A policy change by the team's admin reaches everyone at their next start.
    await this.refreshPolicy(true)
    await this.warnIfKeyMissing()
  }

  /**
   * Team entries with no key behind them mean VS Code's secret storage did
   * not keep it: on Linux, usually no OS keyring. Said once at start, with
   * the fix, so the person does not discover it as a string of failed
   * requests and sign in again on a machine that will lose the key again.
   */
  private async warnIfKeyMissing(): Promise<void> {
    const status = await this._team.status()
    if (!status?.keyMissing) return
    const reconnect = "Open Providers"
    const configure = "Configure Runtime Arguments"
    const linux = process.platform === "linux"
    const choice = await window.showWarningMessage(
      `Your team key for ${status.url} is gone from VS Code's secret storage, so team requests will fail.` +
        (linux
          ? " On Linux this usually means no OS keyring: add \"password-store\": \"basic\" to the runtime arguments, restart VS Code, then reconnect once."
          : " Reconnect to sign in again."),
      reconnect,
      ...(linux ? [configure] : [])
    )
    if (choice === reconnect) this.focusProviderTab()
    else if (choice === configure)
      await commands.executeCommand(
        "workbench.action.configureRuntimeArguments"
      )
  }

  private _policyCheckedAt = 0

  /**
   * Re-reads the team policy when it is stale, applies it to the active
   * providers, and says so when it appeared or changed.
   */
  private async refreshPolicy(force = false): Promise<void> {
    if (!force && Date.now() - this._policyCheckedAt < 60_000) return
    this._policyCheckedAt = Date.now()
    const before = this._policy.get()
    const after = await this._team.refreshPolicy()
    const changed =
      JSON.stringify(before?.policy ?? null) !==
      JSON.stringify(after?.policy ?? null)
    if (!changed) return
    await this.enforcePolicy()
    await this.broadcastPolicy()
    if (after) {
      const lines = describePolicy(after.policy)
      void window.showInformationMessage(
        `${before ? "Your team's policy changed" : "Your team now sets a policy"} (${after.url}): ${lines.join(" ")}`
      )
    } else if (before) {
      void window.showInformationMessage(
        `Your team (${before.url}) no longer sets a policy.`
      )
    }
  }

  /**
   * The active provider for each job must satisfy the policy. One that
   * does not is replaced by the team's own entry for the job, else by any
   * allowed provider, else by nothing.
   */
  private async enforcePolicy(): Promise<void> {
    const state = this._policy.get()
    if (!state) return
    const providers = await this._store.getProviders()
    for (const type of PROVIDER_TYPES) {
      const active = this._store.getActive(type)
      if (!active || !policyRefusal(state, "activate", active, type)) continue
      const teamId = teamProviderIdFor(state, type)
      const replacement =
        (teamId && providers[teamId]) ||
        Object.values(providers).find(
          (p) => p.type === type && !policyRefusal(state, "activate", p, type)
        )
      await this._store.setActive(type, replacement)
      this.broadcastActive(type)
    }
  }

  /** The team connection as the tab shows it: present with or without a policy. */
  private async broadcastPolicy() {
    this._bridge.emit(
      PROVIDER_EVENT_NAME.getTeamPolicy,
      (await this._team.status()) ?? null
    )
  }

  private _registerHandlers() {
    this._bridge.handleAll({
      [PROVIDER_EVENT_NAME.addProvider]: (p) => this.addProvider(p),
      [PROVIDER_EVENT_NAME.previewTeam]: async (input) => {
        await whenProviderSetupDone()
        return this._team.preview(input)
      },
      [PROVIDER_EVENT_NAME.applyTeam]: async (input) => {
        const result = await this._team.apply(input)
        await this.enforcePolicy()
        this.broadcastAllActive()
        await this.broadcastProviders()
        await this.broadcastPolicy()
        await this._hooks.teamChanged?.()
        const features = result.connected.map((type) => TEAM_FEATURE_LABEL[type]).join(", ")
        void window.showInformationMessage(
          `Connected to your team: ${features}.${result.connected.includes("embedding") ? " If your embedding model changed, rebuild the workspace index from the Embeddings tab." : ""}`
        )
        return result
      },
      [PROVIDER_EVENT_NAME.cancelTeam]: () => this._team.cancel(),
      [PROVIDER_EVENT_NAME.getTeamPolicy]: async () => {
        await this.refreshPolicy()
        return (await this._team.status()) ?? null
      },
      [PROVIDER_EVENT_NAME.leaveTeam]: async () => {
        const result = await this._team.leave()
        this.broadcastAllActive()
        await this.broadcastProviders()
        await this.broadcastPolicy()
        await this._hooks.teamChanged?.()
        return result
      },
      [PROVIDER_EVENT_NAME.startTeamSignIn]: (input) =>
        this._team.startSignIn(input),
      [PROVIDER_EVENT_NAME.takeTeamOpen]: () => {
        const open = this._pendingOpen ?? null
        this._pendingOpen = undefined
        return open
      },
      [PROVIDER_EVENT_NAME.pollTeamSignIn]: async (input) => {
        await whenProviderSetupDone()
        return this._team.pollSignIn(input)
      },
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
    this._bridge.emit(
      PROVIDER_EVENT_NAME.focusProviderTab,
      WEBUI_TABS.providers
    )
  }

  /**
   * An invite or team link was opened (vscode://rjmacarthy.twinny/join).
   * With a code the invite is opened here, so the key never passes through
   * the webview, and the tab shows the team's defaults to confirm. Without
   * one, or when the invite cannot be opened, the tab shows Connect to team
   * with the URL filled in and the reason, so Request a key is one click.
   * Kept until the tab asks for it, since the webview may not be up yet.
   */
  public async openTeam(input: {
    url: string
    code?: string
  }): Promise<TeamOpen> {
    let open: TeamOpen = { url: input.url }
    if (input.code) {
      try {
        await whenProviderSetupDone()
        const opened = await this._team.redeemInvite({
          url: input.url,
          code: input.code
        })
        open = { url: opened.preview.url, invite: opened }
      } catch (error) {
        open = {
          url: input.url,
          error: messageOf(error)
        }
      }
    }
    this._pendingOpen = open
    this.focusProviderTab()
    this._bridge.emit(PROVIDER_EVENT_NAME.openTeam, open)
    return open
  }

  /* ------------------------------------------------------------------------ */
  /*  Active providers                                                         */
  /* ------------------------------------------------------------------------ */

  /**
   * Makes a provider the one used for a job. A model picked along the way
   * (the chat header's dropdown) becomes the provider's model: there is one
   * entry and one model, whichever picker last changed it.
   */
  public async setActiveProvider(
    type: ProviderType,
    provider?: TwinnyProvider
  ) {
    if (!provider) return
    const refusal = policyRefusal(
      this._policy.get(),
      "activate",
      provider,
      type
    )
    if (refusal) {
      void window.showWarningMessage(refusal)
      // The webview may have moved its selection; put it back.
      this.broadcastActive(type)
      return
    }
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
    // The team connection is not the person's to lose by accident: its
    // entries (and their key) survive a reset. Leave team removes them.
    const all = await this._store.getProviders()
    const team = Object.values(all).filter(isTeamProvider)
    for (const type of PROVIDER_TYPES)
      await this._store.setActive(type, undefined)
    await this._store.saveProviders(
      Object.fromEntries(team.map((p) => [p.id, p]))
    )
    for (const provider of team)
      await this._store.setActive(asType(provider.type), provider)
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
    const refusal = policyRefusal(this._policy.get(), "add", provider)
    if (refusal)
      return { success: false, errors: { ...errors, provider: refusal } }
    if (
      isRemoteProvider(provider.provider) &&
      !provider.apiKey &&
      !(provider.id && this._credentials.has(provider.id))
    ) {
      errors.apiKey = "Enter the gateway access token."
      return { success: false, errors }
    }
    return valid ? { success: true, provider } : { success: false, errors }
  }

  /**
   * A gateway token goes to secret storage and comes off the provider
   * before it is saved; a blank token on an edit keeps the stored one.
   */
  private async _stashToken(provider: TwinnyProvider): Promise<TwinnyProvider> {
    if (!isRemoteProvider(provider.provider)) return provider
    if (provider.apiKey)
      await this._credentials.set(provider.id, provider.apiKey)
    return { ...provider, apiKey: "" }
  }

  public async addProvider(
    input?: TwinnyProvider
  ): Promise<ProviderSaveResult> {
    const result = this._prepare(input)
    if (!result.success || !result.provider) return result
    const provider = await this._stashToken({
      ...result.provider,
      id: uuidv4()
    })

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
    if (!result.provider.id) {
      return { success: false, errors: { id: "The provider has no id." } }
    }
    const provider = await this._stashToken(result.provider)

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
    await this.addProvider(
      resolveProviderEndpoint({ ...provider, label: `${provider.label} copy` })
    )
  }

  public async removeProvider(provider?: TwinnyProvider) {
    if (!provider) return
    const providers = await this._store.getProviders()
    delete providers[provider.id]
    await this._store.saveProviders(providers)
    if (isRemoteProvider(provider.provider))
      await this._credentials.delete(provider.id)

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
          messageOf(e)
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
        `Could not export providers: ${messageOf(e)}`
      )
    }
  }
}

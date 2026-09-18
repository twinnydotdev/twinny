import { createHash, randomUUID } from "node:crypto"
import os from "node:os"

import { API_PROVIDERS, FIM_TEMPLATE_FORMAT } from "../../common/constants"
import { ProviderType } from "../../common/provider-validation"
import type {
  TeamApplyRequest,
  TeamApplyResult,
  TeamConnectionRequest,
  TeamPolicyState,
  TeamPreview,
  TeamSignInStart,
  TeamSignInStatus,
  TeamStatus
} from "../../common/team"
import { TwinnyProvider } from "../../common/types"
import { RemoteInferenceProvider } from "../../protocol/client"
import type { RemoteTeam } from "../../protocol/types"
import { resolveFimFormat } from "../completion/fim-templates"

import { isTeamProvider, policyIsEmpty, TeamPolicyStorage } from "./policy"

export interface TeamStore {
  getProviders(): Promise<Record<string, TwinnyProvider>>
  saveProviders(providers: Record<string, TwinnyProvider>): Promise<void>
  getActive(type: ProviderType): TwinnyProvider | undefined
  setActive(type: ProviderType, provider?: TwinnyProvider): Promise<void>
}

export interface TeamCredentials {
  get(id: string): string | undefined
  set(id: string, token: string): Promise<void>
  delete(id: string): Promise<void>
}

/** Where the team is and the key that speaks for this developer there. */
export interface TeamSession {
  url: string
  token: string
}

/**
 * A team connected before its admin set a policy has team entries but
 * no stored policy. Their ids (`team-<group>-<type>`) and address say
 * which gateway to ask.
 */
const connectedTeam = async (store: Pick<TeamStore, "getProviders">): Promise<TeamPolicyState | undefined> => {
  const providers = Object.values(await store.getProviders()).filter(isTeamProvider)
  const first = providers[0]
  if (!first) return undefined
  const group = first.id.split("-")[1]
  const mine = providers.filter((provider) => provider.id.split("-")[1] === group)
  const protocol = first.apiProtocol || "http"
  const port = first.apiPort ? `:${first.apiPort}` : ""
  const url = `${protocol}://${first.apiHostname}${port}${(first.apiPath || "").replace(/\/+$/, "")}`
  return { url, policy: {}, providerIds: mine.map((provider) => provider.id), fetchedAt: "" }
}

/**
 * The connected team's gateway and key, for anything that talks to the
 * team outside the provider list (sharing this computer, say). Undefined
 * when not connected, or when the key is gone from secret storage.
 */
export const teamSession = async (
  store: Pick<TeamStore, "getProviders">,
  credentials: Pick<TeamCredentials, "get">,
  policies: Pick<TeamPolicyStorage, "get">
): Promise<TeamSession | undefined> => {
  const state = policies.get() ?? (await connectedTeam(store))
  if (!state) return undefined
  const token = state.providerIds.map((id) => credentials.get(id)).find((value) => !!value)
  return token ? { url: state.url, token } : undefined
}

const ROLES = ["chat", "fim", "embedding"] as const
/** Per feature. A cold model on a shared box can take this long to answer once. */
const CAPABILITY = {
  chat: "chat",
  fim: "fim",
  embedding: "embeddings"
} as const
const LABELS = { chat: "Chat", fim: "Autocomplete", embedding: "Embeddings" }

export const teamUrl = (input: string): URL => {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error(
      "Enter the gateway URL, for example https://ai.example.com."
    )
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Use an HTTP or HTTPS gateway URL without credentials, query parameters or fragments."
    )
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/"
  if (/\/(admin|twinny\/v1)(\/.*)?$/.test(url.pathname))
    throw new Error("Enter the gateway base URL without /admin or /twinny/v1.")
  return url
}

const signature = (team: RemoteTeam) =>
  JSON.stringify({ defaults: team.defaults, models: team.models, policy: team.policy ?? null })

/** Policy kept in memory only; the extension passes global state. */
export const memoryPolicyStorage = (): TeamPolicyStorage => {
  let state: TeamPolicyState | undefined
  return {
    get: () => state,
    set: async (next) => {
      state = next
    },
    clear: async () => {
      state = undefined
    }
  }
}
const activeSignature = (provider?: TwinnyProvider) =>
  JSON.stringify(provider ?? null)

interface Pending {
  preview: TeamPreview
  token: string
  team: RemoteTeam
  providers: TwinnyProvider[]
  active: Record<ProviderType, string>
}

/** A sign-in under way: the device code never leaves the extension. */
interface SignIn {
  id: string
  url: string
  deviceCode: string
  expiresAt: number
  intervalMs: number
  lastPollAt: number
}

/** What this machine suggests to the admin. Cosmetic; the admin names the key. */
export const signInSuggestion = (): { name?: string; machine?: string } => {
  const pick = (value: string | undefined) => {
    const text = (value ?? "").trim().slice(0, 64)
    return /^[A-Za-z0-9][A-Za-z0-9._@ -]*$/.test(text) ? text : undefined
  }
  let user: string | undefined
  try {
    user = os.userInfo().username
  } catch {
    user = undefined
  }
  const name = pick(user)
  const machine = pick(os.hostname())
  return { ...(name ? { name } : {}), ...(machine ? { machine } : {}) }
}

/** Preview, explicit consent, then one batch of providers. No personal entry is deleted. */
export class TeamConnection {
  private pending?: Pending
  private expires?: ReturnType<typeof setTimeout>
  private busy = false
  private generation = 0
  private signIn?: SignIn
  /** The key a sign-in produced, so a re-check of the same URL needs no pasting. */
  private lastKey?: { url: string; token: string }

  constructor(
    private readonly store: TeamStore,
    private readonly credentials: TeamCredentials,
    private readonly policies: TeamPolicyStorage = memoryPolicyStorage()
  ) {}

  private async read(url: string, token: string) {
    const client = new RemoteInferenceProvider({ baseUrl: url, token })
    const options = { signal: AbortSignal.timeout(5_000) }
    const [team, identity] = await Promise.all([
      client.team(options),
      client.whoami(options)
    ])
    if (identity.shared)
      throw new Error(
        "Use your personal gateway key. A shared token cannot connect a team account."
      )
    return { team, identity }
  }

  public async preview(input: TeamConnectionRequest): Promise<TeamPreview> {
    if (this.busy) throw new Error("A team connection is already in progress.")
    this.busy = true
    this.cancel()
    const generation = this.generation
    try {
      if (!input || typeof input.url !== "string" || typeof input.token !== "string") {
        throw new Error("Enter the gateway URL and your personal key.")
      }
      const parsed = teamUrl(input.url)
      const url = parsed.href.replace(/\/+$/, "")
      const typed = input.token.trim() || (this.lastKey?.url === url ? this.lastKey.token : "")
      const token = typed || (await this.storedKey(url))
      if (!token) throw new Error("Enter the gateway URL and your personal key.")
      const { team, identity } = await this.read(url, token)
      if (generation !== this.generation)
        throw new Error("Connection check cancelled.")
      const group = createHash("sha256").update(url).digest("hex").slice(0, 20)
      const preview: TeamPreview = {
        id: randomUUID(),
        url,
        identity: identity.key,
        roles: [],
        ...(team.policy && !policyIsEmpty(team.policy) ? { policy: team.policy } : {})
      }
      const providers: TwinnyProvider[] = []
      const active = {} as Record<ProviderType, string>
      // Nothing is sent to the models here: the admin's defaults are taken
      // as given, so connecting is one round trip and never waits on a cold
      // model, a rate limit or a busy gateway. Each provider can be tested
      // from the Providers tab afterwards.
      for (const type of ROLES) {
        const alias = team.defaults[CAPABILITY[type]]
        const current = this.store.getActive(type)
        active[type] = activeSignature(current)
        const row: TeamPreview["roles"][number] = {
          type,
          ...(alias ? { alias } : {}),
          ...(current
            ? {
                current: {
                  id: current.id,
                  label: current.label,
                  modelName: current.modelName
                }
              }
            : {})
        }
        if (alias) {
          const provider: TwinnyProvider = {
            id: `team-${group}-${type}`,
            label: `Team ${LABELS[type]}`,
            provider: API_PROVIDERS.TwinnyRemote,
            type,
            modelName: alias,
            apiProtocol: parsed.protocol.slice(0, -1),
            apiHostname: parsed.hostname,
            apiPort: Number(
              parsed.port || (parsed.protocol === "https:" ? 443 : 80)
            ),
            apiPath: parsed.pathname.replace(/\/+$/, ""),
            apiKey: "",
            // The alias is what the gateway is asked for, so it is the model
            // name here; the prompt format comes from the backend model the
            // gateway says sits behind it (an older gateway says nothing, and
            // then the alias name is all there is to go on).
            ...(type === "fim"
              ? {
                  fimTemplate: resolveFimFormat(
                    team.models.find((m) => m.id === alias)?.model ?? alias,
                    FIM_TEMPLATE_FORMAT.automatic
                  )
                }
              : {})
          }
          providers.push(provider)
        }
        preview.roles.push(row)
        if (generation !== this.generation)
          throw new Error("Connection check cancelled.")
      }
      this.pending = { preview, token, team, providers, active }
      // A typed or signed-in key is held until apply; one read from secret
      // storage is not copied, so leaving the team leaves nothing behind.
      if (typed) this.lastKey = { url, token }
      this.expires = setTimeout(() => this.cancel(), 5 * 60_000)
      this.expires.unref()
      return preview
    } finally {
      this.busy = false
    }
  }

  /**
   * The key already held for this gateway, so reconnecting (after a
   * restart, or to pick up changed defaults) needs no pasting and no new
   * sign-in. A key is minted per person; asking for another one at every
   * reconnect would fill the team's seats with copies.
   */
  private async storedKey(url: string): Promise<string> {
    const state = this.policies.get() ?? (await connectedTeam(this.store))
    if (!state || state.url !== url) return ""
    return state.providerIds.map((id) => this.credentials.get(id)).find((value) => !!value) ?? ""
  }

  public cancel() {
    this.generation++
    clearTimeout(this.expires)
    this.pending = undefined
    this.signIn = undefined
  }

  /** The policy in force, if the developer is connected to a team that sets one. */
  public policy(): TeamPolicyState | undefined {
    return this.policies.get()
  }

  /**
   * The connection as the Providers tab shows it. A team that sets no
   * policy stores nothing at connect time, so this falls back to the
   * team's provider entries: the connection outlives a restart either
   * way, and the tab must not send a connected developer to sign in
   * again (which costs the team another key and seat).
   */
  public async status(): Promise<TeamStatus | undefined> {
    const state = this.policies.get() ?? (await connectedTeam(this.store))
    if (!state) return undefined
    const hasKey = state.providerIds.some((id) => !!this.credentials.get(id))
    return hasKey ? state : { ...state, keyMissing: true }
  }

  /**
   * Leaves the team: the team's provider entries and their key go, the
   * policy goes, and each job falls back to any remaining provider.
   */
  public async leave(): Promise<{ removed: number }> {
    if (this.busy) throw new Error("A team connection is already in progress.")
    const state = this.policies.get() ?? (await connectedTeam(this.store))
    if (!state) throw new Error("You are not connected to a team.")
    this.busy = true
    try {
      const providers = await this.store.getProviders()
      let removed = 0
      for (const id of state.providerIds) {
        if (!providers[id]) continue
        delete providers[id]
        removed++
        await this.credentials.delete(id)
      }
      await this.store.saveProviders(providers)
      for (const type of ROLES) {
        const active = this.store.getActive(type)
        if (active && state.providerIds.includes(active.id)) {
          const replacement = Object.values(providers).find((provider) => provider.type === type)
          await this.store.setActive(type, replacement)
        }
      }
      if (this.policies.get()) await this.policies.clear()
      this.cancel()
      return { removed }
    } finally {
      this.busy = false
    }
  }

  /**
   * Re-reads the policy from the team gateway, for activation: an admin's
   * change reaches every developer at their next VS Code start. A gateway
   * that no longer sends a policy releases the developer from it. Any
   * failure to reach the gateway keeps what was agreed.
   */
  /** The connected team's gateway and key, or nothing. */
  public session(): Promise<TeamSession | undefined> {
    return teamSession(this.store, this.credentials, this.policies)
  }

  public async refreshPolicy(): Promise<TeamPolicyState | undefined> {
    const state = this.policies.get() ?? (await connectedTeam(this.store))
    if (!state) return undefined
    const stored = this.policies.get()
    const token = state.providerIds.map((id) => this.credentials.get(id)).find((value) => !!value)
    if (!token) return stored
    let team: RemoteTeam
    try {
      const client = new RemoteInferenceProvider({ baseUrl: state.url, token })
      team = await client.team({ signal: AbortSignal.timeout(5_000) })
    } catch {
      return stored
    }
    if (!team.policy || policyIsEmpty(team.policy)) {
      if (stored) await this.policies.clear()
      return undefined
    }
    const next: TeamPolicyState = { ...state, policy: team.policy, fetchedAt: new Date().toISOString() }
    if (!stored || JSON.stringify(next.policy) !== JSON.stringify(stored.policy)) await this.policies.set(next)
    return next
  }

  /**
   * Opens an invite link: the code becomes a key, once, and the usual
   * preview runs with it, so the developer lands on the same screen as
   * someone who pasted a key. The key is held until apply, like a sign-in.
   */
  public async redeemInvite(input: { url: string; code: string }): Promise<{ name: string; preview: TeamPreview }> {
    if (!input || typeof input.url !== "string" || typeof input.code !== "string" || !input.code.trim()) {
      throw new Error("The invite link is incomplete. Ask your admin for a new one.")
    }
    const url = teamUrl(input.url).href.replace(/\/+$/, "")
    const client = new RemoteInferenceProvider({ baseUrl: url })
    const opened = await client.join(
      { code: input.code.trim(), ...(signInSuggestion().machine ? { machine: signInSuggestion().machine } : {}) },
      { signal: AbortSignal.timeout(10_000) }
    )
    const preview = await this.preview({ url, token: opened.key })
    return { name: opened.name, preview }
  }

  /**
   * Asks the gateway for a sign-in code. The device code stays here; the
   * webview gets the short code to read to the admin.
   */
  public async startSignIn(input: { url: string }): Promise<TeamSignInStart> {
    if (!input || typeof input.url !== "string") throw new Error("Enter the gateway URL.")
    const url = teamUrl(input.url).href.replace(/\/+$/, "")
    this.signIn = undefined
    const client = new RemoteInferenceProvider({ baseUrl: url })
    const started = await client.startSignIn(signInSuggestion(), { signal: AbortSignal.timeout(10_000) })
    const signIn: SignIn = {
      id: randomUUID(),
      url,
      deviceCode: started.deviceCode,
      expiresAt: Date.parse(started.expiresAt) || Date.now() + 10 * 60_000,
      intervalMs: Math.max(1, started.interval) * 1000,
      lastPollAt: 0
    }
    this.signIn = signIn
    return { id: signIn.id, url, userCode: started.userCode, expiresAt: new Date(signIn.expiresAt).toISOString(), intervalMs: signIn.intervalMs }
  }

  /**
   * One poll. When the admin has approved, the key is taken from the
   * gateway once and the usual preview runs with it, so the developer
   * lands on the same screen as someone who pasted a key.
   */
  public async pollSignIn(input: { id: string }): Promise<TeamSignInStatus> {
    const signIn = this.signIn
    if (!signIn || input?.id !== signIn.id) return { status: "expired" }
    if (Date.now() >= signIn.expiresAt) {
      this.signIn = undefined
      return { status: "expired" }
    }
    // Never faster than the gateway asked for, whatever the webview does.
    const wait = signIn.lastPollAt + signIn.intervalMs - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    if (this.signIn !== signIn) return { status: "expired" }
    signIn.lastPollAt = Date.now()
    const client = new RemoteInferenceProvider({ baseUrl: signIn.url })
    const result = await client.pollSignIn(signIn.deviceCode, { signal: AbortSignal.timeout(10_000) })
    switch (result.status) {
      case "pending":
      case "slow-down":
        return { status: "pending" }
      case "denied":
      case "expired":
        this.signIn = undefined
        return { status: result.status }
      case "approved": {
        this.signIn = undefined
        const preview = await this.preview({ url: signIn.url, token: result.key })
        return { status: "approved", name: result.name, preview }
      }
    }
  }

  public async apply(input: TeamApplyRequest): Promise<TeamApplyResult> {
    if (this.busy) throw new Error("A team connection is already in progress.")
    const pending = this.pending
    if (!pending || input?.previewId !== pending.preview.id)
      throw new Error("This preview expired. Check the connection again.")
    if (!pending.providers.length)
      throw new Error(
        "Your admin has not set a default model for any feature yet. Ask them to, then check again."
      )
    this.busy = true
    try {
      const latest = await this.read(pending.preview.url, pending.token)
      if (signature(latest.team) !== signature(pending.team))
        throw new Error(
          "The team's defaults changed. Check the connection again before applying."
        )
      for (const provider of pending.providers) {
        const type = provider.type as ProviderType
        if (
          activeSignature(this.store.getActive(type)) !== pending.active[type]
        )
          throw new Error(
            "Your active settings changed. Check the connection again before replacing them."
          )
        if (this.store.getActive(type) && input.replaceExisting !== true)
          throw new Error(
            "Confirm replacing your active settings before connecting."
          )
      }
      const previous = await this.store.getProviders()
      const previousActive = Object.fromEntries(
        ROLES.map((type) => [type, this.store.getActive(type)])
      )
      const previousTokens = new Map(
        pending.providers.map((provider) => [
          provider.id,
          this.credentials.get(provider.id)
        ])
      )
      try {
        for (const provider of pending.providers)
          await this.credentials.set(provider.id, pending.token)
        await this.store.saveProviders({
          ...previous,
          ...Object.fromEntries(
            pending.providers.map((provider) => [provider.id, provider])
          )
        })
        for (const provider of pending.providers)
          await this.store.setActive(provider.type as ProviderType, provider)
        // The policy the developer saw on the preview is what applies; a
        // gateway that sends none (free plan, or removed) clears an old one.
        if (pending.team.policy && !policyIsEmpty(pending.team.policy)) {
          await this.policies.set({
            url: pending.preview.url,
            policy: pending.team.policy,
            providerIds: pending.providers.map((provider) => provider.id),
            fetchedAt: new Date().toISOString()
          })
        } else if (this.policies.get()?.url === pending.preview.url) {
          await this.policies.clear()
        }
      } catch (error) {
        const rollback = await Promise.allSettled([
          this.store.saveProviders(previous),
          ...ROLES.map((type) =>
            this.store.setActive(type, previousActive[type])
          ),
          ...[...previousTokens].map(([id, token]) =>
            token === undefined
              ? this.credentials.delete(id)
              : this.credentials.set(id, token)
          )
        ])
        if (rollback.some((result) => result.status === "rejected"))
          throw new Error(
            "Could not save or fully restore provider settings. Check Providers before retrying."
          )
        throw error
      }
      this.cancel()
      // The key now lives in secret storage; nothing else needs to remember it.
      this.lastKey = undefined
      return {
        connected: pending.providers.map(
          (provider) => provider.type as ProviderType
        )
      }
    } finally {
      this.busy = false
    }
  }
}

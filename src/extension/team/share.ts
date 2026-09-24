/**
 * Sharing this computer with the team, from inside VS Code.
 *
 * Wraps the pure `Sharer` with what the editor adds: the team's URL and
 * key from the team connection, the local server to share (chosen from
 * what first-run discovery finds), the on/off switch remembered per
 * machine in global state, the slots setting, and a lock so only one
 * window per machine shares. Lives for the whole session; webviews come
 * and go and read its status through the bridge.
 */
import os from "node:os"
import { Disposable, Event, EventEmitter, ExtensionContext, workspace } from "vscode"

import { providerForBackend } from "../../common/backend-route"
import { API_PROVIDERS, PROVIDER_DISPLAY_NAMES, TEAM_SHARE_STORAGE_KEY } from "../../common/constants"
import { messageOf } from "../../common/errors"
import { logger } from "../../common/logger"
import type { TeamShareBackend, TeamShareStatus } from "../../common/team"
import { RemoteInferenceProvider } from "../../protocol/client"
import { resolveInferenceProvider } from "../inference"
import type { InferenceCapability } from "../inference/types"
import { discoverLocalServers } from "../providers/discovery"
import { listProviderModels } from "../providers/probe"
import { WindowLock } from "../utils/window-lock"

import { Sharer, SharerSession } from "./sharer"

const LOCK_FILE = "team-share.lock"
/** How often a window re-checks the lock and the shared on/off switch. */
const LOCK_POLL_MS = 15_000
/** How long the answer to "does the team pool computers?" is trusted. */
const AVAILABILITY_TTL_MS = 60_000

interface StoredShare {
  enabled: boolean
  backend?: TeamShareBackend
}

/** What this machine is called on the admin page. */
const machineName = (): string => {
  try {
    return os.hostname().split(".")[0].slice(0, 64) || "vscode"
  } catch {
    return "vscode"
  }
}

/** The Ollama from settings, as the default thing to share. */
const configuredOllama = (): TeamShareBackend => {
  const config = workspace.getConfiguration("twinny")
  const hostname = config.get<string>("ollamaHostname") || "localhost"
  return {
    provider: API_PROVIDERS.Ollama,
    label: PROVIDER_DISPLAY_NAMES[API_PROVIDERS.Ollama],
    apiHostname: hostname === "0.0.0.0" ? "localhost" : hostname,
    apiPort: config.get<number>("ollamaApiPort") || 11434,
    apiProtocol: config.get<boolean>("ollamaUseTls") ? "https" : "http"
  }
}

const configuredSlots = (): number => {
  const slots = workspace.getConfiguration("twinny").get<number>("teamShareSlots")
  return Number.isInteger(slots) && slots! >= 1 && slots! <= 8 ? slots! : 2
}

const sameBackend = (a: TeamShareBackend | undefined, b: TeamShareBackend | undefined) =>
  !!a && !!b && a.provider === b.provider && a.apiHostname === b.apiHostname && a.apiPort === b.apiPort && a.apiProtocol === b.apiProtocol

export class TeamShare implements Disposable {
  private readonly _onDidChange = new EventEmitter<TeamShareStatus>()
  public readonly onDidChange: Event<TeamShareStatus> = this._onDidChange.event
  private readonly _lock: WindowLock
  private _sharer?: Sharer
  private _choices: TeamShareBackend[] = []
  private _availability?: { at: number; available: boolean; wanted: string[] }
  private _checking?: Promise<void>
  private _runningElsewhere = false
  private _poll?: ReturnType<typeof setInterval>
  private _disposed = false

  constructor(
    private readonly _context: ExtensionContext,
    /** Where the team is and who we are there; undefined when not connected to a team. */
    private readonly _session: () => Promise<SharerSession | undefined>
  ) {
    this._lock = new WindowLock({
      dir: _context.globalStorageUri.fsPath,
      name: LOCK_FILE,
      warn: (message) => logger.error(`team share ${message}`)
    })
  }

  private get stored(): StoredShare {
    const value = this._context.globalState.get<StoredShare>(TEAM_SHARE_STORAGE_KEY)
    return value && typeof value === "object" ? value : { enabled: false }
  }

  public get enabled(): boolean {
    return this.stored.enabled === true
  }

  public get backend(): TeamShareBackend {
    return this.stored.backend ?? configuredOllama()
  }

  /** Called once on activation: resume sharing if it was on. */
  public async autoStart(): Promise<void> {
    if (!this.enabled) return
    await this.start().catch((error) =>
      logger.error(`team share failed to start: ${messageOf(error)}`)
    )
  }

  public status(): TeamShareStatus {
    const sharer = this._sharer?.status()
    return {
      available: this._availability?.available ?? false,
      enabled: this.enabled,
      state: sharer?.state ?? "off",
      runningElsewhere: this.enabled && !this._sharer && this._runningElsewhere,
      machine: machineName(),
      backend: this.backend,
      choices: this._choices,
      models: sharer?.models ?? [],
      wanted: sharer?.wanted.length ? sharer.wanted : (this._availability?.wanted ?? []),
      served: sharer?.served ?? 0,
      ...(sharer?.backendOk !== undefined ? { backendOk: sharer.backendOk } : {}),
      ...(sharer?.error ? { error: sharer.error } : !sharer && this._lastError ? { error: this._lastError } : {})
    }
  }

  /**
   * Whether the team pools computers, from the team route. Cached a
   * minute; a status read while stale kicks off a fresh look and pushes
   * the answer when it lands.
   */
  public refreshAvailability(force = false): Promise<void> {
    if (this._checking) return this._checking
    if (!force && this._availability && Date.now() - this._availability.at < AVAILABILITY_TTL_MS) return Promise.resolve()
    this._checking = (async () => {
      const before = JSON.stringify(this._availability ?? null)
      try {
        const session = await this._session()
        if (!session) {
          this._availability = { at: Date.now(), available: false, wanted: [] }
        } else {
          const client = new RemoteInferenceProvider({ baseUrl: session.url, token: session.token })
          const team = await client.team({ signal: AbortSignal.timeout(5_000) })
          this._availability = { at: Date.now(), available: !!team.sharing, wanted: team.sharing?.wanted ?? [] }
        }
      } catch {
        // Keep the last answer; the card will ask again later.
        if (!this._availability) this._availability = { at: Date.now() - AVAILABILITY_TTL_MS + 10_000, available: false, wanted: [] }
      } finally {
        this._checking = undefined
      }
      if (JSON.stringify(this._availability) !== before) this.changed()
    })()
    return this._checking
  }

  /** The local servers that answer, for the picker. */
  public async discover(): Promise<TeamShareBackend[]> {
    const found = await discoverLocalServers()
    this._choices = found.map((server) => ({
      provider: server.provider,
      label: server.label,
      apiHostname: server.apiHostname,
      apiPort: server.apiPort,
      apiProtocol: server.apiProtocol
    }))
    this.changed()
    return this._choices
  }

  /** Switch sharing on. */
  public async start(): Promise<TeamShareStatus> {
    this._lastError = undefined
    await this.save({ ...this.stored, enabled: true })
    this.startPolling()
    if (this._sharer) return this.status()
    if (!this._lock.acquire()) {
      this._runningElsewhere = true
      this.changed()
      return this.status()
    }
    this._runningElsewhere = false
    const backend = this.backend
    const sharer = new Sharer({
      session: this._session,
      machine: machineName(),
      backendKind: backend.provider,
      listModels: async () => {
        const probe = providerForBackend(backend, "", "chat", { id: "team-share", label: "Team share" })
        const { models, error } = await listProviderModels(probe)
        if (error && !models.length) throw new Error(error)
        return models.map((id) => ({ id, name: id }))
      },
      route: (model: string, capability: InferenceCapability) => ({
        client: resolveInferenceProvider(
          providerForBackend(backend, model, capability, { id: `team-share:${capability}`, label: "Team share" })
        ),
        model,
        provider: backend.provider
      }),
      slots: configuredSlots,
      log: { info: (message) => logger.info(message), warn: (message) => logger.warn(message) }
    })
    sharer.on("change", () => {
      const status = sharer.status()
      if (status.refused && this._sharer === sharer) {
        // Told not to come back: the switch goes off so a restart does not retry forever.
        void this.stop(status.error)
        return
      }
      this.changed()
    })
    this._sharer = sharer
    void this.refreshAvailability(true)
    await sharer.start()
    return this.status()
  }

  /** Switch sharing off. `reason` is kept on the card until the next start. */
  public async stop(reason?: string): Promise<TeamShareStatus> {
    await this.save({ ...this.stored, enabled: false })
    this._runningElsewhere = false
    this.stopPolling()
    this.stopSharer(reason)
    this.changed()
    return this.status()
  }

  /** Which local server to share. Takes effect at once when sharing. */
  public async setBackend(backend: TeamShareBackend): Promise<TeamShareStatus> {
    if (sameBackend(backend, this.stored.backend)) return this.status()
    await this.save({ ...this.stored, backend })
    if (this._sharer) {
      this.stopSharer()
      await this.start()
    } else {
      this.changed()
    }
    return this.status()
  }

  /** The team changed or was left: forget the old answer and follow the switch. */
  public async teamChanged(): Promise<void> {
    this._availability = undefined
    await this.refreshAvailability(true)
    const session = await this._session()
    if (!session) {
      if (this.enabled) await this.stop("You left the team.")
      return
    }
    if (this._sharer) {
      this.stopSharer()
      await this.start()
    }
  }

  public dispose() {
    this._disposed = true
    this.stopPolling()
    this.stopSharer()
    this._onDidChange.dispose()
  }

  /* ------------------------------------------------------------------------ */

  private _lastError?: string

  private stopSharer(reason?: string) {
    const sharer = this._sharer
    this._sharer = undefined
    this._lastError = reason
    if (sharer) {
      sharer.removeAllListeners()
      sharer.stop()
    }
    this._lock.release()
  }

  private async save(value: StoredShare) {
    await this._context.globalState.update(TEAM_SHARE_STORAGE_KEY, value)
  }

  private startPolling() {
    if (this._poll || this._disposed) return
    this._poll = setInterval(() => void this.poll(), LOCK_POLL_MS)
  }

  private stopPolling() {
    if (this._poll) clearInterval(this._poll)
    this._poll = undefined
  }

  /**
   * The sharing window stops when sharing was switched off elsewhere; a
   * waiting window starts once the lock is free.
   */
  private async poll() {
    if (this._disposed) return
    if (!this.enabled) {
      this.stopPolling()
      if (this._sharer || this._runningElsewhere) {
        this._runningElsewhere = false
        this.stopSharer()
        this.changed()
      }
      return
    }
    if (this._sharer) return
    await this.start().catch(() => undefined)
  }

  private changed() {
    if (this._disposed) return
    this._onDidChange.fire(this.status())
  }
}

/**
 * Everything P2P that lives for the whole extension session.
 *
 * One identity (seed in secret storage), one swarm, one client per paired
 * device, one loopback gateway, and the list of paired devices in global
 * state. Webviews come and go; this does not, so FIM keeps working with
 * the sidebar closed.
 */

import os from "node:os"
import {
  Disposable,
  Event,
  EventEmitter,
  ExtensionContext
} from "vscode"

import {
  P2P_DEVICES_STORAGE_KEY,
  P2P_IDENTITY_SECRET_KEY
} from "../../common/constants"
import { logger } from "../../common/logger"
import { P2pDeviceStatus } from "../../common/messaging/protocol"
import {
  CLIENT_EVENT,
  ClientState,
  createSeed,
  decodePairingCode,
  isPublicKeyHex,
  P2pClient,
  P2pRequestError,
  PeerNetwork,
  publicKeyFromHex,
  toHex
} from "../../p2p"

import { setP2pGateway } from "./endpoint"
import { P2pGateway } from "./gateway"
import { P2pHost } from "./host"

/** What is remembered about a device between sessions. */
export interface PairedDevice {
  id: string
  name: string
  pairedAt: number
  lastSeenAt?: number
  /** Model names from the last successful listing, for offline display. */
  models?: string[]
}

interface LiveStatus {
  state: ClientState
  latencyMs?: number
  ollamaOk?: boolean
  models?: string[]
  error?: string
}

const HEALTH_INTERVAL_MS = 30_000
// A hole punch that fails takes ~10s; leave room for a retry before giving up.
const PAIR_CONNECT_TIMEOUT_MS = 40_000

const hostName = () => {
  try {
    return os.hostname()
  } catch {
    return "VS Code"
  }
}

export class P2pRuntime implements Disposable {
  public readonly gateway: P2pGateway
  /** This machine sharing its own Ollama. */
  public readonly host: P2pHost
  private readonly _onDidChange = new EventEmitter<P2pDeviceStatus[]>()
  public readonly onDidChangeDevices: Event<P2pDeviceStatus[]> = this._onDidChange.event
  private readonly _live = new Map<string, LiveStatus>()
  private _network?: Promise<PeerNetwork>
  private _healthTimer?: ReturnType<typeof setInterval>
  private _disposed = false

  constructor(private readonly _context: ExtensionContext) {
    this.gateway = new P2pGateway((deviceId) => this.clientFor(deviceId))
    this.host = new P2pHost(_context)
  }

  /** Starts the gateway and, if devices are paired, begins connecting. */
  public async start(): Promise<void> {
    try {
      await this.gateway.start()
      setP2pGateway(this.gateway)
    } catch (error) {
      logger.error(
        `p2p gateway failed to start: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (this.devices().length) {
      void this.connectAll()
      this._healthTimer = setInterval(() => void this.healthCheck(), HEALTH_INTERVAL_MS)
    }
    void this.host.autoStart()
  }

  public dispose() {
    this._disposed = true
    this.host.dispose()
    if (this._healthTimer) clearInterval(this._healthTimer)
    setP2pGateway(undefined)
    void this.gateway.stop()
    void this._network?.then((network) => network.destroy()).catch(() => undefined)
    this._onDidChange.dispose()
  }

  /* ------------------------------------------------------------------------ */
  /*  Devices                                                                  */
  /* ------------------------------------------------------------------------ */

  public devices(): PairedDevice[] {
    const stored = this._context.globalState.get<Record<string, PairedDevice>>(
      P2P_DEVICES_STORAGE_KEY
    )
    return stored ? Object.values(stored).filter((d) => isPublicKeyHex(d.id)) : []
  }

  public device(id: string): PairedDevice | undefined {
    return this.devices().find((device) => device.id === id)
  }

  public statuses(): P2pDeviceStatus[] {
    return this.devices()
      .map((device) => this.statusOf(device))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  private statusOf(device: PairedDevice): P2pDeviceStatus {
    const live = this._live.get(device.id)
    const state: P2pDeviceStatus["state"] =
      live?.state === "connected"
        ? "online"
        : live?.state === "connecting"
          ? "connecting"
          : "offline"
    return {
      id: device.id,
      name: device.name,
      state,
      latencyMs: state === "online" ? live?.latencyMs : undefined,
      ollamaOk: state === "online" ? live?.ollamaOk : undefined,
      models: live?.models || device.models || [],
      pairedAt: device.pairedAt,
      lastSeenAt: device.lastSeenAt,
      error: state === "offline" ? live?.error : undefined
    }
  }

  private async saveDevice(device: PairedDevice) {
    const stored = { ...(this._context.globalState.get<Record<string, PairedDevice>>(P2P_DEVICES_STORAGE_KEY) || {}) }
    stored[device.id] = device
    await this._context.globalState.update(P2P_DEVICES_STORAGE_KEY, stored)
  }

  private async patchDevice(id: string, patch: Partial<PairedDevice>) {
    const device = this.device(id)
    if (device) await this.saveDevice({ ...device, ...patch })
  }

  /**
   * Pair with the node behind a code. Connects, proves the secret, stores
   * the device, and comes back with its first status (models included).
   */
  public async pair(code: string, name?: string): Promise<P2pDeviceStatus> {
    const { publicKey, secret } = decodePairingCode(code)
    const id = toHex(publicKey)
    const network = await this.network()
    const client = network.client(publicKey)
    this.watch(client)

    try {
      await client.connect(PAIR_CONNECT_TIMEOUT_MS)
      const info = await client.pair(secret, hostName())
      const device: PairedDevice = {
        id,
        name: name?.trim() || info.name || `Device ${id.slice(0, 6)}`,
        pairedAt: Date.now(),
        lastSeenAt: Date.now()
      }
      await this.saveDevice(device)
      if (!this._healthTimer) {
        this._healthTimer = setInterval(() => void this.healthCheck(), HEALTH_INTERVAL_MS)
      }
      await this.probe(id, client)
      return this.statusOf(this.device(id) || device)
    } catch (error) {
      if (!this.device(id)) network.forget(id)
      throw error
    } finally {
      this.changed()
    }
  }

  /** Forget a device: drop the connection, the trust on our side, its status. */
  public async remove(id: string): Promise<void> {
    const stored = { ...(this._context.globalState.get<Record<string, PairedDevice>>(P2P_DEVICES_STORAGE_KEY) || {}) }
    delete stored[id]
    await this._context.globalState.update(P2P_DEVICES_STORAGE_KEY, stored)
    this._live.delete(id)
    const network = await this._network
    network?.forget(id)
    this.changed()
  }

  /** Reconnect if needed and take fresh readings. */
  public async refresh(id: string): Promise<P2pDeviceStatus | undefined> {
    const device = this.device(id)
    if (!device) return undefined
    try {
      const client = await this.clientFor(id)
      await client.connect()
      await this.probe(id, client)
    } catch (error) {
      this.setLive(id, {
        state: "disconnected",
        error: error instanceof Error ? error.message : String(error)
      })
    }
    return this.statusOf(device)
  }

  /* ------------------------------------------------------------------------ */
  /*  Clients                                                                  */
  /* ------------------------------------------------------------------------ */

  /** The client for a paired device. Unknown ids are refused. */
  public async clientFor(deviceId: string): Promise<P2pClient> {
    const device = this.device(deviceId)
    if (!device) {
      throw new P2pRequestError(
        "unauthorized",
        "That device is no longer paired with this Twinny. Pair it again from the providers tab."
      )
    }
    const network = await this.network()
    const existing = network.has(deviceId)
    const client = network.client(publicKeyFromHex(deviceId))
    if (!existing) this.watch(client)
    return client
  }

  private network(): Promise<PeerNetwork> {
    if (!this._network) {
      // Any free port: this side only dials out, and it must not take the
      // fixed port the host shares on when it happens to start first.
      this._network = this.loadSeed().then(
        (seed) => new PeerNetwork({ seed, port: [0, 0] })
      )
    }
    return this._network
  }

  private async loadSeed(): Promise<Buffer> {
    const stored = await this._context.secrets.get(P2P_IDENTITY_SECRET_KEY)
    if (stored && /^[0-9a-f]{64}$/.test(stored)) return Buffer.from(stored, "hex")
    const seed = createSeed()
    await this._context.secrets.store(P2P_IDENTITY_SECRET_KEY, seed.toString("hex"))
    return seed
  }

  private watch(client: P2pClient) {
    client.on(CLIENT_EVENT.dialFailed, (error: Error) => {
      const code = (error as { code?: unknown }).code
      logger.log(
        `p2p dial to ${client.remotePublicKeyHex.slice(0, 8)} failed: ${
          typeof code === "string" && !error.message.startsWith(code) ? `${code}: ` : ""
        }${error.message}`
      )
    })
    client.on(CLIENT_EVENT.state, (state: ClientState) => {
      const id = client.remotePublicKeyHex
      const previous = this._live.get(id)
      this.setLive(id, {
        ...previous,
        state,
        error: state === "disconnected" ? previous?.error : undefined
      })
      // A device that is still pairing must not be probed: the node closes
      // the session on any request but `pair` from a peer it does not trust
      // yet. `pair()` probes itself once the node has said yes.
      if (state === "connected" && this.device(id)) void this.probe(id, client)
    })
  }

  private async connectAll() {
    for (const device of this.devices()) {
      try {
        const client = await this.clientFor(device.id)
        void client.connect().catch((error) => {
          this.setLive(device.id, {
            state: "disconnected",
            error: error instanceof Error ? error.message : String(error)
          })
        })
      } catch {
        // Not paired any more; nothing to connect.
      }
    }
  }

  /** Ping and list models; the readings become the device's status. */
  private async probe(id: string, client: P2pClient) {
    try {
      const pong = await client.ping()
      let models = this._live.get(id)?.models
      try {
        models = (await client.listModels()).map((model) => model.name)
      } catch {
        // Ollama may be down; the ping already says so.
      }
      this.setLive(id, {
        state: "connected",
        latencyMs: pong.latencyMs,
        ollamaOk: pong.ollama,
        models
      })
      await this.patchDevice(id, {
        lastSeenAt: Date.now(),
        ...(models ? { models } : {})
      })
    } catch (error) {
      this.setLive(id, {
        state: client.connected ? "connected" : "disconnected",
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private async healthCheck() {
    if (this._disposed) return
    for (const device of this.devices()) {
      try {
        const client = await this.clientFor(device.id)
        if (client.connected) {
          await this.probe(device.id, client)
        } else if (client.state === "disconnected") {
          void client.connect().catch(() => undefined)
        }
      } catch {
        // Skipped this round.
      }
    }
  }

  private setLive(id: string, status: LiveStatus) {
    this._live.set(id, status)
    this.changed()
  }

  private changed() {
    if (this._disposed) return
    this._onDidChange.fire(this.statuses())
  }
}

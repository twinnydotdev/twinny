/**
 * This machine as a node: sharing its own Ollama with paired devices,
 * without leaving VS Code.
 *
 * Runs the same `TwinnyNode` the CLI does, with its identity in secret
 * storage and its trusted peers in global state. Sharing is remembered per
 * machine (global state is not synced), so a workstation that was sharing
 * starts sharing again after a restart.
 *
 * Every VS Code window of a profile shares that identity, and the DHT only
 * ever routes a device to one node per key, so only one window may run the
 * node at a time. A lock file in global storage decides which; the others
 * show that sharing is happening elsewhere and take over if it goes away.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  Disposable,
  Event,
  EventEmitter,
  ExtensionContext,
  Memento,
  workspace
} from "vscode"

import {
  P2P_HOST_ENABLED_STORAGE_KEY,
  P2P_HOST_SECRET_KEY,
  P2P_TRUSTED_PEERS_STORAGE_KEY
} from "../../common/constants"
import { logger } from "../../common/logger"
import { P2pHostStatus } from "../../common/messaging/protocol"
import { TrustStorage, TrustStore } from "../../node/peers"
import { NODE_EVENT, TwinnyNode } from "../../node/server"
import { createSeed, keyPairFromSeed, toHex } from "../../p2p"

const LOCK_FILE = "p2p-host.lock"
/** How often a window re-checks the lock and the shared on/off switch. */
const LOCK_POLL_MS = 15_000

const mementoTrustStorage = (state: Memento): TrustStorage => ({
  read: () => state.get(P2P_TRUSTED_PEERS_STORAGE_KEY),
  write: (peers) => void state.update(P2P_TRUSTED_PEERS_STORAGE_KEY, peers)
})

/** The Ollama this machine would share, from the same settings chat uses. */
const localOllamaUrl = (): string => {
  const config = workspace.getConfiguration("twinny")
  const protocol = config.get<boolean>("ollamaUseTls") ? "https" : "http"
  const hostname = config.get<string>("ollamaHostname") || "localhost"
  const port = config.get<number>("ollamaApiPort") || 11434
  // 0.0.0.0 is where Ollama *listens*; it is not an address to call.
  const host = hostname === "0.0.0.0" ? "127.0.0.1" : hostname
  return `${protocol}://${host}:${port}`
}

export class P2pHost implements Disposable {
  private readonly _trust: TrustStore
  private readonly _onDidChange = new EventEmitter<P2pHostStatus>()
  public readonly onDidChange: Event<P2pHostStatus> = this._onDidChange.event
  private _node?: TwinnyNode
  private _starting?: Promise<P2pHostStatus>
  private _peerId?: string
  private _pairingCode?: string
  private _pairingExpiresAt?: number
  private _ollamaOk?: boolean
  private _error?: string
  private _runningElsewhere = false
  private _lockHeld = false
  private _poll?: ReturnType<typeof setInterval>
  private _disposed = false

  constructor(private readonly _context: ExtensionContext) {
    this._trust = new TrustStore(mementoTrustStorage(_context.globalState))
  }

  public get enabled(): boolean {
    return this._context.globalState.get<boolean>(P2P_HOST_ENABLED_STORAGE_KEY, false)
  }

  public get running(): boolean {
    return !!this._node
  }

  public get name(): string {
    return os.hostname()
  }

  /** Called once on activation: resume sharing if it was on. */
  public async autoStart(): Promise<void> {
    if (!this.enabled) return
    try {
      await this.start()
    } catch (error) {
      logger.error(
        `p2p host failed to start: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  public status(): P2pHostStatus {
    const connected = new Set(
      (this._node?.connectedPeers || [])
        .filter((peer) => peer.trusted)
        .map((peer) => peer.publicKey)
    )
    const pairingOpen = !!this._node?.pairingOpen
    return {
      enabled: this.enabled,
      running: this.running,
      runningElsewhere: this.enabled && !this.running && this._runningElsewhere,
      name: this.name,
      peerId: this._peerId,
      ollamaUrl: localOllamaUrl(),
      ollamaOk: this._ollamaOk,
      pairingCode: pairingOpen ? this._pairingCode : undefined,
      pairingExpiresAt: pairingOpen ? this._pairingExpiresAt : undefined,
      trustedPeers: this._trust
        .list()
        .map((peer) => ({
          id: peer.publicKey,
          name: peer.name,
          pairedAt: peer.pairedAt,
          lastSeenAt: peer.lastSeenAt,
          connected: connected.has(peer.publicKey)
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      error: this._error
    }
  }

  /* ------------------------------------------------------------------------ */

  /** Switch sharing on. Opens a pairing window when nothing is paired yet. */
  public start(): Promise<P2pHostStatus> {
    if (this._node) return Promise.resolve(this.status())
    if (!this._starting) {
      this._starting = this.doStart().finally(() => {
        this._starting = undefined
      })
    }
    return this._starting
  }

  private async doStart(): Promise<P2pHostStatus> {
    this._error = undefined
    await this._context.globalState.update(P2P_HOST_ENABLED_STORAGE_KEY, true)
    this.startPolling()
    if (!this.acquireLock()) {
      this._runningElsewhere = true
      this.changed()
      return this.status()
    }
    this._runningElsewhere = false
    try {
      const seed = await this.loadSeed()
      const node = new TwinnyNode({
        seed,
        name: this.name,
        ollamaUrl: localOllamaUrl(),
        trust: this._trust
      })
      this._peerId = node.publicKeyHex
      this.listen(node)
      await node.start()
      this._node = node
      if (this._trust.list().length === 0) this.openPairing()
      void this.checkOllama()
      logger.log(`p2p host sharing as ${node.publicKeyHex}`)
    } catch (error) {
      this._error = error instanceof Error ? error.message : String(error)
      this.releaseLock()
      throw error
    } finally {
      this.changed()
    }
    return this.status()
  }

  /**
   * Switch sharing off and forget nothing: paired devices stay paired. When
   * another window runs the node it notices the switch on its next poll.
   */
  public async stop(): Promise<P2pHostStatus> {
    await this._context.globalState.update(P2P_HOST_ENABLED_STORAGE_KEY, false)
    this._runningElsewhere = false
    this.stopPolling()
    await this.stopNode()
    this.changed()
    return this.status()
  }

  /** A fresh code; starts sharing first if it was off. */
  public async newPairingCode(): Promise<P2pHostStatus> {
    if (!this._node) await this.start()
    this.openPairing()
    this.changed()
    return this.status()
  }

  public removeTrustedPeer(id: string): P2pHostStatus {
    this._trust.remove(id)
    // A connected session for that peer is cut too; the firewall keeps it out
    // from now on.
    for (const peer of this._node?.connectedPeers || []) {
      if (peer.publicKey === id) this._node?.disconnectPeer(id)
    }
    this.changed()
    return this.status()
  }

  /** Re-checks Ollama and pushes the status if it changed. */
  public async checkOllama(): Promise<void> {
    if (!this._node) return
    const before = this._ollamaOk
    this._ollamaOk = await this._node.ollama.isUp()
    if (before !== this._ollamaOk) this.changed()
  }

  public dispose() {
    this._disposed = true
    this.stopPolling()
    void this.stopNode()
    this._onDidChange.dispose()
  }

  /* ------------------------------------------------------------------------ */
  /*  One node per machine                                                     */
  /* ------------------------------------------------------------------------ */

  private get lockPath(): string {
    return path.join(this._context.globalStorageUri.fsPath, LOCK_FILE)
  }

  /**
   * Claims the right to run the node. Returns false when a live process in
   * another window holds it. A lock left by a process that died is taken
   * over; if the file system refuses to play, sharing goes ahead unguarded.
   */
  private acquireLock(): boolean {
    if (this._lockHeld) return true
    const file = this.lockPath
    const claim = JSON.stringify({ pid: process.pid, since: Date.now() })
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      try {
        fs.writeFileSync(file, claim, { flag: "wx" })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        const holder = readLockPid(file)
        if (holder !== undefined && holder !== process.pid && isAlive(holder)) {
          return false
        }
        fs.writeFileSync(file, claim)
      }
    } catch (error) {
      logger.error(
        `p2p host lock unavailable, sharing without it: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    this._lockHeld = true
    return true
  }

  private releaseLock() {
    if (!this._lockHeld) return
    this._lockHeld = false
    try {
      if (readLockPid(this.lockPath) === process.pid) fs.unlinkSync(this.lockPath)
    } catch {
      // Nothing to release, or not ours any more.
    }
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
   * The running window stops when sharing was switched off elsewhere; a
   * waiting window starts once the lock is free.
   */
  private async poll() {
    if (this._disposed) return
    if (!this.enabled) {
      this.stopPolling()
      if (this._node || this._runningElsewhere) {
        this._runningElsewhere = false
        await this.stopNode()
        this.changed()
      }
      return
    }
    if (this._node || this._starting) return
    await this.start().catch(() => undefined)
  }

  /* ------------------------------------------------------------------------ */

  private openPairing() {
    if (!this._node) return
    this._pairingCode = this._node.openPairing()
    this._pairingExpiresAt = Date.now() + 10 * 60 * 1000
  }

  private async stopNode() {
    const node = this._node
    this._node = undefined
    this._pairingCode = undefined
    this._pairingExpiresAt = undefined
    this._ollamaOk = undefined
    if (node) {
      node.removeAllListeners()
      await node.stop()
    }
    this.releaseLock()
  }

  private listen(node: TwinnyNode) {
    const log = (message: string) => logger.log(`p2p host: ${message}`)
    const refresh = () => this.changed()
    const short = (key: string) => key.slice(0, 8)
    node.on(NODE_EVENT.peerConnected, ({ publicKey, trusted }) => {
      log(`${trusted ? "paired device" : "unpaired device"} ${short(publicKey)} connected`)
      refresh()
    })
    node.on(NODE_EVENT.peerDisconnected, ({ publicKey }) => {
      log(`device ${short(publicKey)} disconnected`)
      refresh()
    })
    node.on(NODE_EVENT.paired, ({ publicKey, name }) => {
      log(`paired with ${name} (${short(publicKey)})`)
      refresh()
    })
    node.on(NODE_EVENT.pairingOpened, () => log("pairing code shown; waiting for a device"))
    node.on(NODE_EVENT.pairingClosed, () => {
      this._pairingCode = undefined
      this._pairingExpiresAt = undefined
      log("pairing window closed")
      refresh()
    })
    node.on(NODE_EVENT.pairingFailed, ({ publicKey }) => {
      log(`device ${short(publicKey)} offered a wrong pairing code`)
      refresh()
    })
    node.on(NODE_EVENT.log, log)
  }

  private async loadSeed(): Promise<Buffer> {
    const stored = await this._context.secrets.get(P2P_HOST_SECRET_KEY)
    if (stored && /^[0-9a-f]{64}$/.test(stored)) return Buffer.from(stored, "hex")
    const seed = createSeed()
    await this._context.secrets.store(P2P_HOST_SECRET_KEY, seed.toString("hex"))
    this._peerId = toHex(keyPairFromSeed(seed).publicKey)
    return seed
  }

  private changed() {
    if (this._disposed) return
    this._onDidChange.fire(this.status())
  }
}

const readLockPid = (file: string): number | undefined => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    return Number.isInteger(parsed?.pid) ? Number(parsed.pid) : undefined
  } catch {
    return undefined
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // No permission to signal it means it exists and is someone else's.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

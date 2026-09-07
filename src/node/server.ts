/**
 * A Twinny node: the thing that runs next to Ollama on the GPU machine.
 *
 * It listens on its own DHT key. The firewall turns away every key
 * that is not in the trust store unless a pairing window is open, and even
 * then an unknown peer may only send `pair`. Trusted peers get the five
 * protocol operations and nothing else.
 */

import DHT from "hyperdht"
import { EventEmitter } from "node:events"

import { keyPairFromSeed, toHex } from "../p2p/identity"
import { encodePairingCode, PAIRING_CODE_TTL_MS, PairingWindow } from "../p2p/pairing"
import {
  ClientFrame,
  InferenceFrame,
  NodeFrame,
  NodeInfo,
  P2P_PROTOCOL_VERSION,
  P2pErrorCode,
  parseClientFrame
} from "../p2p/protocol"
import { PeerSession, SESSION_EVENT } from "../p2p/session"
import { PeerDht, PeerServer, PeerStream } from "../p2p/types"

import { OllamaProxy } from "./ollama"
import { TrustStore } from "./peers"

export interface TwinnyNodeOptions {
  seed: Buffer
  name: string
  ollamaUrl: string
  trust: TrustStore
  /** Local DHT bootstrap nodes; only tests set this. */
  bootstrap?: unknown[]
  /** Streaming requests one device may have open at once. */
  maxInFlightPerPeer?: number
  /** How long an unpaired peer may sit connected without pairing. */
  pairingIdleMs?: number
}

export const NODE_EVENT = {
  log: "log",
  peerConnected: "peer-connected",
  peerDisconnected: "peer-disconnected",
  paired: "paired",
  pairingFailed: "pairing-failed",
  pairingOpened: "pairing-opened",
  pairingClosed: "pairing-closed",
  request: "request"
} as const

interface PeerState {
  session: PeerSession
  trusted: boolean
  inFlight: Map<string, AbortController>
  idleTimer?: ReturnType<typeof setTimeout>
}

const DEFAULT_MAX_IN_FLIGHT = 4
const DEFAULT_PAIRING_IDLE_MS = 60_000

export class TwinnyNode extends EventEmitter {
  public readonly publicKey: Buffer
  public readonly publicKeyHex: string
  private readonly _ollama: OllamaProxy
  private readonly _peers = new Map<PeerSession, PeerState>()
  private _dht?: PeerDht
  private _server?: PeerServer
  private _pairing?: PairingWindow
  private _pairingTimer?: ReturnType<typeof setTimeout>

  constructor(private readonly _options: TwinnyNodeOptions) {
    super()
    this.publicKey = keyPairFromSeed(_options.seed).publicKey
    this.publicKeyHex = toHex(this.publicKey)
    this._ollama = new OllamaProxy(_options.ollamaUrl)
  }

  public get name(): string {
    return this._options.name
  }

  public get ollama(): OllamaProxy {
    return this._ollama
  }

  public get trust(): TrustStore {
    return this._options.trust
  }

  public get pairingOpen(): boolean {
    return !!this._pairing?.isOpen()
  }

  public get connectedPeers(): Array<{ publicKey: string; trusted: boolean }> {
    return [...this._peers.values()].map(({ session, trusted }) => ({
      publicKey: session.remotePublicKeyHex,
      trusted
    }))
  }

  /* ------------------------------------------------------------------------ */
  /*  Lifecycle                                                                */
  /* ------------------------------------------------------------------------ */

  public async start(): Promise<void> {
    if (this._dht) return
    const dht = new DHT({
      seed: this._options.seed,
      bootstrap: this._options.bootstrap
    }) as PeerDht
    this._dht = dht
    // The firewall runs during the Noise handshake, so a stranger never
    // completes a connection. Unlike hyperswarm, plain hyperdht lets one
    // device hold several sessions, which two VS Code windows on the same
    // machine need.
    this._server = dht.createServer(
      { firewall: (remotePublicKey: Buffer) => !this.allows(toHex(remotePublicKey)) },
      this.onConnection
    )
    await this._server.listen()
    this.log(`listening as ${this.publicKeyHex}`)
  }

  public async stop(): Promise<void> {
    this.closePairing()
    for (const state of [...this._peers.values()]) state.session.close()
    this._peers.clear()
    const dht = this._dht
    const server = this._server
    this._dht = undefined
    this._server = undefined
    if (server) await server.close()
    if (dht) await dht.destroy()
  }

  /**
   * Opens a pairing window and returns the code to show the person. Any
   * earlier window is closed: there is only ever one code that works.
   */
  public openPairing(ttlMs = PAIRING_CODE_TTL_MS): string {
    this.closePairing()
    this._pairing = new PairingWindow(ttlMs)
    this._pairingTimer = setTimeout(() => this.closePairing(), ttlMs)
    const code = encodePairingCode(this.publicKey, this._pairing.secret)
    this.emit(NODE_EVENT.pairingOpened, { code, expiresAt: this._pairing.expiresAt })
    return code
  }

  public closePairing() {
    if (this._pairingTimer) clearTimeout(this._pairingTimer)
    this._pairingTimer = undefined
    const wasOpen = this.pairingOpen
    this._pairing?.close()
    this._pairing = undefined
    // Whoever came in on the strength of the window and never paired goes.
    for (const state of [...this._peers.values()]) {
      if (!state.trusted) state.session.close()
    }
    if (wasOpen) this.emit(NODE_EVENT.pairingClosed)
  }

  /** Cut every session with a peer, e.g. one that was just untrusted. */
  public disconnectPeer(publicKeyHex: string) {
    for (const state of [...this._peers.values()]) {
      if (state.session.remotePublicKeyHex === publicKeyHex) state.session.close()
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Connections                                                              */
  /* ------------------------------------------------------------------------ */

  private allows(remotePublicKeyHex: string): boolean {
    return this.trust.has(remotePublicKeyHex) || this.pairingOpen
  }

  private onConnection = (stream: PeerStream) => {
    const session = new PeerSession(stream)
    const hex = session.remotePublicKeyHex
    const trusted = this.trust.has(hex)

    // The firewall already said no to anyone else, but the window may have
    // closed between the handshake starting and finishing.
    if (!trusted && !this.pairingOpen) {
      session.close(new Error("Not paired"))
      return
    }

    const state: PeerState = { session, trusted, inFlight: new Map() }
    this._peers.set(session, state)
    if (!trusted) {
      state.idleTimer = setTimeout(
        () => session.close(new Error("Pairing timed out")),
        this._options.pairingIdleMs ?? DEFAULT_PAIRING_IDLE_MS
      )
    }

    session.on(SESSION_EVENT.frame, (raw: unknown) => this.onFrame(state, raw))
    session.on(SESSION_EVENT.close, () => {
      if (state.idleTimer) clearTimeout(state.idleTimer)
      for (const controller of state.inFlight.values()) controller.abort()
      state.inFlight.clear()
      this._peers.delete(session)
      this.emit(NODE_EVENT.peerDisconnected, { publicKey: hex, trusted: state.trusted })
    })

    if (trusted) this.trust.touch(hex)
    this.emit(NODE_EVENT.peerConnected, { publicKey: hex, trusted })
  }

  private onFrame(state: PeerState, raw: unknown) {
    const frame = parseClientFrame(raw)
    if (!frame) {
      this.log(`ignoring malformed frame from ${state.session.remotePublicKeyHex}`)
      return
    }

    if (frame.type === "pair") {
      this.handlePair(state, frame.id, frame.secret, frame.name)
      return
    }

    if (!state.trusted) {
      this.reply(state, {
        id: frame.id,
        type: "error",
        code: "unauthorized",
        message: "This device is not paired with the node."
      })
      state.session.close()
      return
    }

    switch (frame.type) {
      case "ping":
        void this.handlePing(state, frame.id)
        break
      case "models":
        void this.handleModels(state, frame.id)
        break
      case "cancel":
        state.inFlight.get(frame.id)?.abort()
        break
      default:
        void this.handleInference(state, frame)
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Handlers                                                                 */
  /* ------------------------------------------------------------------------ */

  private handlePair(state: PeerState, id: string, secret: string, name?: string) {
    const hex = state.session.remotePublicKeyHex

    if (state.trusted) {
      // Already paired; answering again is harmless and lets a device that
      // lost its own record recover without a new code.
      this.reply(state, { id, type: "paired", node: this.info() })
      return
    }

    if (!this._pairing?.isOpen()) {
      this.reply(state, {
        id,
        type: "error",
        code: "pairing-closed",
        message: "The node is not accepting new devices right now. Show a new pairing code on the node."
      })
      state.session.close()
      return
    }

    const ok = this._pairing.verify(secret)
    if (!ok) {
      this.reply(state, {
        id,
        type: "error",
        code: "pairing-failed",
        message: "The pairing code was not accepted. Show a new code on the node and try again."
      })
      this.emit(NODE_EVENT.pairingFailed, { publicKey: hex })
      state.session.close()
      this.closePairing()
      return
    }

    this.trust.add(hex, name || "Twinny device")
    state.trusted = true
    if (state.idleTimer) clearTimeout(state.idleTimer)
    state.idleTimer = undefined
    this.reply(state, { id, type: "paired", node: this.info() })
    this.emit(NODE_EVENT.paired, { publicKey: hex, name: name || "Twinny device" })
    this.closePairing()
  }

  private async handlePing(state: PeerState, id: string) {
    const ollama = await this._ollama.isUp()
    this.reply(state, { id, type: "pong", node: this.info(), ollama })
  }

  private async handleModels(state: PeerState, id: string) {
    try {
      const models = await this._ollama.listModels()
      this.reply(state, { id, type: "models", models })
    } catch (error) {
      this.fail(state, id, "upstream", error)
    }
  }

  private async handleInference(state: PeerState, frame: InferenceFrame) {
    const { id, type, request } = frame
    const limit = this._options.maxInFlightPerPeer ?? DEFAULT_MAX_IN_FLIGHT
    if (state.inFlight.size >= limit) {
      this.reply(state, {
        id,
        type: "error",
        code: "busy",
        message: `The node already has ${limit} requests running for this device.`
      })
      return
    }
    if (state.inFlight.has(id)) return

    const controller = new AbortController()
    state.inFlight.set(id, controller)
    this.emit(NODE_EVENT.request, {
      publicKey: state.session.remotePublicKeyHex,
      kind: type,
      model: request.model
    })

    try {
      await this._ollama.relay(type, request, controller.signal, {
        head: (status, contentType) =>
          this.reply(state, { id, type: "head", status, contentType }),
        chunk: (chunk) => this.reply(state, { id, type: "body", chunk }),
        end: () => this.reply(state, { id, type: "end" }),
        error: (code, message) => this.reply(state, { id, type: "error", code, message })
      })
    } finally {
      state.inFlight.delete(id)
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Helpers                                                                  */
  /* ------------------------------------------------------------------------ */

  private info(): NodeInfo {
    return {
      name: this._options.name,
      publicKey: this.publicKeyHex,
      version: P2P_PROTOCOL_VERSION
    }
  }

  private reply(state: PeerState, frame: NodeFrame) {
    state.session.send(frame)
  }

  private fail(state: PeerState, id: string, code: P2pErrorCode, error: unknown) {
    this.reply(state, {
      id,
      type: "error",
      code,
      message: error instanceof Error ? error.message : String(error)
    })
  }

  private log(message: string) {
    this.emit(NODE_EVENT.log, message)
  }
}

export type { ClientFrame }

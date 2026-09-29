/**
 * The client half of the protocol: everything the extension does to one
 * paired node.
 *
 * A client is bound to one remote public key. It dials the node over the
 * DHT, multiplexes requests over the resulting session by id, and turns the
 * node's frames back into promises and streams. It never decides *what* to
 * ask; that is the gateway's job.
 */

import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"

import { toHex } from "./identity"
import {
  ClientFrame,
  HeadFrame,
  InferenceBody,
  InferenceKind,
  NodeFrame,
  NodeInfo,
  P2P_PROTOCOL_VERSION,
  P2pErrorCode,
  parseNodeFrame,
  RemoteModel
} from "./protocol"
import { PeerSession, SESSION_EVENT } from "./session"
import { Dialer, PeerStream } from "./types"

export type ClientState = "disconnected" | "connecting" | "connected"

export type ClientErrorCode = P2pErrorCode | "disconnected" | "timeout"

export class P2pRequestError extends Error {
  constructor(
    public readonly code: ClientErrorCode,
    message: string
  ) {
    super(message)
    this.name = "P2pRequestError"
  }
}

export interface InferenceHandlers {
  onHead?: (head: HeadFrame) => void
  onChunk: (chunk: string) => void
  onEnd: () => void
  onError: (error: P2pRequestError) => void
}

export interface InferenceHandle {
  cancel: () => void
}

export interface PingResult {
  latencyMs: number
  node: NodeInfo
  ollama: boolean
}

export interface P2pClientOptions {
  /** How long `connect()` waits for the swarm to find the node. */
  connectTimeoutMs?: number
  /** How long a ping / models / pair request may take. */
  requestTimeoutMs?: number
  /** How long an inference request may wait for Ollama's first byte. */
  firstByteTimeoutMs?: number
}

export const CLIENT_EVENT = {
  state: "state",
  /** One dial attempt failed; the payload is the transport's error. */
  dialFailed: "dial-failed"
} as const

interface Pending {
  expect: NodeFrame["type"]
  resolve: (frame: NodeFrame) => void
  reject: (error: P2pRequestError) => void
  timer: ReturnType<typeof setTimeout>
}

interface OpenStream {
  handlers: InferenceHandlers
  timer?: ReturnType<typeof setTimeout>
}

const DEFAULTS: Required<P2pClientOptions> = {
  connectTimeoutMs: 20_000,
  requestTimeoutMs: 15_000,
  firstByteTimeoutMs: 120_000
}

/** How long to wait after a failed dial before dialling again. */
const REDIAL_MS = 1_500

const noop = () => undefined

/** "HOLEPUNCH_ABORTED: Holepunch aborted" rather than the code twice. */
const describe = (error: Error): string => {
  const code = (error as { code?: unknown }).code
  return typeof code === "string" && !error.message.startsWith(code)
    ? `${code}: ${error.message}`
    : error.message
}

export class P2pClient extends EventEmitter {
  public readonly remotePublicKeyHex: string
  private readonly _options: Required<P2pClientOptions>
  private _session?: PeerSession
  private _state: ClientState = "disconnected"
  private _connectWaiters: Array<{
    resolve: () => void
    reject: (error: Error) => void
  }> = []
  private _connectTimer?: ReturnType<typeof setTimeout>
  private _redialTimer?: ReturnType<typeof setTimeout>
  private _dialing?: PeerStream
  private _lastDialError?: Error
  private readonly _pending = new Map<string, Pending>()
  private readonly _streams = new Map<string, OpenStream>()
  private _destroyed = false

  constructor(
    private readonly _dial: Dialer,
    public readonly remotePublicKey: Buffer,
    options: P2pClientOptions = {}
  ) {
    super()
    this.remotePublicKeyHex = toHex(remotePublicKey)
    this._options = { ...DEFAULTS, ...options }
  }

  public get state(): ClientState {
    return this._state
  }

  public get connected(): boolean {
    return (
      this._state === "connected" && !!this._session && !this._session.closed
    )
  }

  /* ------------------------------------------------------------------------ */
  /*  Connection                                                               */
  /* ------------------------------------------------------------------------ */

  /**
   * Takes over an open stream to this peer. The Noise handshake has already
   * verified the remote key.
   */
  public attach(stream: PeerStream) {
    if (this._destroyed) {
      stream.on("error", () => undefined)
      stream.destroy()
      return
    }
    if (!stream.remotePublicKey.equals(this.remotePublicKey as Uint8Array)) {
      stream.on("error", () => undefined)
      stream.destroy(new Error("Stream is for a different peer"))
      return
    }
    this._session?.close()
    const session = new PeerSession(stream)
    this._session = session
    session.on(SESSION_EVENT.frame, (frame: unknown) => this.onFrame(frame))
    session.on(SESSION_EVENT.close, () => {
      if (this._session === session) this._session = undefined
      this.failAll(
        new P2pRequestError(
          "disconnected",
          "Lost the connection to the device."
        )
      )
      this.setState("disconnected")
    })
    this.setState("connected")
    this.stopDialling()
    const waiters = this._connectWaiters
    this._connectWaiters = []
    for (const waiter of waiters) waiter.resolve()
  }

  /** Resolves once a session is open; rejects after the connect timeout. */
  public connect(timeoutMs = this._options.connectTimeoutMs): Promise<void> {
    if (this._destroyed) {
      return Promise.reject(
        new P2pRequestError("disconnected", "Client destroyed")
      )
    }
    if (this.connected) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      this._connectWaiters.push({ resolve, reject })
      if (this._state === "connecting") return

      this.setState("connecting")
      this._connectTimer = setTimeout(() => {
        this._connectTimer = undefined
        if (this.connected) return
        this.stopDialling()
        this.setState("disconnected")
        const waiters = this._connectWaiters
        this._connectWaiters = []
        const error = new P2pRequestError(
          "timeout",
          `Could not reach the device. Check that the Twinny node is running and online.${
            this._lastDialError ? ` Last attempt: ${describe(this._lastDialError)}.` : ""
          }`
        )
        for (const waiter of waiters) waiter.reject(error)
      }, timeoutMs)
      this.dial()
    })
  }

  /**
   * One attempt to reach the node. The DHT lookup and hole punch either
   * open the stream or fail it; a failure is retried until the connect
   * timeout gives up, since a node that just came online takes a moment to
   * be findable.
   */
  private dial() {
    if (this._destroyed || this._state !== "connecting" || this._dialing) return
    let stream: PeerStream
    try {
      stream = this._dial()
    } catch {
      this.redialLater()
      return
    }
    this._dialing = stream
    // A stream that fails re-emits its error while destroying; with nobody
    // listening that would take the whole process down.
    stream.on("error", noop)

    const settle = () => {
      stream.removeListener("open", onOpen)
      stream.removeListener("error", onFail)
      stream.removeListener("close", onFail)
    }
    const onOpen = () => {
      settle()
      if (this._dialing !== stream) {
        stream.destroy()
        return
      }
      this._dialing = undefined
      this._lastDialError = undefined
      this.attach(stream)
    }
    const onFail = (error?: Error) => {
      settle()
      if (this._dialing !== stream) return
      this._dialing = undefined
      // A close without an error is the transport giving up quietly.
      const reason = error instanceof Error ? error : new Error("Connection closed before it opened")
      this._lastDialError = reason
      this.emit(CLIENT_EVENT.dialFailed, reason)
      this.redialLater()
    }
    stream.on("open", onOpen)
    stream.on("error", onFail)
    stream.on("close", () => onFail())
  }

  private redialLater() {
    if (this._redialTimer || this._state !== "connecting") return
    this._redialTimer = setTimeout(() => {
      this._redialTimer = undefined
      this.dial()
    }, REDIAL_MS)
  }

  /** Stops the connect timer, any pending redial, and a dial in flight. */
  private stopDialling() {
    this.clearConnectTimer()
    if (this._redialTimer) clearTimeout(this._redialTimer)
    this._redialTimer = undefined
    const dialing = this._dialing
    this._dialing = undefined
    if (dialing && !dialing.destroyed) dialing.destroy()
  }

  public disconnect() {
    this.stopDialling()
    this._session?.close()
    this._session = undefined
    this.failAll(
      new P2pRequestError("disconnected", "Disconnected from the device.")
    )
    this.setState("disconnected")
  }

  public destroy() {
    this._destroyed = true
    this.disconnect()
    this.removeAllListeners()
  }

  /* ------------------------------------------------------------------------ */
  /*  Requests                                                                 */
  /* ------------------------------------------------------------------------ */

  public async pair(secret: Buffer, name?: string): Promise<NodeInfo> {
    const reply = await this.request(
      {
        id: this.nextId(),
        type: "pair",
        secret: secret.toString("hex"),
        name,
        version: P2P_PROTOCOL_VERSION
      },
      "paired"
    )
    return reply.type === "paired" ? reply.node : this.unexpected(reply)
  }

  public async ping(): Promise<PingResult> {
    const started = Date.now()
    const reply = await this.request(
      { id: this.nextId(), type: "ping" },
      "pong"
    )
    if (reply.type !== "pong") return this.unexpected(reply)
    return {
      latencyMs: Date.now() - started,
      node: reply.node,
      ollama: reply.ollama
    }
  }

  public async listModels(): Promise<RemoteModel[]> {
    const reply = await this.request(
      { id: this.nextId(), type: "models" },
      "models"
    )
    return reply.type === "models" ? reply.models : this.unexpected(reply)
  }

  /**
   * Starts an inference request. Frames are delivered to the handlers as
   * they arrive; `cancel()` tells the node to stop generating.
   */
  public infer(
    kind: InferenceKind,
    request: InferenceBody,
    handlers: InferenceHandlers
  ): InferenceHandle {
    const id = this.nextId()
    const stream: OpenStream = { handlers }
    this._streams.set(id, stream)

    stream.timer = setTimeout(() => {
      this.finishStream(id)
      this.send({ type: "cancel", id })
      handlers.onError(
        new P2pRequestError(
          "timeout",
          "The device did not start answering in time. The model may still be loading."
        )
      )
    }, this._options.firstByteTimeoutMs)

    if (!this.send({ id, type: kind, request })) {
      this.finishStream(id)
      queueMicrotask(() =>
        handlers.onError(
          new P2pRequestError("disconnected", "Not connected to the device.")
        )
      )
    }

    return {
      cancel: () => {
        if (!this._streams.has(id)) return
        this.finishStream(id)
        this.send({ type: "cancel", id })
        handlers.onError(new P2pRequestError("cancelled", "Cancelled."))
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Internals                                                                */
  /* ------------------------------------------------------------------------ */

  private request(
    frame: ClientFrame,
    expect: NodeFrame["type"]
  ): Promise<NodeFrame> {
    const id = "id" in frame ? frame.id : this.nextId()
    return new Promise<NodeFrame>((resolve, reject) => {
      if (!this.send(frame)) {
        reject(
          new P2pRequestError("disconnected", "Not connected to the device.")
        )
        return
      }
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(
          new P2pRequestError("timeout", "The device did not answer in time.")
        )
      }, this._options.requestTimeoutMs)
      this._pending.set(id, { expect, resolve, reject, timer })
    })
  }

  private send(frame: ClientFrame): boolean {
    return this._session?.send(frame) ?? false
  }

  private onFrame(raw: unknown) {
    const frame = parseNodeFrame(raw)
    if (!frame) return

    const pending = this._pending.get(frame.id)
    if (pending) {
      this._pending.delete(frame.id)
      clearTimeout(pending.timer)
      if (frame.type === "error") {
        pending.reject(new P2pRequestError(frame.code, frame.message))
      } else {
        pending.resolve(frame)
      }
      return
    }

    const stream = this._streams.get(frame.id)
    if (!stream) return
    if (stream.timer) {
      clearTimeout(stream.timer)
      stream.timer = undefined
    }
    switch (frame.type) {
      case "head":
        stream.handlers.onHead?.(frame)
        break
      case "body":
        stream.handlers.onChunk(frame.chunk)
        break
      case "end":
        this.finishStream(frame.id)
        stream.handlers.onEnd()
        break
      case "error":
        this.finishStream(frame.id)
        stream.handlers.onError(new P2pRequestError(frame.code, frame.message))
        break
      default:
        break
    }
  }

  private finishStream(id: string) {
    const stream = this._streams.get(id)
    if (!stream) return
    if (stream.timer) clearTimeout(stream.timer)
    this._streams.delete(id)
  }

  private failAll(error: P2pRequestError) {
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timer)
      this._pending.delete(id)
      pending.reject(error)
    }
    for (const [id, stream] of this._streams) {
      this.finishStream(id)
      stream.handlers.onError(error)
    }
  }

  private setState(state: ClientState) {
    if (this._state === state) return
    this._state = state
    this.emit(CLIENT_EVENT.state, state)
  }

  private clearConnectTimer() {
    if (!this._connectTimer) return
    clearTimeout(this._connectTimer)
    this._connectTimer = undefined
  }

  private nextId(): string {
    return randomUUID()
  }

  private unexpected(frame: NodeFrame): never {
    throw new P2pRequestError(
      "upstream",
      `Unexpected reply "${frame.type}" from the device.`
    )
  }
}

/**
 * The peers: developers' machines that opened a sharing connection to
 * the gateway and will run jobs on their local server.
 *
 * Each connection is a WebSocket the extension dialled, authenticated
 * with the developer's key before it got here. The registry waits for
 * the `hello`, answers `welcome`, keeps the peer's model list current,
 * pings it, hands it jobs, and relays chunks back to whoever asked. A
 * peer that goes quiet, loses its key or breaks the protocol is closed
 * and its jobs fail with `provider-unavailable`.
 *
 * Nothing about a job is logged here beyond its id, model and outcome.
 */
import { EventEmitter } from "node:events"

import { InferenceError } from "../extension/inference/errors"
import type {
  ChatChunk,
  ChatRequest,
  EmbeddingRequest,
  EmbeddingResponse,
  FimChunk,
  FimRequest,
  InferenceCapability,
  InferenceUsage
} from "../extension/inference/types"
import {
  encodePeerFrame,
  GatewayToPeerFrame,
  HELLO_TIMEOUT_MS,
  MAX_PEER_SLOTS,
  parsePeerFrame,
  PEER_CLOSE,
  PEER_DEGRADED_MS,
  PEER_PING_INTERVAL_MS,
  PEER_PROTOCOL_VERSION,
  peerLabel,
  PeerModel,
  PeerProtocolError,
  PeerToGatewayFrame
} from "../protocol/peer"
import type { WebSocketConnection } from "../protocol/websocket"

import type { GatewayLog } from "./log"

/** A peer as the admin page and the status route see it. */
export interface PeerSnapshot {
  id: string
  /** The key that shares. */
  key: string
  machine: string
  /** `key@machine`. */
  label: string
  backend: string
  models: string[]
  slots: number
  inflight: number
  connectedAt: string
  served: number
  failed: number
  /** Set while the peer's local server is being skipped. */
  degradedUntil?: string
}

export interface PeerRegistryOptions {
  log: GatewayLog
  /** Backend model names the pool's aliases want, for the welcome frame. */
  wanted(): string[]
  /** Whether a key is still active; a peer whose key is not is closed with 4001. */
  keyActive(key: string): boolean
  /** True once the gateway has a team pool; without one peers are refused with 4004. */
  configured(): boolean
  pingIntervalMs?: number
  helloTimeoutMs?: number
}

/** Thrown into a job when the peer serving it went away. The pool retries once on another peer when nothing was streamed yet. */
export class PeerLostError extends InferenceError {
  constructor(label: string, reason: string) {
    super("provider-unavailable", `The teammate serving this request (${label}) went offline: ${reason}`)
    this.name = "PeerLostError"
  }
}

type JobItem =
  | { chunk: FimChunk | ChatChunk }
  | { done: true; usage?: InferenceUsage; response?: EmbeddingResponse }
  | { error: InferenceError }

/** One job's stream of chunks, filled by frames and read by the pool. */
class JobChannel {
  private readonly _items: JobItem[] = []
  private _wake?: () => void
  public ended = false
  public chunks = 0

  public push(item: JobItem) {
    if (this.ended) return
    if ("chunk" in item) this.chunks++
    else this.ended = true
    this._items.push(item)
    this._wake?.()
  }

  public async next(): Promise<JobItem> {
    while (!this._items.length) {
      await new Promise<void>((resolve) => {
        this._wake = resolve
      })
      this._wake = undefined
    }
    return this._items.shift() as JobItem
  }
}

interface Job {
  id: string
  channel: JobChannel
  capability: InferenceCapability
  model: string
}

interface Peer {
  id: string
  key: string
  machine: string
  backend: string
  models: Set<string>
  slots: number
  connectedAt: number
  served: number
  failed: number
  degradedUntil: number
  socket: WebSocketConnection
  jobs: Map<string, Job>
  /** Set when a ping went out and no pong has come back. */
  awaitingPong: boolean
  helloTimer?: ReturnType<typeof setTimeout>
  closed: boolean
}

let nextPeerId = 1
let nextJobId = 1

export class PeerRegistry extends EventEmitter {
  private readonly _peers = new Map<string, Peer>()
  private _ticker?: ReturnType<typeof setInterval>
  private _stopping = false

  constructor(private readonly _options: PeerRegistryOptions) {
    super()
  }

  /** Starts the ping/verify ticker. Idempotent. */
  public start(): void {
    if (this._ticker) return
    this._ticker = setInterval(() => this.tick(), this._options.pingIntervalMs ?? PEER_PING_INTERVAL_MS)
    this._ticker.unref?.()
  }

  /**
   * Stops admitting peers, waits up to `graceMs` for their jobs to
   * finish, then closes every connection with 1001.
   */
  public async stop(graceMs = 0): Promise<void> {
    this._stopping = true
    if (this._ticker) clearInterval(this._ticker)
    this._ticker = undefined
    const deadline = Date.now() + graceMs
    while (this.inflight() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    for (const peer of [...this._peers.values()]) {
      this.close(peer, PEER_CLOSE.stopping, "The gateway is stopping.")
    }
  }

  public get size(): number {
    return this._peers.size
  }

  /** Peers that have said hello. */
  public online(): number {
    return this._peers.size
  }

  public inflight(): number {
    let total = 0
    for (const peer of this._peers.values()) total += peer.jobs.size
    return total
  }

  public snapshot(): PeerSnapshot[] {
    return [...this._peers.values()]
      .map((peer) => ({
        id: peer.id,
        key: peer.key,
        machine: peer.machine,
        label: peerLabel(peer.key, peer.machine),
        backend: peer.backend,
        models: [...peer.models].sort(),
        slots: peer.slots,
        inflight: peer.jobs.size,
        connectedAt: new Date(peer.connectedAt).toISOString(),
        served: peer.served,
        failed: peer.failed,
        ...(peer.degradedUntil > Date.now() ? { degradedUntil: new Date(peer.degradedUntil).toISOString() } : {})
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  /** Every model some connected peer offers. */
  public models(): string[] {
    const all = new Set<string>()
    for (const peer of this._peers.values()) for (const model of peer.models) all.add(model)
    return [...all].sort()
  }

  /** Takes a freshly upgraded socket; the peer is listed once it says hello. */
  public attach(socket: WebSocketConnection, key: string): void {
    if (this._stopping) {
      socket.close(PEER_CLOSE.stopping, "The gateway is stopping.")
      return
    }
    if (!this._options.configured()) {
      socket.close(PEER_CLOSE.notConfigured, "This gateway has no team pool configured.")
      return
    }
    const peer: Peer = {
      id: `p${nextPeerId++}`,
      key,
      machine: "",
      backend: "",
      models: new Set(),
      slots: 1,
      connectedAt: Date.now(),
      served: 0,
      failed: 0,
      degradedUntil: 0,
      socket,
      jobs: new Map(),
      awaitingPong: false,
      closed: false
    }
    let greeted = false
    peer.helloTimer = setTimeout(() => {
      if (!greeted) this.close(peer, PEER_CLOSE.protocol, "No hello within the time allowed.")
    }, this._options.helloTimeoutMs ?? HELLO_TIMEOUT_MS)
    peer.helloTimer.unref?.()

    socket.on("message", (text) => {
      let frame: PeerToGatewayFrame
      try {
        frame = parsePeerFrame(text)
      } catch (error) {
        this.close(peer, PEER_CLOSE.protocol, error instanceof PeerProtocolError ? error.message : "Malformed frame.")
        return
      }
      if (!greeted) {
        if (frame.type !== "hello") {
          this.close(peer, PEER_CLOSE.protocol, "The first frame must be hello.")
          return
        }
        greeted = true
        if (peer.helloTimer) clearTimeout(peer.helloTimer)
        peer.machine = frame.name
        peer.backend = frame.backend.kind
        peer.models = new Set(frame.models.map((model) => model.id))
        peer.slots = Math.min(frame.slots, MAX_PEER_SLOTS)
        this._peers.set(peer.id, peer)
        this.send(peer, { type: "welcome", protocol: PEER_PROTOCOL_VERSION, wanted: this._options.wanted(), slots: peer.slots })
        this._options.log.info({ event: "peer.connected", key: peer.key, peer: peerLabel(peer.key, peer.machine), provider: peer.backend, models: peer.models.size })
        this.start()
        this.changed()
        return
      }
      this.onFrame(peer, frame)
    })
    socket.on("close", (code, reason) => this.onClosed(peer, code, reason))
    socket.on("error", () => undefined)
  }

  /**
   * The peer to hand a job for this model: offering it, with a free
   * slot, not degraded, least in flight; ties go to the longest-idle.
   * `undefined` when none qualifies; `busy` says whether one would have,
   * had it a free slot.
   */
  public pick(model: string, exclude: string[] = []): { peer?: PeerSnapshot; offered: number; busy: boolean } {
    const now = Date.now()
    const offering = [...this._peers.values()].filter(
      (peer) => peer.models.has(model) && !exclude.includes(peer.id) && !peer.closed
    )
    const ready = offering.filter((peer) => peer.degradedUntil <= now)
    const free = ready.filter((peer) => peer.jobs.size < peer.slots)
    const pool = free.length ? free : offering.filter((peer) => peer.jobs.size < peer.slots)
    if (!pool.length) return { offered: offering.length, busy: offering.length > 0 }
    pool.sort((a, b) => a.jobs.size - b.jobs.size || a.connectedAt - b.connectedAt)
    const chosen = pool[0]
    return { peer: this.snapshot().find((entry) => entry.id === chosen.id), offered: offering.length, busy: false }
  }

  /**
   * Streams a fim or chat job on a peer. The iterable ends when the peer
   * sends `done`; a peer error or loss is thrown. Stopping early cancels
   * the job on the peer.
   */
  public stream(
    peerId: string,
    capability: "fim" | "chat",
    request: FimRequest | ChatRequest,
    signal?: AbortSignal
  ): AsyncIterable<FimChunk | ChatChunk> {
    const job = this.begin(peerId, capability, request)
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const registry = this
    return {
      [Symbol.asyncIterator]: async function* () {
        const onAbort = () => registry.cancel(peerId, job.id)
        signal?.addEventListener("abort", onAbort, { once: true })
        try {
          for (;;) {
            const item = await job.channel.next()
            if ("chunk" in item) {
              yield item.chunk
              continue
            }
            if ("error" in item) throw item.error
            if (item.usage) yield capability === "fim" ? { text: "", usage: item.usage } : { content: "", usage: item.usage }
            return
          }
        } finally {
          signal?.removeEventListener("abort", onAbort)
          registry.cancel(peerId, job.id)
        }
      }
    }
  }

  /** Runs an embeddings job on a peer; resolves with the response from its done frame. */
  public async embed(peerId: string, request: EmbeddingRequest, signal?: AbortSignal): Promise<EmbeddingResponse> {
    const job = this.begin(peerId, "embeddings", request)
    const onAbort = () => this.cancel(peerId, job.id)
    signal?.addEventListener("abort", onAbort, { once: true })
    try {
      for (;;) {
        const item = await job.channel.next()
        if ("chunk" in item) continue
        if ("error" in item) throw item.error
        if (!item.response) throw new InferenceError("inference-failure", "The teammate's machine answered without an embedding.")
        return item.usage ? { ...item.response, usage: item.usage } : item.response
      }
    } finally {
      signal?.removeEventListener("abort", onAbort)
      this.cancel(peerId, job.id)
    }
  }

  /** How many chunks a job has produced so far; the pool's retry rule. */
  public chunksOf(peerId: string, jobId: string): number {
    return this._peers.get(peerId)?.jobs.get(jobId)?.channel.chunks ?? 0
  }

  public disconnect(peerId: string, code: number = PEER_CLOSE.disconnected, reason = "Disconnected by an admin."): boolean {
    const peer = this._peers.get(peerId)
    if (!peer) return false
    this.close(peer, code, reason)
    return true
  }

  /** Closes every peer with one code: the pool was removed from the configuration, say. */
  public disconnectAll(code: number, reason: string): void {
    for (const peer of [...this._peers.values()]) this.close(peer, code, reason)
  }

  /** Tells every peer the pool's wants changed (a config save). */
  public refreshWanted(): void {
    const wanted = this._options.wanted()
    for (const peer of this._peers.values()) {
      this.send(peer, { type: "welcome", protocol: PEER_PROTOCOL_VERSION, wanted, slots: peer.slots })
    }
  }

  /* ------------------------------------------------------------------------ */

  private begin(peerId: string, capability: InferenceCapability, request: FimRequest | ChatRequest | EmbeddingRequest): Job {
    const peer = this._peers.get(peerId)
    if (!peer || peer.closed) throw new PeerLostError(peerId, "not connected")
    if (!peer.models.has(request.model)) {
      throw new InferenceError("model-unavailable", `${peerLabel(peer.key, peer.machine)} no longer offers ${request.model}.`)
    }
    if (peer.jobs.size >= peer.slots) {
      throw new InferenceError("rate-limited", `${peerLabel(peer.key, peer.machine)} is running ${peer.slots} request(s) already.`)
    }
    const job: Job = { id: `j${nextJobId++}`, channel: new JobChannel(), capability, model: request.model }
    peer.jobs.set(job.id, job)
    this.send(peer, { type: "job", id: job.id, capability, request })
    this.changed()
    return job
  }

  /** Ends a job from the gateway's side; a no-op once it finished. */
  private cancel(peerId: string, jobId: string) {
    const peer = this._peers.get(peerId)
    const job = peer?.jobs.get(jobId)
    if (!peer || !job) return
    peer.jobs.delete(jobId)
    if (!job.channel.ended) {
      job.channel.push({ error: new InferenceError("cancelled", "The request was cancelled.") })
      this.send(peer, { type: "cancel", id: jobId })
    }
    this.changed()
  }

  private onFrame(peer: Peer, frame: PeerToGatewayFrame) {
    switch (frame.type) {
      case "hello":
        this.close(peer, PEER_CLOSE.protocol, "hello was already sent.")
        return
      case "pong":
        peer.awaitingPong = false
        return
      case "models": {
        peer.models = new Set(frame.models.map((model: PeerModel) => model.id))
        this.changed()
        return
      }
      case "chunk": {
        const job = peer.jobs.get(frame.id)
        if (!job || job.capability === "embeddings") return
        job.channel.push({ chunk: frame.chunk })
        return
      }
      case "done": {
        const job = peer.jobs.get(frame.id)
        if (!job) return
        peer.jobs.delete(frame.id)
        peer.served++
        job.channel.push({ done: true, usage: frame.usage, response: frame.response })
        this.changed()
        return
      }
      case "error": {
        const job = peer.jobs.get(frame.id)
        if (!job) return
        peer.jobs.delete(frame.id)
        peer.failed++
        const error = new InferenceError(frame.error.kind, frame.error.message)
        if (error.kind === "provider-unavailable") {
          peer.degradedUntil = Date.now() + PEER_DEGRADED_MS
          this._options.log.warn({ event: "peer.degraded", key: peer.key, peer: peerLabel(peer.key, peer.machine), kind: error.kind })
        }
        job.channel.push({ error })
        this.changed()
        return
      }
    }
  }

  private onClosed(peer: Peer, code: number, reason: string) {
    if (peer.helloTimer) clearTimeout(peer.helloTimer)
    const listed = this._peers.delete(peer.id)
    peer.closed = true
    const label = peerLabel(peer.key, peer.machine || "?")
    for (const job of peer.jobs.values()) {
      job.channel.push({ error: new PeerLostError(label, reason || `closed with ${code}`) })
    }
    peer.jobs.clear()
    if (listed) {
      this._options.log.info({ event: "peer.disconnected", key: peer.key, peer: label, code, reason })
      this.changed()
    }
  }

  private close(peer: Peer, code: number, reason: string) {
    if (peer.closed) return
    peer.socket.close(code, reason)
    // The close handshake may never complete (a dead peer); the socket's
    // own close fires `onClosed` either way, at the latest when it is destroyed.
  }

  private send(peer: Peer, frame: GatewayToPeerFrame) {
    if (peer.closed) return
    void peer.socket.send(encodePeerFrame(frame))
  }

  /** Every interval: verify each key, then ping; a peer that never answered the last ping is gone. */
  private tick() {
    for (const peer of [...this._peers.values()]) {
      if (!this._options.keyActive(peer.key)) {
        this.close(peer, PEER_CLOSE.revoked, "This key was revoked.")
        continue
      }
      if (peer.awaitingPong) {
        this.close(peer, PEER_CLOSE.protocol, "No pong within the time allowed.")
        peer.socket.destroy(PEER_CLOSE.protocol, "No pong within the time allowed.")
        continue
      }
      peer.awaitingPong = true
      this.send(peer, { type: "ping" })
    }
    if (!this._peers.size && this._ticker) {
      clearInterval(this._ticker)
      this._ticker = undefined
    }
  }

  private changed() {
    this.emit("change", this.snapshot())
  }
}

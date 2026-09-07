import Hyperswarm from "hyperswarm"
import { createHash, randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"

import { logger } from "../../common/logger"

import { P2pJoinOptions, P2pMessage, P2pPeer } from "./types"

export const P2P_EVENT_NAME = {
  error: "error",
  message: "message",
  peerJoin: "peer-join",
  peerLeave: "peer-leave"
} as const

const TOPIC_BYTE_LENGTH = 32
const MESSAGE_DELIMITER = "\n"

/**
 * A small wrapper around hyperswarm for talking to other peers on a topic.
 *
 * It does four things and nothing else: join a topic, track who is connected,
 * move newline delimited JSON messages in both directions, and tear it all
 * down again. There is no protocol baked in — decide what your `key` values
 * mean and build on top.
 *
 * ```ts
 * const p2p = new P2pConnectionManager()
 * p2p.on(P2P_EVENT_NAME.message, ({ key, data }) => console.log(key, data))
 * await p2p.join(P2pConnectionManager.topicFromName("my-room"))
 * p2p.broadcast({ key: "hello", data: { from: "twinny" } })
 * ```
 */
export class P2pConnectionManager extends EventEmitter {
  private _buffers = new Map<P2pPeer, string>()
  private _peers = new Set<P2pPeer>()
  private _swarm: typeof Hyperswarm | undefined
  private _topic: Buffer | undefined

  /** Peers currently connected on the joined topic. */
  public get peers(): P2pPeer[] {
    return [...this._peers]
  }

  /** The topic we are joined to, if any. */
  public get topic(): Buffer | undefined {
    return this._topic
  }

  public get isJoined(): boolean {
    return Boolean(this._swarm)
  }

  /** A brand new random topic, for when you are creating the rendezvous. */
  public static createTopic(): Buffer {
    return randomBytes(TOPIC_BYTE_LENGTH)
  }

  /** A stable topic derived from any human readable name. */
  public static topicFromName(name: string): Buffer {
    return createHash("sha256").update(name).digest()
  }

  /** A topic someone shared with you as hex, e.g. from `topic.toString("hex")`. */
  public static topicFromHex(hex: string): Buffer {
    const topic = Buffer.from(hex, "hex")
    if (topic.length !== TOPIC_BYTE_LENGTH) {
      throw new Error(
        `A topic must be ${TOPIC_BYTE_LENGTH} bytes, got ${topic.length}`
      )
    }
    return topic
  }

  /**
   * Join `topic` and start accepting peers. Resolves once the topic has been
   * announced to the DHT, not once a peer has arrived — listen for
   * `peer-join` for that.
   */
  public async join(
    topic: Buffer,
    options: P2pJoinOptions = {}
  ): Promise<void> {
    if (this._swarm) await this.leave()

    const { client = true, server = true } = options

    this._topic = topic
    this._swarm = new Hyperswarm()
    this._swarm.on("connection", this.handleConnection)

    const discovery = this._swarm.join(topic, { client, server })
    await discovery.flushed()

    logger.log(`p2p: joined topic ${topic.toString("hex")}`)
  }

  /** Leave the topic and drop every peer, but stay reusable. */
  public async leave(): Promise<void> {
    const swarm = this._swarm
    this._swarm = undefined
    this._topic = undefined

    for (const peer of this._peers) this.forgetPeer(peer)

    if (!swarm) return
    await swarm.destroy()
    logger.log("p2p: left topic")
  }

  /** Send a message to every connected peer. Returns how many it reached. */
  public broadcast<T>(message: P2pMessage<T>): number {
    let sent = 0
    for (const peer of this._peers) {
      if (this.send(peer, message)) sent++
    }
    return sent
  }

  /** Send a message to one peer. Returns false if it was not writable. */
  public send<T>(peer: P2pPeer, message: P2pMessage<T>): boolean {
    if (!peer.writable) return false
    try {
      return peer.write(JSON.stringify(message) + MESSAGE_DELIMITER)
    } catch (error) {
      this.handleError(error)
      return false
    }
  }

  /** Leave the topic and release everything. The manager is done after this. */
  public async destroy(): Promise<void> {
    await this.leave()
    this.removeAllListeners()
  }

  private handleConnection = (peer: P2pPeer) => {
    this._peers.add(peer)
    this._buffers.set(peer, "")

    peer.on("data", (chunk: Buffer) => this.handleData(peer, chunk))
    peer.on("error", (error: Error) => this.handleError(error))
    peer.on("close", () => {
      this.forgetPeer(peer)
      this.emit(P2P_EVENT_NAME.peerLeave, peer)
    })

    logger.log(`p2p: peer joined (${this._peers.size} connected)`)
    this.emit(P2P_EVENT_NAME.peerJoin, peer)
  }

  /**
   * Peers speak newline delimited JSON, so a chunk may hold several messages
   * or half of one. Buffer whatever is left over until its newline arrives.
   */
  private handleData = (peer: P2pPeer, chunk: Buffer) => {
    const buffered = (this._buffers.get(peer) ?? "") + chunk.toString()
    const lines = buffered.split(MESSAGE_DELIMITER)

    this._buffers.set(peer, lines.pop() ?? "")

    for (const line of lines) {
      if (!line.trim()) continue
      const message = this.parseMessage(line)
      if (message) this.emit(P2P_EVENT_NAME.message, message, peer)
    }
  }

  private parseMessage(line: string): P2pMessage | undefined {
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed.key === "string") return parsed as P2pMessage
      logger.error(`p2p: ignoring message with no key: ${line}`)
    } catch {
      logger.error(`p2p: could not parse message: ${line}`)
    }
    return undefined
  }

  private forgetPeer(peer: P2pPeer) {
    this._peers.delete(peer)
    this._buffers.delete(peer)
    peer.removeAllListeners()
  }

  private handleError = (error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error))
    logger.error(`p2p: ${err.message}`)
    // Only emit when something is listening; a bare "error" event throws.
    if (this.listenerCount(P2P_EVENT_NAME.error)) {
      this.emit(P2P_EVENT_NAME.error, err)
    }
  }
}

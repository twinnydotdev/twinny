/**
 * One framed conversation with one peer.
 *
 * Wraps a hyperdht connection: bytes in become parsed frames out, frames
 * in become bytes out, and every way the stream can die ends up as a single
 * `close` event. Neither side's protocol logic touches the raw stream.
 */

import { EventEmitter } from "node:events"

import { encodeFrame, FrameDecoder } from "./framing"
import { toHex } from "./identity"
import { PeerStream } from "./types"

const noop = () => undefined
const CLOSE_GRACE_MS = 300

export const SESSION_EVENT = {
  frame: "frame",
  close: "close"
} as const

export class PeerSession extends EventEmitter {
  public readonly remotePublicKeyHex: string
  private readonly _decoder: FrameDecoder
  private _finished = false

  constructor(
    public readonly stream: PeerStream,
    maxFrameBytes?: number
  ) {
    super()
    this.remotePublicKeyHex = toHex(stream.remotePublicKey)
    this._decoder = new FrameDecoder(maxFrameBytes)

    stream.on("data", this.onData)
    stream.on("end", this.onEnd)
    stream.on("error", this.onError)
    stream.on("close", this.onClose)
  }

  public get closed(): boolean {
    return this._finished || this.stream.destroyed
  }

  /** Returns false when the frame could not be written. */
  public send(frame: unknown): boolean {
    if (this.closed) return false
    try {
      return this.stream.write(encodeFrame(frame))
    } catch {
      return false
    }
  }

  /**
   * Ends the conversation. Without an error the stream is ended politely so
   * a final frame (an explanation, say) still reaches the other side; the
   * stream is torn down for good shortly after in case the peer never
   * answers the end.
   */
  public close(error?: Error) {
    if (this._finished) return
    try {
      if (error) {
        this.stream.destroy(error)
      } else {
        this.stream.end()
        setTimeout(() => {
          if (!this.stream.destroyed) this.stream.destroy()
        }, CLOSE_GRACE_MS).unref?.()
      }
    } catch {
      // Already gone.
    }
    this.finish(error)
  }

  private onData = (chunk: Buffer) => {
    let frames: unknown[]
    try {
      frames = this._decoder.push(chunk)
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)))
      return
    }
    for (const frame of frames) this.emit(SESSION_EVENT.frame, frame)
  }

  private onError = (error: Error) => this.finish(error)

  /** The peer ended its side; end ours so the stream can close. */
  private onEnd = () => this.close()

  private onClose = () => this.finish()

  private finish(error?: Error) {
    if (this._finished) return
    this._finished = true
    this.stream.removeListener("data", this.onData)
    this.stream.removeListener("end", this.onEnd)
    this.stream.removeListener("error", this.onError)
    this.stream.removeListener("close", this.onClose)
    // A stream torn down with an error emits it again while destroying; with
    // nobody listening that would take the whole process down.
    this.stream.on("error", noop)
    this.emit(SESSION_EVENT.close, error)
    this.removeAllListeners()
  }
}

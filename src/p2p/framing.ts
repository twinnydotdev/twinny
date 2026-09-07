/**
 * Newline-delimited JSON over a byte stream.
 *
 * A chunk may hold several frames or half of one; the decoder keeps what is
 * left over until its newline arrives. A peer that sends an absurdly long
 * line is cut off before it can make us buffer it.
 */

import { MAX_FRAME_BYTES } from "./protocol"

export const FRAME_DELIMITER = "\n"

export class FrameTooLargeError extends Error {
  constructor(limit: number) {
    super(`Peer sent a frame larger than ${limit} bytes`)
    this.name = "FrameTooLargeError"
  }
}

export const encodeFrame = (frame: unknown): string =>
  JSON.stringify(frame) + FRAME_DELIMITER

export class FrameDecoder {
  private _pending: Buffer[] = []
  private _pendingBytes = 0

  constructor(private readonly _maxBytes = MAX_FRAME_BYTES) {}

  /**
   * Feed bytes in; get every complete frame out, parsed. Lines that are not
   * JSON objects are skipped rather than thrown, since one bad line from a
   * peer should not take the connection down.
   */
  public push(chunk: Buffer | string): unknown[] {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
    const frames: unknown[] = []

    let start = 0
    let newline = bytes.indexOf(FRAME_DELIMITER, start)
    while (newline !== -1) {
      const line = this.take(bytes.subarray(start, newline))
      if (line !== undefined) frames.push(line)
      start = newline + 1
      newline = bytes.indexOf(FRAME_DELIMITER, start)
    }

    if (start < bytes.length) {
      const rest = bytes.subarray(start)
      this._pendingBytes += rest.length
      if (this._pendingBytes > this._maxBytes) {
        this.reset()
        throw new FrameTooLargeError(this._maxBytes)
      }
      this._pending.push(Buffer.from(rest))
    }

    return frames
  }

  public reset() {
    this._pending = []
    this._pendingBytes = 0
  }

  private take(tail: Buffer): unknown | undefined {
    const total = this._pendingBytes + tail.length
    if (total > this._maxBytes) {
      this.reset()
      throw new FrameTooLargeError(this._maxBytes)
    }
    const line = this._pending.length
      ? Buffer.concat([...this._pending, tail]).toString("utf8")
      : tail.toString("utf8")
    this.reset()

    const trimmed = line.trim()
    if (!trimmed) return undefined
    try {
      const parsed: unknown = JSON.parse(trimmed)
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed
        : undefined
    } catch {
      return undefined
    }
  }
}

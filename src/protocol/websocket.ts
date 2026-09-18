/**
 * The subset of RFC 6455 both ends of a peer connection need, on top of
 * Node's `net`/`http` modules and nothing else, so the server bundle stays
 * dependency-free and the extension does not depend on a global
 * `WebSocket` its Node may not have.
 *
 * Covered: the handshake (accept key), text and control frames, client-side
 * masking, fragmentation, 16- and 64-bit lengths, ping/pong/close with a
 * proper close handshake, and a cap on message size. Not covered:
 * extensions (compression), subprotocol negotiation, binary messages as
 * anything but bytes.
 *
 * Pure: no vscode, shared by the extension and the gateway.
 */
import { createHash, randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import http from "node:http"
import https from "node:https"
import type { Socket } from "node:net"

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

/** The largest message either side will assemble; a peer sending more is closed. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa
} as const

export type Opcode = (typeof OPCODE)[keyof typeof OPCODE]

/** Close codes in use; 4000–4999 are the application's own. */
export const CLOSE_CODE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupported: 1003,
  /** Reserved: the connection dropped without a close frame. */
  abnormal: 1006,
  tooLarge: 1009,
  internal: 1011
} as const

export interface Frame {
  fin: boolean
  opcode: Opcode
  payload: Buffer
}

/* -------------------------------------------------------------------------- */
/*  Handshake                                                                 */
/* -------------------------------------------------------------------------- */

export const acceptKeyFor = (key: string): string =>
  createHash("sha1").update(`${key}${GUID}`).digest("base64")

export const newClientKey = (): string => randomBytes(16).toString("base64")

/** Whether the headers ask for a WebSocket the way RFC 6455 wants. */
export const isUpgradeRequest = (req: http.IncomingMessage): boolean => {
  const upgrade = (req.headers.upgrade || "").toLowerCase()
  const connection = (req.headers.connection || "").toLowerCase()
  return (
    req.method === "GET" &&
    upgrade === "websocket" &&
    connection.split(",").some((token) => token.trim() === "upgrade") &&
    typeof req.headers["sec-websocket-key"] === "string" &&
    req.headers["sec-websocket-version"] === "13"
  )
}

/* -------------------------------------------------------------------------- */
/*  Frames                                                                    */
/* -------------------------------------------------------------------------- */

export interface EncodeOptions {
  fin?: boolean
  /** Set for a client: the payload is XOR-masked with a fresh key. */
  mask?: boolean
}

export const encodeFrame = (
  opcode: Opcode,
  payload: Buffer | string,
  options: EncodeOptions = {}
): Buffer => {
  const data =
    typeof payload === "string" ? Buffer.from(payload, "utf8") : payload
  const fin = options.fin !== false
  const masked = options.mask === true
  const length = data.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = (fin ? 0x80 : 0) | opcode
  if (!masked)
    return Buffer.concat([
      header,
      data
    ] as Uint8Array[])
  header[1] |= 0x80
  const key = randomBytes(4)
  const body = Buffer.allocUnsafe(length)
  for (let i = 0; i < length; i++) body[i] = data[i] ^ key[i & 3]
  return Buffer.concat([
    header,
    key,
    body
  ] as Uint8Array[])
}

export class FrameError extends Error {
  constructor(
    message: string,
    public readonly code: number = CLOSE_CODE.protocolError
  ) {
    super(message)
    this.name = "FrameError"
  }
}

/**
 * Feeds bytes in, hands complete frames out. Fragments are reassembled
 * here so consumers only ever see whole messages; control frames pass
 * straight through even mid-message, as the RFC allows.
 */
export class FrameDecoder {
  private _buffer: Buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private _fragmentOpcode?: Opcode
  private _fragmentBytes = 0

  constructor(
    private readonly _options: {
      expectMasked: boolean
      maxMessageBytes?: number
    }
  ) {}

  /** Every complete message and control frame the new bytes finish. */
  public feed(chunk: Buffer): Frame[] {
    this._buffer = this._buffer.length
      ? Buffer.concat([
          this._buffer,
          chunk
        ] as Uint8Array[])
      : chunk
    const out: Frame[] = []
    for (;;) {
      const frame = this.next()
      if (!frame) break
      const assembled = this.assemble(frame)
      if (assembled) out.push(assembled)
    }
    return out
  }

  private next(): Frame | undefined {
    const buffer = this._buffer
    if (buffer.length < 2) return undefined
    const first = buffer[0]
    const second = buffer[1]
    if (first & 0x70)
      throw new FrameError("Reserved bits set; no extension was negotiated.")
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < 4) return undefined
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return undefined
      const big = buffer.readBigUInt64BE(2)
      if (big > BigInt(Number.MAX_SAFE_INTEGER))
        throw new FrameError("Frame too large.", CLOSE_CODE.tooLarge)
      length = Number(big)
      offset = 10
    }
    if (masked !== this._options.expectMasked) {
      throw new FrameError(
        masked
          ? "A server frame must not be masked."
          : "A client frame must be masked."
      )
    }
    const max = this._options.maxMessageBytes ?? MAX_MESSAGE_BYTES
    if (length > max)
      throw new FrameError(
        `Frame larger than ${max} bytes.`,
        CLOSE_CODE.tooLarge
      )
    if (masked) offset += 4
    if (buffer.length < offset + length) return undefined
    let payload = buffer.subarray(offset, offset + length)
    if (masked) {
      const key = buffer.subarray(offset - 4, offset)
      const unmasked = Buffer.allocUnsafe(length)
      for (let i = 0; i < length; i++) unmasked[i] = payload[i] ^ key[i & 3]
      payload = unmasked
    } else {
      payload = Buffer.from(payload as Uint8Array)
    }
    this._buffer = buffer.subarray(offset + length)
    if (!isOpcode(opcode)) throw new FrameError(`Unknown opcode ${opcode}.`)
    return { fin, opcode, payload }
  }

  private assemble(frame: Frame): Frame | undefined {
    const control = frame.opcode >= 0x8
    if (control) {
      if (!frame.fin)
        throw new FrameError("A control frame must not be fragmented.")
      if (frame.payload.length > 125)
        throw new FrameError("A control frame payload is at most 125 bytes.")
      return frame
    }
    const max = this._options.maxMessageBytes ?? MAX_MESSAGE_BYTES
    if (frame.opcode === OPCODE.continuation) {
      if (this._fragmentOpcode === undefined)
        throw new FrameError("Continuation without a start.")
      this._fragmentBytes += frame.payload.length
      if (this._fragmentBytes > max)
        throw new FrameError(
          `Message larger than ${max} bytes.`,
          CLOSE_CODE.tooLarge
        )
      this.fragments.push(frame.payload)
      if (!frame.fin) return undefined
      const whole: Frame = {
        fin: true,
        opcode: this._fragmentOpcode,
        payload: Buffer.concat(this.fragments as unknown as Uint8Array[])
      }
      this.fragments = []
      this._fragmentOpcode = undefined
      this._fragmentBytes = 0
      return whole
    }
    if (this._fragmentOpcode !== undefined)
      throw new FrameError("A new message started inside a fragmented one.")
    if (frame.fin) return frame
    this._fragmentOpcode = frame.opcode
    this.fragments = [frame.payload]
    this._fragmentBytes = frame.payload.length
    return undefined
  }
}

const isOpcode = (value: number): value is Opcode =>
  (Object.values(OPCODE) as number[]).includes(value)

export const encodeClose = (code: number, reason = ""): Buffer => {
  const text = Buffer.from(reason, "utf8").subarray(0, 123)
  const payload = Buffer.alloc(2 + text.length)
  payload.writeUInt16BE(code, 0)
  text.copy(payload as Uint8Array, 2)
  return payload
}

export const decodeClose = (
  payload: Buffer
): { code: number; reason: string } => {
  if (payload.length < 2) return { code: 1005, reason: "" }
  return {
    code: payload.readUInt16BE(0),
    reason: payload.subarray(2).toString("utf8")
  }
}

/* -------------------------------------------------------------------------- */
/*  A connection                                                              */
/* -------------------------------------------------------------------------- */

export interface WebSocketEvents {
  message: (text: string) => void
  pong: (payload: Buffer) => void
  ping: (payload: Buffer) => void
  close: (code: number, reason: string) => void
  error: (error: Error) => void
}

/**
 * One WebSocket over a socket the handshake already happened on. Text
 * messages come out as strings; the other side's pings are answered
 * here. `close()` runs the close handshake and ends the socket whether
 * or not the peer answers.
 */
export class WebSocketConnection extends EventEmitter {
  private readonly _decoder: FrameDecoder
  private _closing = false
  private _closed = false
  /** What we asked for, when we started the close; reported once the peer echoes it. */
  private _closeSent?: { code: number; reason: string }
  private _closeTimer?: ReturnType<typeof setTimeout>

  constructor(
    private readonly _socket: Socket,
    private readonly _side: "client" | "server",
    options: { maxMessageBytes?: number } = {}
  ) {
    super()
    this._decoder = new FrameDecoder({
      expectMasked: _side === "server",
      maxMessageBytes: options.maxMessageBytes
    })
    _socket.setNoDelay(true)
    _socket.on("data", (chunk: Buffer) => this.onData(chunk))
    _socket.on("close", () => this.onSocketClosed())
    _socket.on("error", (error) => this.fail(error))
    _socket.on("end", () => _socket.end())
  }

  public get closed(): boolean {
    return this._closed
  }

  public get socket(): Socket {
    return this._socket
  }

  /** Queues a text message; resolves once the socket buffered or drained it. */
  public send(text: string): Promise<void> {
    return this.write(
      encodeFrame(OPCODE.text, text, { mask: this._side === "client" })
    )
  }

  public ping(payload: Buffer = Buffer.alloc(0)): void {
    void this.write(
      encodeFrame(OPCODE.ping, payload, { mask: this._side === "client" })
    )
  }

  /**
   * Starts the close handshake. The socket ends when the peer's close
   * frame arrives, or after a moment if it never does.
   */
  public close(code: number = CLOSE_CODE.normal, reason = ""): void {
    if (this._closing || this._closed) return
    this._closing = true
    this._closeSent = { code, reason }
    void this.write(
      encodeFrame(OPCODE.close, encodeClose(code, reason), {
        mask: this._side === "client"
      })
    )
    this._closeTimer = setTimeout(() => this.destroy(code, reason), 1_000)
    this._closeTimer.unref?.()
  }

  /** An error is news only to a listener; an unhandled `error` event would throw. */
  private fail(error: Error) {
    if (this.listenerCount("error") > 0) this.emit("error", error)
  }

  /** Drops the socket now. What the peer gets is a dropped connection. */
  public destroy(code: number = CLOSE_CODE.abnormal, reason = ""): void {
    if (this._closed) return
    this._closed = true
    if (this._closeTimer) clearTimeout(this._closeTimer)
    this._socket.destroy()
    this.emit("close", code, reason)
  }

  private write(bytes: Buffer): Promise<void> {
    return new Promise((resolve) => {
      if (
        this._closed ||
        this._socket.destroyed ||
        this._socket.writableEnded
      ) {
        resolve()
        return
      }
      if (this._socket.write(bytes as Uint8Array)) {
        resolve()
        return
      }
      const done = () => {
        this._socket.removeListener("drain", done)
        this._socket.removeListener("close", done)
        resolve()
      }
      this._socket.once("drain", done)
      this._socket.once("close", done)
    })
  }

  private onData(chunk: Buffer) {
    if (this._closed) return
    let frames: Frame[]
    try {
      frames = this._decoder.feed(chunk)
    } catch (error) {
      const failure =
        error instanceof FrameError ? error : new FrameError(String(error))
      this.fail(failure)
      this.close(failure.code, failure.message)
      return
    }
    for (const frame of frames) {
      if (this._closed) return
      switch (frame.opcode) {
        case OPCODE.text:
          this.emit("message", frame.payload.toString("utf8"))
          break
        case OPCODE.binary:
          this.close(CLOSE_CODE.unsupported, "Binary messages are not used.")
          return
        case OPCODE.ping:
          this.emit("ping", frame.payload)
          void this.write(
            encodeFrame(OPCODE.pong, frame.payload, {
              mask: this._side === "client"
            })
          )
          break
        case OPCODE.pong:
          this.emit("pong", frame.payload)
          break
        case OPCODE.close: {
          const { code, reason } = decodeClose(frame.payload)
          if (!this._closing) {
            this._closing = true
            void this.write(
              encodeFrame(
                OPCODE.close,
                encodeClose(code === 1005 ? CLOSE_CODE.normal : code),
                { mask: this._side === "client" }
              )
            )
          }
          this._closed = true
          if (this._closeTimer) clearTimeout(this._closeTimer)
          this._socket.end()
          // The peer's echo carries our code but usually no reason; what
          // we asked for is what the caller wants to hear back.
          const sent = this._closeSent
          this.emit("close", sent?.code ?? code, sent ? sent.reason : reason)
          return
        }
        default:
          break
      }
    }
  }

  private onSocketClosed() {
    if (this._closed) return
    this._closed = true
    if (this._closeTimer) clearTimeout(this._closeTimer)
    this.emit("close", CLOSE_CODE.abnormal, "The connection dropped.")
  }
}

/* -------------------------------------------------------------------------- */
/*  Server side                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Answers an `upgrade` event with 101 and returns the connection. The
 * caller has already decided the request may proceed (path, credential).
 */
export const acceptUpgrade = (
  req: http.IncomingMessage,
  socket: Socket,
  head: Buffer,
  options: { maxMessageBytes?: number } = {}
): WebSocketConnection => {
  const key = req.headers["sec-websocket-key"] as string
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKeyFor(key)}`,
      "",
      ""
    ].join("\r\n")
  )
  const connection = new WebSocketConnection(socket, "server", options)
  if (head.length) socket.emit("data", head)
  return connection
}

/** Refuses an upgrade with an HTTP status and a JSON body, then ends the socket. */
export const refuseUpgrade = (
  socket: Socket,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) => {
  const text = JSON.stringify(body)
  const reason = http.STATUS_CODES[status] ?? "Error"
  const lines = [
    `HTTP/1.1 ${status} ${reason}`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(text)}`,
    "Connection: close",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    text
  ]
  socket.end(lines.join("\r\n"))
}

/* -------------------------------------------------------------------------- */
/*  Client side                                                               */
/* -------------------------------------------------------------------------- */

/** A handshake the server refused; carries the status so the caller can explain. */
export class WebSocketHandshakeError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string
  ) {
    super(message)
    this.name = "WebSocketHandshakeError"
  }
}

/**
 * Opens a WebSocket to `url` (http, https, ws or wss) with the given
 * headers. Resolves once the server answered 101; rejects with the
 * status and body when it did not, so a proxy without upgrades is
 * explained rather than guessed at.
 */
export const dialWebSocket = (
  url: string,
  headers: Record<string, string> = {},
  options: {
    timeoutMs?: number
    maxMessageBytes?: number
    signal?: AbortSignal
  } = {}
): Promise<WebSocketConnection> =>
  new Promise((resolve, reject) => {
    const target = new URL(url)
    const secure = target.protocol === "https:" || target.protocol === "wss:"
    if (!secure && target.protocol !== "http:" && target.protocol !== "ws:") {
      reject(
        new WebSocketHandshakeError(`Unsupported URL scheme ${target.protocol}`)
      )
      return
    }
    const key = newClientKey()
    const request = (secure ? https : http).request({
      protocol: secure ? "https:" : "http:",
      hostname: target.hostname,
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers: {
        ...headers,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13"
      },
      timeout: options.timeoutMs ?? 15_000
    })
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      request.destroy()
      reject(error)
    }
    const onAbort = () =>
      fail(new WebSocketHandshakeError("The connection attempt was cancelled."))
    options.signal?.addEventListener("abort", onAbort, { once: true })
    request.on("upgrade", (response, socket, head) => {
      options.signal?.removeEventListener("abort", onAbort)
      if (settled) {
        socket.destroy()
        return
      }
      settled = true
      if (
        response.statusCode !== 101 ||
        response.headers["sec-websocket-accept"] !== acceptKeyFor(key)
      ) {
        socket.destroy()
        reject(
          new WebSocketHandshakeError(
            "The server did not complete the WebSocket handshake.",
            response.statusCode
          )
        )
        return
      }
      request.setTimeout(0)
      resolve(
        new WebSocketConnection(socket, "client", {
          maxMessageBytes: options.maxMessageBytes
        })
      )
      if (head.length) socket.emit("data", head)
    })
    request.on("response", (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk: string) => {
        if (body.length < 2_000) body += chunk
      })
      response.on("end", () => {
        options.signal?.removeEventListener("abort", onAbort)
        fail(
          new WebSocketHandshakeError(
            `The server answered HTTP ${response.statusCode} instead of upgrading.`,
            response.statusCode,
            body
          )
        )
      })
    })
    request.on("timeout", () =>
      fail(
        new WebSocketHandshakeError(
          "The server did not answer the handshake in time."
        )
      )
    )
    request.on("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort)
      fail(error)
    })
    request.end()
  })

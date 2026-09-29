/**
 * The RFC 6455 subset both ends of a peer connection use: handshake
 * vector, frame encoding across the length boundaries, masking,
 * fragmentation, control frames, size caps, and a close handshake over
 * real sockets.
 */
import * as assert from "assert"
import * as http from "http"
import { AddressInfo } from "net"

import {
  acceptKeyFor,
  acceptUpgrade,
  CLOSE_CODE,
  dialWebSocket,
  encodeFrame,
  FrameDecoder,
  FrameError,
  isUpgradeRequest,
  OPCODE,
  refuseUpgrade,
  WebSocketConnection,
  WebSocketHandshakeError
} from "../../protocol/websocket"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

suite("WebSocket codec", () => {
  test("the handshake accept key matches the RFC 6455 example", () => {
    assert.strictEqual(acceptKeyFor("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
  })

  test("frames round-trip across the 126 and 127 length boundaries, masked and unmasked", () => {
    for (const length of [0, 1, 125, 126, 127, 65_535, 65_536, 70_000]) {
      const text = "x".repeat(length)
      for (const mask of [true, false]) {
        const decoder = new FrameDecoder({ expectMasked: mask })
        const frames = decoder.feed(encodeFrame(OPCODE.text, text, { mask }))
        assert.strictEqual(frames.length, 1, `length ${length}, mask ${mask}`)
        assert.strictEqual(frames[0].opcode, OPCODE.text)
        assert.strictEqual(frames[0].fin, true)
        assert.strictEqual(frames[0].payload.toString("utf8"), text)
      }
    }
  })

  test("a frame arriving byte by byte is assembled once complete", () => {
    const decoder = new FrameDecoder({ expectMasked: true })
    const bytes = encodeFrame(OPCODE.text, "hello, world", { mask: true })
    const out = []
    for (let i = 0; i < bytes.length; i++) out.push(...decoder.feed(bytes.subarray(i, i + 1)))
    assert.strictEqual(out.length, 1)
    assert.strictEqual(out[0].payload.toString(), "hello, world")
  })

  test("fragments are reassembled and a control frame in the middle passes through", () => {
    const decoder = new FrameDecoder({ expectMasked: false })
    const parts = [
      encodeFrame(OPCODE.text, "ab", { fin: false }),
      encodeFrame(OPCODE.ping, "p"),
      encodeFrame(OPCODE.continuation, "cd", { fin: false }),
      encodeFrame(OPCODE.continuation, "ef")
    ]
    const frames = decoder.feed(Buffer.concat(parts as Uint8Array[]))
    assert.deepStrictEqual(
      frames.map((f) => [f.opcode, f.payload.toString()]),
      [
        [OPCODE.ping, "p"],
        [OPCODE.text, "abcdef"]
      ]
    )
  })

  test("the wrong masking for the side, reserved bits and oversize frames are protocol errors", () => {
    const server = new FrameDecoder({ expectMasked: true })
    assert.throws(() => server.feed(encodeFrame(OPCODE.text, "x")), (e: FrameError) => e.code === CLOSE_CODE.protocolError)
    const client = new FrameDecoder({ expectMasked: false })
    assert.throws(() => client.feed(encodeFrame(OPCODE.text, "x", { mask: true })), FrameError)
    const reserved = encodeFrame(OPCODE.text, "x")
    reserved[0] |= 0x40
    assert.throws(() => new FrameDecoder({ expectMasked: false }).feed(reserved), /Reserved bits/)
    const small = new FrameDecoder({ expectMasked: false, maxMessageBytes: 10 })
    assert.throws(() => small.feed(encodeFrame(OPCODE.text, "x".repeat(11))), (e: FrameError) => e.code === CLOSE_CODE.tooLarge)
    const fragmented = new FrameDecoder({ expectMasked: false, maxMessageBytes: 10 })
    fragmented.feed(encodeFrame(OPCODE.text, "x".repeat(6), { fin: false }))
    assert.throws(() => fragmented.feed(encodeFrame(OPCODE.continuation, "x".repeat(6))), (e: FrameError) => e.code === CLOSE_CODE.tooLarge)
    assert.throws(() => new FrameDecoder({ expectMasked: false }).feed(encodeFrame(OPCODE.ping, "x", { fin: false })), /fragmented/)
  })

  test("isUpgradeRequest wants GET, Upgrade: websocket, a key and version 13", () => {
    const fake = (headers: Record<string, string>, method = "GET") => ({ method, headers }) as unknown as http.IncomingMessage
    const good = { upgrade: "websocket", connection: "keep-alive, Upgrade", "sec-websocket-key": "abc", "sec-websocket-version": "13" }
    assert.ok(isUpgradeRequest(fake(good)))
    assert.ok(!isUpgradeRequest(fake(good, "POST")))
    assert.ok(!isUpgradeRequest(fake({ ...good, "sec-websocket-version": "8" })))
    assert.ok(!isUpgradeRequest(fake({ ...good, connection: "close" })))
  })
})

suite("WebSocket connection", function () {
  this.timeout(10_000)

  let server: http.Server
  let url: string
  let accepted: WebSocketConnection[]
  /** What the server does with the next upgrade; `accept` by default. */
  let onUpgrade: "accept" | "refuse"

  setup(async () => {
    accepted = []
    onUpgrade = "accept"
    server = http.createServer((_req, res) => res.writeHead(404).end())
    server.on("upgrade", (req, socket, head) => {
      if (onUpgrade === "refuse") {
        refuseUpgrade(socket as import("net").Socket, 401, { error: { kind: "authentication", message: "nope" } })
        return
      }
      const connection = acceptUpgrade(req, socket as import("net").Socket, head)
      connection.on("message", (text) => void connection.send(`echo:${text}`))
      accepted.push(connection)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ws`
  })

  teardown(async () => {
    for (const connection of accepted) connection.destroy()
    await new Promise((resolve) => server.close(resolve))
  })

  test("dials, exchanges text messages, answers pings, and completes a close handshake", async () => {
    const client = await dialWebSocket(url)
    const messages: string[] = []
    client.on("message", (text) => messages.push(text))
    await client.send("one")
    await client.send("two".repeat(30_000))
    await wait(100)
    assert.deepStrictEqual(messages.map((m) => m.length), ["echo:one".length, "echo:".length + 90_000])
    assert.strictEqual(messages[0], "echo:one")

    const pong = new Promise<Buffer>((resolve) => client.once("pong", resolve))
    client.ping(Buffer.from("hi"))
    assert.strictEqual((await pong).toString(), "hi")

    const serverClosed = new Promise<[number, string]>((resolve) => accepted[0].once("close", (code, reason) => resolve([code, reason])))
    const clientClosed = new Promise<[number, string]>((resolve) => client.once("close", (code, reason) => resolve([code, reason])))
    accepted[0].close(4001, "revoked")
    assert.deepStrictEqual(await clientClosed, [4001, "revoked"])
    assert.deepStrictEqual(await serverClosed, [4001, "revoked"])
    assert.ok(client.closed && accepted[0].closed)
  })

  test("a refused handshake reports the status and body", async () => {
    onUpgrade = "refuse"
    try {
      await dialWebSocket(url)
      assert.fail("expected a handshake error")
    } catch (error) {
      assert.ok(error instanceof WebSocketHandshakeError)
      assert.strictEqual(error.status, 401)
      assert.match(error.body ?? "", /authentication/)
    }
  })

  test("a plain HTTP answer where an upgrade was expected is a handshake error", async () => {
    // A server that never upgrades (a proxy without WebSocket support, say) answers 404.
    const plain = http.createServer((_req, res) => res.writeHead(404).end("no"))
    await new Promise<void>((resolve) => plain.listen(0, "127.0.0.1", resolve))
    try {
      await dialWebSocket(`http://127.0.0.1:${(plain.address() as AddressInfo).port}/`)
      assert.fail("expected a handshake error")
    } catch (error) {
      assert.ok(error instanceof WebSocketHandshakeError)
      assert.strictEqual(error.status, 404)
    } finally {
      await new Promise((resolve) => plain.close(resolve))
    }
  })

  test("a dropped socket surfaces as an abnormal close on the other side", async () => {
    const client = await dialWebSocket(url)
    const closed = new Promise<number>((resolve) => client.once("close", (code) => resolve(code)))
    await wait(20)
    accepted[0].socket.destroy()
    assert.strictEqual(await closed, CLOSE_CODE.abnormal)
  })

  test("a malformed frame from the client closes the connection with a protocol error", async () => {
    const client = await dialWebSocket(url)
    const closed = new Promise<number>((resolve) => client.once("close", (code) => resolve(code)))
    await wait(20)
    // Unmasked from a client: the server must refuse it.
    client.socket.write(new Uint8Array(encodeFrame(OPCODE.text, "unmasked")))
    assert.strictEqual(await closed, CLOSE_CODE.protocolError)
  })
})

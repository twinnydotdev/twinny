import * as assert from "assert"

import {
  encodeFrame,
  FrameDecoder,
  FrameTooLargeError
} from "../../p2p/framing"
import { createSeed, keyPairFromSeed, toHex } from "../../p2p/identity"
import {
  decodePairingCode,
  encodePairingCode,
  PairingWindow
} from "../../p2p/pairing"
import { parseClientFrame, parseNodeFrame } from "../../p2p/protocol"

suite("P2P framing", () => {
  test("splits several frames in one chunk and joins one frame across chunks", () => {
    const decoder = new FrameDecoder()
    const a = encodeFrame({ id: "1", type: "ping" })
    const b = encodeFrame({ id: "2", type: "models" })
    assert.deepStrictEqual(decoder.push(a + b), [
      { id: "1", type: "ping" },
      { id: "2", type: "models" }
    ])

    const whole = encodeFrame({ id: "3", type: "body", chunk: "héllo wörld" })
    const bytes = Buffer.from(whole, "utf8")
    // Cut inside a multi-byte character on purpose.
    const cut = whole.indexOf("é") + 1
    assert.deepStrictEqual(decoder.push(bytes.subarray(0, cut)), [])
    assert.deepStrictEqual(decoder.push(bytes.subarray(cut)), [
      { id: "3", type: "body", chunk: "héllo wörld" }
    ])
  })

  test("skips lines that are not JSON objects", () => {
    const decoder = new FrameDecoder()
    assert.deepStrictEqual(
      decoder.push("not json\n[1,2]\n\n{\"id\":\"x\",\"type\":\"end\"}\n"),
      [{ id: "x", type: "end" }]
    )
  })

  test("refuses a frame over the size limit", () => {
    const decoder = new FrameDecoder(32)
    assert.throws(() => decoder.push("x".repeat(40)), FrameTooLargeError)
    // And it is usable again afterwards.
    assert.deepStrictEqual(decoder.push("{\"id\":\"a\",\"type\":\"end\"}\n"), [
      { id: "a", type: "end" }
    ])
  })
})

suite("P2P protocol parsing", () => {
  test("accepts the client frames a node handles and nothing else", () => {
    assert.deepStrictEqual(parseClientFrame({ id: "1", type: "ping" }), {
      id: "1",
      type: "ping"
    })
    assert.deepStrictEqual(
      parseClientFrame({
        id: "2",
        type: "generate",
        request: { model: "m", prompt: "p" }
      }),
      { id: "2", type: "generate", request: { model: "m", prompt: "p" } }
    )
    assert.strictEqual(
      parseClientFrame({ id: "3", type: "generate", request: {} }),
      undefined
    )
    assert.strictEqual(
      parseClientFrame({ id: "4", type: "shell", request: { model: "m" } }),
      undefined
    )
    assert.strictEqual(parseClientFrame({ type: "ping" }), undefined)
    assert.strictEqual(parseClientFrame("ping"), undefined)
    const pair = parseClientFrame({
      id: "5",
      type: "pair",
      secret: "ab",
      name: "x".repeat(200)
    })
    assert.strictEqual(pair?.type === "pair" && pair.name?.length, 80)
  })

  test("parses node frames and defaults missing fields", () => {
    assert.deepStrictEqual(parseNodeFrame({ id: "1", type: "head" }), {
      id: "1",
      type: "head",
      status: 200,
      contentType: "application/octet-stream"
    })
    const models = parseNodeFrame({
      id: "2",
      type: "models",
      models: [{ name: "a" }, { nope: true }, "b"]
    })
    assert.deepStrictEqual(models, {
      id: "2",
      type: "models",
      models: [{ name: "a" }]
    })
    assert.strictEqual(parseNodeFrame({ id: "3", type: "body" }), undefined)
  })
})

suite("P2P pairing codes", () => {
  const seed = createSeed()
  const { publicKey } = keyPairFromSeed(seed)

  test("round-trips the node key and secret", () => {
    const window = new PairingWindow()
    const code = encodePairingCode(publicKey, window.secret)
    const decoded = decodePairingCode(code)
    assert.strictEqual(toHex(decoded.publicKey), toHex(publicKey))
    assert.ok(decoded.secret.equals(window.secret as Uint8Array))
  })

  test("tolerates whitespace from a wrapped terminal line", () => {
    const window = new PairingWindow()
    const code = encodePairingCode(publicKey, window.secret)
    const wrapped = `  ${code.slice(0, 20)}\n${code.slice(20)} \n`
    assert.ok(
      decodePairingCode(wrapped).secret.equals(window.secret as Uint8Array)
    )
  })

  test("rejects codes that are not codes", () => {
    assert.throws(() => decodePairingCode(""), /Enter the pairing code/)
    assert.throws(() => decodePairingCode("hello world!"), /does not look like/)
    assert.throws(() => decodePairingCode("YWJj"), /wrong length/)
  })

  test("a window verifies once and a wrong guess spends it", () => {
    const window = new PairingWindow()
    assert.ok(window.isOpen())
    assert.strictEqual(window.verify("00".repeat(8)), false)
    assert.strictEqual(window.isOpen(), false)
    assert.strictEqual(window.verify(window.secret.toString("hex")), false)

    const second = new PairingWindow()
    assert.strictEqual(second.verify(second.secret.toString("hex")), true)
    assert.strictEqual(second.isOpen(), false, "used up by the successful pair")
  })

  test("a window expires", () => {
    const now = Date.now()
    const window = new PairingWindow(1000, now)
    assert.ok(window.isOpen(now + 999))
    assert.strictEqual(window.isOpen(now + 1000), false)
    assert.strictEqual(
      window.verify(window.secret.toString("hex"), now + 1000),
      false
    )
  })

  test("identity is stable for a seed", () => {
    assert.strictEqual(
      toHex(keyPairFromSeed(seed).publicKey),
      toHex(keyPairFromSeed(Buffer.from(seed as Uint8Array)).publicKey)
    )
    assert.notStrictEqual(
      toHex(keyPairFromSeed(createSeed()).publicKey),
      toHex(publicKey)
    )
  })
})

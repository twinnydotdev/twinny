/**
 * The peer protocol's parsers: what each side accepts from the other,
 * and what it refuses before anything acts on it.
 */
import * as assert from "assert"

import {
  encodePeerFrame,
  MAX_PEER_SLOTS,
  parseGatewayFrame,
  parsePeerFrame,
  PEER_PROTOCOL_VERSION,
  peerLabel,
  PeerProtocolError,
  peerRoutePath
} from "../../protocol/peer"

const hello = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "hello",
    protocol: PEER_PROTOCOL_VERSION,
    name: "desktop",
    backend: { kind: "ollama" },
    models: [{ id: "qwen2.5-coder:7b", name: "qwen2.5-coder:7b" }],
    slots: 2,
    ...extra
  })

suite("Peer protocol", () => {
  test("the route sits under the protocol base", () => {
    assert.strictEqual(peerRoutePath(), "/twinny/v1/peers")
    assert.strictEqual(peerRoutePath("/ai"), "/ai/twinny/v1/peers")
    assert.strictEqual(peerLabel("alice", "desktop"), "alice@desktop")
  })

  test("hello is parsed, bounded and deduplicated", () => {
    const frame = parsePeerFrame(
      hello({
        name: "  desk\ntop  ",
        slots: 50,
        models: [
          { id: "a", name: "A" },
          { id: "a", name: "again" },
          { id: 3 },
          { id: "b" }
        ]
      })
    )
    assert.strictEqual(frame.type, "hello")
    if (frame.type !== "hello") return
    assert.strictEqual(frame.name, "desk top")
    assert.strictEqual(frame.slots, MAX_PEER_SLOTS)
    assert.deepStrictEqual(frame.models, [
      { id: "a", name: "A" },
      { id: "b", name: "b" }
    ])
  })

  test("malformed peer frames are refused with a reason", () => {
    const bad: Array<[string, RegExp]> = [
      ["not json", /not JSON/],
      ["{}", /no type/],
      ["{\"type\":\"nope\"}", /Unknown frame type/],
      [hello({ protocol: 2 }), /protocol 2/],
      [hello({ name: "" }), /"name"/],
      [hello({ backend: {} }), /backend\.kind/],
      [hello({ models: "x" }), /"models"/],
      [hello({ slots: 0 }), /"slots"/],
      ["{\"type\":\"chunk\",\"chunk\":{\"text\":\"x\"}}", /job id/],
      ["{\"type\":\"chunk\",\"id\":\"j1\",\"chunk\":{\"nope\":1}}", /neither text nor content/],
      ["{\"type\":\"done\",\"id\":\"j1\",\"response\":{\"vectors\":[[1,\"x\"]]}}", /malformed vector/],
      ["{\"type\":\"error\",\"id\":\"j1\",\"error\":{\"kind\":\"bogus\",\"message\":\"m\"}}", /no error kind/]
    ]
    for (const [text, pattern] of bad) {
      assert.throws(() => parsePeerFrame(text), (e: Error) => e instanceof PeerProtocolError && pattern.test(e.message), text)
    }
  })

  test("chunks, done and error frames keep only the protocol's fields", () => {
    const chunk = parsePeerFrame(JSON.stringify({ type: "chunk", id: "j1", chunk: { text: "hi", usage: { promptTokens: 3, junk: 1 }, extra: true } }))
    assert.deepStrictEqual(chunk, { type: "chunk", id: "j1", chunk: { text: "hi", usage: { promptTokens: 3 } } })
    const done = parsePeerFrame(JSON.stringify({ type: "done", id: "j1", usage: { completionTokens: 2 }, response: { vectors: [[0.1, 0.2]] } }))
    assert.deepStrictEqual(done, { type: "done", id: "j1", usage: { completionTokens: 2 }, response: { vectors: [[0.1, 0.2]] } })
    const error = parsePeerFrame(JSON.stringify({ type: "error", id: "j1", error: { kind: "timeout", message: "m".repeat(1000) } }))
    assert.strictEqual(error.type, "error")
    if (error.type === "error") assert.strictEqual(error.error.message.length, 400)
  })

  test("a job is re-validated in full on the sharer: unknown fields cannot ride along", () => {
    const good = parseGatewayFrame(
      JSON.stringify({ type: "job", id: "j1", capability: "fim", request: { model: "m", prompt: "p", maxTokens: 4 } })
    )
    assert.deepStrictEqual(good, {
      type: "job",
      id: "j1",
      capability: "fim",
      request: { model: "m", prompt: "p", prefix: undefined, suffix: undefined, stop: undefined, maxTokens: 4, temperature: undefined, keepAlive: undefined }
    })
    assert.throws(
      () => parseGatewayFrame(JSON.stringify({ type: "job", id: "j1", capability: "fim", request: { model: "m", prompt: "p", apiHostname: "evil" } })),
      /unknown field "apiHostname"/
    )
    assert.throws(() => parseGatewayFrame(JSON.stringify({ type: "job", id: "j1", capability: "sing", request: {} })), /capability/)
    assert.throws(() => parseGatewayFrame(JSON.stringify({ type: "welcome", protocol: 9 })), /protocol 9/)
    const welcome = parseGatewayFrame(JSON.stringify({ type: "welcome", protocol: 1, wanted: ["a", "a", 3, "b"], slots: 99 }))
    assert.deepStrictEqual(welcome, { type: "welcome", protocol: 1, wanted: ["a", "b"], slots: MAX_PEER_SLOTS })
    assert.deepStrictEqual(parseGatewayFrame(JSON.stringify({ type: "cancel", id: "j2" })), { type: "cancel", id: "j2" })
    assert.deepStrictEqual(parseGatewayFrame(JSON.stringify({ type: "ping" })), { type: "ping" })
  })

  test("what one side encodes, the other parses", () => {
    const text = encodePeerFrame({ type: "pong" })
    assert.deepStrictEqual(parsePeerFrame(text), { type: "pong" })
  })
})

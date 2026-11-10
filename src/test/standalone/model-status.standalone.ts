/**
 * What the chat says about its model before a message is sent: where it
 * runs, whether its server has it loaded, how the draft fits its context,
 * and what the empty chat's first questions send.
 */
import * as assert from "node:assert"
import * as http from "node:http"
import { AddressInfo } from "node:net"
import { test } from "node:test"

import { contextFit, shortTokens } from "../../common/model-status"
import { TwinnyProvider } from "../../common/types"
import { starterRequest } from "../../extension/chat/starter-request"
import { forgetContextWindows } from "../../extension/inference/context-window"
import { modelStatusOf, placeOf, rememberLoad } from "../../extension/inference/model-status"

const provider = (kind: string, extra: Partial<TwinnyProvider> = {}): TwinnyProvider =>
  ({
    id: kind,
    label: kind,
    provider: kind,
    type: "chat",
    modelName: "qwen3-coder:30b",
    apiHostname: "localhost",
    apiProtocol: "http",
    ...extra
  }) as TwinnyProvider

const fakeServer = async (routes: Record<string, unknown>) => {
  const asked: string[] = []
  const server = http.createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`)
    const body = routes[req.url ?? ""]
    res.writeHead(body === undefined ? 404 : 200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(body ?? {}))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    port: (server.address() as AddressInfo).port,
    asked,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test("a provider is placed by where its requests go", () => {
  assert.strictEqual(placeOf(provider("ollama")), "machine")
  assert.strictEqual(placeOf(provider("ollama", { apiHostname: "127.0.0.1" })), "machine")
  assert.strictEqual(placeOf(provider("ollama", { apiHostname: "192.168.1.20" })), "network")
  assert.strictEqual(placeOf(provider("anthropic", { apiHostname: "api.anthropic.com" })), "hosted")
  assert.strictEqual(placeOf(provider("twinny-remote")), "gateway")
  assert.strictEqual(placeOf(provider("twinny-p2p")), "peer")
})

test("Ollama: a running model is loaded, with its context and its share on the GPU", async () => {
  forgetContextWindows()
  const server = await fakeServer({
    "/api/ps": {
      models: [{ name: "qwen3-coder:30b", size: 20_000, size_vram: 15_000, context_length: 32768 }]
    }
  })
  try {
    const status = await modelStatusOf(provider("ollama", { apiHostname: "127.0.0.1", apiPort: server.port }), true)
    assert.deepStrictEqual(status, { place: "machine", loaded: true, contextWindow: 32768, gpuShare: 0.75 })
    assert.ok(server.asked.every((line) => !line.includes("/api/generate")), "asking loads nothing")
  } finally {
    await server.close()
  }
})

test("Ollama: a model that is not running is not loaded, and can be; a load is remembered", async () => {
  forgetContextWindows()
  const server = await fakeServer({ "/api/ps": { models: [{ name: "gemma3:4b", size: 1, size_vram: 1 }] } })
  try {
    const ollama = provider("ollama", { apiHostname: "127.0.0.1", apiPort: server.port })
    assert.deepStrictEqual(await modelStatusOf(ollama, true), { place: "machine", loaded: false, canLoad: true })
    assert.deepStrictEqual(await modelStatusOf(ollama, false), { place: "machine", loaded: false })
    rememberLoad(ollama, 11_400)
    assert.strictEqual((await modelStatusOf(ollama, true)).loadMs, 11_400)
  } finally {
    await server.close()
  }
})

test("a server that does not answer, and a hosted API, say nothing about loading", async () => {
  forgetContextWindows()
  const gone = await modelStatusOf(provider("ollama", { apiHostname: "127.0.0.1", apiPort: 9 }), true)
  assert.deepStrictEqual(gone, { place: "machine" })
  const hosted = await modelStatusOf(provider("anthropic", { apiHostname: "api.anthropic.com" }), false)
  assert.deepStrictEqual(hosted, { place: "hosted" })
})

test("the draft is weighed against the context: room, filling, over", () => {
  assert.strictEqual(contextFit(1000, 0, undefined), undefined)
  assert.deepStrictEqual(contextFit(2000, 350, 8192), { tokens: 2100, share: 2100 / 8192, state: "room" })
  assert.strictEqual(contextFit(6900, 70, 8192)?.state, "filling")
  assert.strictEqual(contextFit(0, 35_000, 8192)?.state, "over")
})

test("token counts are written short", () => {
  assert.deepStrictEqual([900, 8192, 32768, 9100, 131072, 200_000].map(shortTokens), [
    "900",
    "8k",
    "32k",
    "9.1k",
    "128k",
    "200k"
  ])
})

test("a starter names the file, attaches it, and cuts it to half the context", () => {
  const whole = starterRequest("explain", { path: "src/cart.js", text: "export const total = 1\n" }, 8192)
  assert.strictEqual(whole.display, "Explain src/cart.js")
  assert.deepStrictEqual(whole.entry, { path: "src/cart.js", content: "export const total = 1\n" })
  assert.strictEqual(whole.cut, false)

  const picked = starterRequest(
    "bugs",
    { path: "src/cart.js", text: "x", selection: { startLine: 2, endLine: 9 } },
    8192
  )
  assert.strictEqual(picked.display, "Find bugs in src/cart.js (lines 3–10)")
  assert.match(picked.prompt, /do not invent problems/)

  const long = starterRequest("tests", { path: "big.js", text: "a".repeat(100_000) }, 8192)
  assert.strictEqual(long.cut, true)
  assert.ok(long.entry.content.length < 8192 * 0.5 * 3 + 100)
  assert.match(long.entry.content, /does not fit the model's context/)
})

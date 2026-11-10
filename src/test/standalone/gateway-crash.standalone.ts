/**
 * A request whose handler throws is answered and logged; it never takes
 * the process with it. Run with plain Node (`npm run test:sqlite`), where
 * an unhandled rejection would end the process as it does in production.
 *
 * The way in is a keys file that stops being readable while the gateway
 * runs (a hand edit, a disk that filled mid-copy): the next request that
 * presents a key rereads it and the reread throws.
 */
import * as assert from "node:assert"
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { providerRegistry } from "../../extension/inference/registry"
import { parseGatewayConfig, readGatewaySecrets } from "../../gateway/config"
import { KeyStore } from "../../gateway/keys"
import { createGatewayLog } from "../../gateway/log"
import { buildRouteTable } from "../../gateway/routes"
import { GatewayServer, HEALTH_PATH } from "../../gateway/server"
import { REMOTE_PROTOCOL_BASE } from "../../protocol/types"

test("a handler that throws answers 500, is logged, and the gateway keeps serving", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-crash-"))
  const keysFile = path.join(dir, "keys.json")
  // No refresh throttle: every request looks at the file.
  const keys = KeyStore.open(keysFile, 0)
  const { key } = keys.create("alice")
  const good = fs.readFileSync(keysFile, "utf8")
  const config = parseGatewayConfig(
    {
      listen: { host: "127.0.0.1", port: 0 },
      auth: { tokenEnv: null, keysFile, licenseFile: path.join(dir, "license") },
      usage: { dir: path.join(dir, "usage"), retentionDays: 30 },
      providers: { local: { provider: "ollama", apiHostname: "127.0.0.1", apiPort: 9 } },
      models: [{ alias: "coder", provider: "local", model: "m", capabilities: ["fim"] }]
    },
    providerRegistry.providerIds()
  )
  const routes = buildRouteTable(config, readGatewaySecrets(config, {}, 1), providerRegistry)
  const lines: string[] = []
  const server = new GatewayServer({ config, keys, routes, log: createGatewayLog((line) => lines.push(line)) })
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  const { url } = await server.start()
  const models = () =>
    fetch(`${url}${REMOTE_PROTOCOL_BASE}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5_000)
    })
  try {
    assert.strictEqual((await models()).status, 200)

    fs.writeFileSync(keysFile, "{ not json")
    fs.utimesSync(keysFile, new Date(), new Date(Date.now() + 5_000))
    const broken = await models()
    assert.strictEqual(broken.status, 500)
    const body = (await broken.json()) as { error?: { message?: string } }
    assert.ok(body.error?.message)
    // What went wrong is the operator's to read, not the caller's.
    assert.ok(!JSON.stringify(body).includes(keysFile))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepStrictEqual(unhandled, [])
    const crashed = lines.filter((line) => line.includes("event=request.crashed"))
    assert.strictEqual(crashed.length, 1)
    assert.ok(crashed[0].includes("not valid JSON"), crashed[0])

    // Still up, and right again as soon as the file is.
    assert.strictEqual((await fetch(`${url}${HEALTH_PATH}`)).status, 200)
    fs.writeFileSync(keysFile, good)
    fs.utimesSync(keysFile, new Date(), new Date(Date.now() + 10_000))
    assert.strictEqual((await models()).status, 200)
  } finally {
    process.off("unhandledRejection", onUnhandled)
    await server.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const startGateway = async (limits: Record<string, unknown> = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-crash-"))
  const keysFile = path.join(dir, "keys.json")
  const keys = KeyStore.open(keysFile, 0)
  const { key } = keys.create("alice")
  const config = parseGatewayConfig(
    {
      listen: { host: "127.0.0.1", port: 0 },
      auth: { tokenEnv: null, keysFile, licenseFile: path.join(dir, "license") },
      usage: { dir: path.join(dir, "usage"), retentionDays: 30 },
      limits,
      providers: { local: { provider: "ollama", apiHostname: "127.0.0.1", apiPort: 9 } },
      models: [{ alias: "coder", provider: "local", model: "m", capabilities: ["fim", "chat"] }]
    },
    providerRegistry.providerIds()
  )
  const routes = buildRouteTable(config, readGatewaySecrets(config, {}, 1), providerRegistry)
  const lines: string[] = []
  const server = new GatewayServer({ config, keys, routes, log: createGatewayLog((line) => lines.push(line)) })
  const { url } = await server.start()
  return {
    key,
    url,
    lines,
    port: Number(new URL(url).port),
    stop: async () => {
      await server.stop()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

test("a caller who resets the connection while its upgrade is refused does not end the process", async () => {
  const gateway = await startGateway()
  const uncaught: unknown[] = []
  const onUncaught = (error: unknown) => uncaught.push(error)
  process.on("uncaughtException", onUncaught)
  try {
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => {
        const socket: net.Socket = net.connect(gateway.port, "127.0.0.1", () => {
          socket.write("GET /anything HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
          // Gone before the refusal can be written: a reset, not a close.
          setTimeout(() => {
            (socket as unknown as { resetAndDestroy(): void }).resetAndDestroy()
            resolve()
          }, 5)
        })
        socket.on("error", () => undefined)
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepStrictEqual(uncaught, [])
    assert.strictEqual((await fetch(`${gateway.url}${HEALTH_PATH}`)).status, 200)
  } finally {
    process.off("uncaughtException", onUncaught)
    await gateway.stop()
  }
})

test("a request whose body never arrives is ended at the deadline and gives its place back", async () => {
  const gateway = await startGateway({ maxActiveRequests: 1, requestDeadlineMs: 200 })
  try {
    const stalled = await new Promise<string>((resolve, reject) => {
      let text = ""
      const socket: net.Socket = net.connect(gateway.port, "127.0.0.1", () =>
        socket.write(
          `POST ${REMOTE_PROTOCOL_BASE}/chat HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${gateway.key}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n`
        )
      )
      const guard = setTimeout(() => {
        socket.destroy()
        reject(new Error(`still open after 5s; got: ${text}`))
      }, 5_000)
      socket.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")))
      socket.on("error", () => undefined)
      socket.on("close", () => {
        clearTimeout(guard)
        resolve(text)
      })
    })
    assert.match(stalled, /^HTTP\/1\.1 (408|504|503|499|400)/, stalled.slice(0, 80))
    assert.match(stalled, /deadline/)
    // The one place there is has come back: the next request is taken, and fails only for want of a backend.
    const next = await fetch(`${gateway.url}${REMOTE_PROTOCOL_BASE}/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gateway.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "coder", messages: [{ role: "user", content: "hi" }] }),
      signal: AbortSignal.timeout(5_000)
    })
    const body = await next.text()
    assert.ok(!/busy|queue|too many/i.test(body), body.slice(0, 200))
  } finally {
    await gateway.stop()
  }
})

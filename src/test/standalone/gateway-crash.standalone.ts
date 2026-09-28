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

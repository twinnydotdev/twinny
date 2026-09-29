import * as assert from "assert"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { providerRegistry } from "../../extension/inference/registry"
import { parseGatewayConfig } from "../../gateway/config"
import { GatewayConfiguration } from "../../gateway/configuration"
import { buildRouteTable } from "../../gateway/routes"

suite("Gateway configuration persistence", () => {
  test("a failed atomic write preserves the old file, revision and routing table", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-config-store-"))
    const file = path.join(dir, "config.json")
    const raw = { auth: { tokenEnv: null }, providers: { local: { provider: "ollama" } }, models: [{ alias: "chat", provider: "local", model: "old-model", capabilities: ["chat"] }] }
    const text = JSON.stringify(raw)
    fs.writeFileSync(file, text, { mode: 0o600 })
    const config = parseGatewayConfig(raw, providerRegistry.providerIds())
    const routes = buildRouteTable(config, { providerKeys: {} }, providerRegistry)
    const store = new GatewayConfiguration(file, config, routes, {})
    const before = store.snapshot()
    const rename = fs.renameSync
    try {
      fs.renameSync = () => { throw new Error("Simulated disk write failure") }
      assert.throws(() => store.save({ revision: before.revision, providers: before.providers, models: [{ ...before.models[0], model: "new-model" }] }, 1), /disk write failure/)
      assert.strictEqual(fs.readFileSync(file, "utf8"), text)
      assert.strictEqual(store.snapshot().revision, before.revision)
      assert.strictEqual(store.routes, routes)
      assert.deepStrictEqual(fs.readdirSync(dir), ["config.json"])
    } finally {
      fs.renameSync = rename
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

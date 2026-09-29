/**
 * The audit log's chain, the read-only admin, and the metrics endpoint.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as http from "http"
import * as os from "os"
import * as path from "path"

import { providerRegistry } from "../../extension/inference/registry"
import { AuditLog } from "../../gateway/audit"
import { parseGatewayConfig, readGatewaySecrets } from "../../gateway/config"
import { KeyStore } from "../../gateway/keys"
import { LicenseStore } from "../../gateway/license"
import { createGatewayLog } from "../../gateway/log"
import { GatewayMetrics } from "../../gateway/metrics"
import { BUNDLED_PLUGINS, PluginHost, pluginsFileFor, PluginStore } from "../../gateway/plugins"
import { buildRouteTable } from "../../gateway/routes"
import { GatewayServer } from "../../gateway/server"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-audit-test-"))

const request = (target: string, method: string, token: string | undefined, body?: unknown): Promise<{ status: number; body: Record<string, unknown>; text: string; type: string }> =>
  new Promise((resolve, reject) => {
    const url = new URL(target)
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" } },
      (res) => {
        let text = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => (text += chunk))
        res.on("end", () => {
          let parsed: Record<string, unknown> = {}
          try {
            parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}
          } catch {
            // Not JSON.
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, text, type: String(res.headers["content-type"] ?? "") })
        })
      }
    )
    req.on("error", reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })

suite("Audit log", () => {
  test("lines chain by hash, queries filter, and an edit or a removal is found", () => {
    let clock = Date.parse("2026-09-20T10:00:00Z")
    const dir = path.join(scratch, "chain")
    const log = AuditLog.open(dir, () => clock)
    log.record({ action: "key.created", actor: "op", target: "alice", details: { admin: false } })
    clock += 1000
    log.record({ action: "key.revoked", actor: "op", target: "alice" })
    clock += 1000
    log.record({ action: "plugin.enabled", actor: "eve", target: "github", from: "10.0.0.5" })
    assert.deepStrictEqual(log.verify(), { ok: true, entries: 3 })
    // A new process continues the chain from the file.
    const again = AuditLog.open(dir, () => clock + 1000)
    again.record({ action: "license.installed", actor: "op" })
    assert.deepStrictEqual(again.verify(), { ok: true, entries: 4 })
    assert.deepStrictEqual(
      again.query().map((entry) => `${entry.actor}:${entry.action}`),
      ["op:license.installed", "eve:plugin.enabled", "op:key.revoked", "op:key.created"]
    )
    assert.strictEqual(again.query({ actor: "eve" }).length, 1)
    assert.strictEqual(again.query({ action: "key." }).length, 2)
    assert.strictEqual(again.query({ since: new Date(clock) }).length, 2)
    assert.strictEqual(fs.statSync(path.join(dir, "2026-09.jsonl")).mode & 0o777, 0o600)

    // Someone edits the second line: the third no longer matches.
    const file = path.join(dir, "2026-09.jsonl")
    const lines = fs.readFileSync(file, "utf8").split("\n")
    lines[1] = lines[1].replace("alice", "mallory")
    fs.writeFileSync(file, lines.join("\n"))
    const edited = AuditLog.open(dir).verify()
    assert.strictEqual(edited.ok, false)
    assert.deepStrictEqual(edited.brokenAt, { file: "2026-09.jsonl", line: 3, reason: "the previous line was changed or removed" })
    // Someone removes the first line: the (new) first line's prev is not genesis.
    fs.writeFileSync(file, `${lines.slice(1).join("\n")}`)
    assert.strictEqual(AuditLog.open(dir).verify().brokenAt?.line, 1)
  })
})

suite("Metrics", () => {
  test("renders the Prometheus text format from what the gateway reports", () => {
    const metrics = new GatewayMetrics()
    metrics.request({ key: "alice", route: "chat", alias: "coder", outcome: "ok", status: 200, ms: 1200, chunks: 40, promptTokens: 300, completionTokens: 80 })
    metrics.request({ key: "bob", route: "fim", alias: "coder", outcome: "cancelled", status: 499, ms: 30 })
    metrics.active(2)
    metrics.backend("local", true, 0.02)
    metrics.backend("hosted", false, 5)
    metrics.authRejected()
    metrics.plan(4, 5)
    metrics.pluginEvent("review.done")
    const text = metrics.render("9.9.9")
    assert.match(text, /twinny_info\{version="9\.9\.9"\} 1/)
    assert.match(text, /twinny_requests_total\{alias="coder",outcome="ok",route="chat"\} 1/)
    assert.match(text, /twinny_requests_total\{alias="coder",outcome="cancelled",route="fim"\} 1/)
    assert.match(text, /twinny_request_duration_seconds_bucket\{route="chat",le="2\.5"\} 1/)
    assert.match(text, /twinny_request_duration_seconds_bucket\{route="chat",le="1"\} 0/)
    assert.match(text, /twinny_tokens_total\{alias="coder",direction="completion"\} 80/)
    assert.match(text, /twinny_chunks_total\{route="chat"\} 40/)
    assert.match(text, /twinny_active_requests 2/)
    assert.match(text, /twinny_backend_up\{provider="hosted"\} 0/)
    assert.match(text, /twinny_backend_up\{provider="local"\} 1/)
    assert.match(text, /twinny_auth_rejected_total 1/)
    assert.match(text, /twinny_keys_active 4\n/)
    assert.match(text, /twinny_plugin_events_total\{type="review.done"\} 1/)
  })
})

suite("Read-only admins, audit routes and /metrics (in process)", function () {
  this.timeout(20_000)
  let server: GatewayServer
  let plugins: PluginHost
  let url: string
  let admin: string
  let viewer: string
  let dev: string
  const dir = path.join(scratch, "server")

  suiteSetup(async () => {
    const config = parseGatewayConfig(
      {
        listen: { host: "127.0.0.1", port: 0 },
        auth: { tokenEnv: null, keysFile: path.join(dir, "keys.json"), licenseFile: path.join(dir, "license") },
        usage: { dir: path.join(dir, "usage") },
        providers: { local: { provider: "ollama", apiHostname: "127.0.0.1", apiPort: 1 } },
        models: [{ alias: "coder", provider: "local", model: "x", capabilities: ["chat"] }]
      },
      providerRegistry.providerIds()
    )
    const keys = KeyStore.open(config.auth.keysFile, 0)
    const license = LicenseStore.open(config.auth.licenseFile, [], 0)
    const log = createGatewayLog(() => undefined)
    plugins = new PluginHost({ plugins: BUNDLED_PLUGINS, store: PluginStore.open(pluginsFileFor(config.auth.keysFile)), dataDir: dir, log })
    server = new GatewayServer({
      config,
      keys,
      license,
      routes: buildRouteTable(config, readGatewaySecrets(config, {}, 1), providerRegistry),
      log,
      plugins,
      audit: AuditLog.open(path.join(dir, "audit")),
      metrics: new GatewayMetrics(),
      version: "test"
    })
    admin = keys.create("operator", { admin: true }).key
    viewer = keys.create("auditor", { admin: true, readOnly: true }).key
    dev = keys.create("alice").key
    url = (await server.start()).url
  })

  suiteTeardown(async () => {
    await plugins.stop()
    await server.stop()
  })

  test("a read-only admin reads everything and changes nothing; admin actions land in the audit log", async () => {
    // The admin makes a key; the viewer cannot.
    const made = await request(`${url}/twinny/v1/admin/keys`, "POST", admin, { name: "bob", admin: true, readOnly: true })
    assert.strictEqual(made.status, 201)
    assert.strictEqual((made.body.record as { readOnly?: boolean }).readOnly, true)
    const refused = await request(`${url}/twinny/v1/admin/keys`, "POST", viewer, { name: "carol" })
    assert.strictEqual(refused.status, 403)
    assert.match(String((refused.body.error as { message: string }).message), /read-only/)
    const listing = await request(`${url}/twinny/v1/admin/keys`, "GET", viewer)
    assert.strictEqual(listing.status, 200)
    assert.ok((listing.body.keys as Array<{ name: string; readOnly?: boolean }>).some((k) => k.name === "auditor" && k.readOnly))
    // Plugin switches count as writes too.
    assert.strictEqual((await request(`${url}/twinny/v1/admin/plugins/github/enable`, "POST", viewer)).status, 403)

    const audit = await request(`${url}/twinny/v1/admin/audit`, "GET", viewer)
    assert.strictEqual(audit.status, 200)
    const entries = audit.body.entries as Array<{ actor: string; action: string; target?: string; details?: Record<string, unknown> }>
    assert.deepStrictEqual(entries[0], { ...entries[0], actor: "operator", action: "key.created", target: "bob" })
    assert.deepStrictEqual(entries[0].details, { admin: true, readOnly: true })
    assert.strictEqual((audit.body.verification as { ok: boolean }).ok, true)
    assert.strictEqual((await request(`${url}/twinny/v1/admin/audit`, "GET", dev)).status, 403)

    const exported = await request(`${url}/twinny/v1/admin/audit/export`, "GET", admin)
    assert.strictEqual(exported.status, 200)
    assert.match(exported.type, /x-ndjson/)
    assert.ok(exported.text.includes("\"action\":\"key.created\""))
  })

  test("/metrics answers admins in the Prometheus text format and refuses others", async () => {
    const ok = await request(`${url}/metrics`, "GET", viewer)
    assert.strictEqual(ok.status, 200)
    assert.match(ok.type, /text\/plain; version=0\.0\.4/)
    assert.match(ok.text, /twinny_info\{version="test"\} 1/)
    assert.match(ok.text, /twinny_keys_active 4/)
    assert.strictEqual((await request(`${url}/metrics`, "GET", dev)).status, 401)
    assert.strictEqual((await request(`${url}/metrics`, "GET", undefined)).status, 401)
  })
})

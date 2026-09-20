/**
 * Quotas, routing rules and the prompt library: parsed from the
 * configuration, enforced by the gateway with the policy licence, sent
 * to extensions only where they belong.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as http from "http"
import * as os from "os"
import * as path from "path"

import { providerRegistry } from "../../extension/inference/registry"
import { parseGatewayConfig, policyForExtensions, readGatewaySecrets } from "../../gateway/config"
import { KeyStore } from "../../gateway/keys"
import { LicenseStore } from "../../gateway/license"
import { createGatewayLog } from "../../gateway/log"
import { globMatch, QuotaMeter, refuseByRouting } from "../../gateway/quotas"
import { buildRouteTable } from "../../gateway/routes"
import { GatewayServer } from "../../gateway/server"

import { generateSigningKeys, issueLicense } from "./support/sign-license"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-policy-test-"))

const request = (target: string, method: string, token: string | undefined, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown>; text: string }> =>
  new Promise((resolve, reject) => {
    const url = new URL(target)
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", ...headers } },
      (res) => {
        let text = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => (text += chunk))
        res.on("end", () => {
          let parsed: Record<string, unknown> = {}
          try {
            parsed = text ? (JSON.parse(text.split("\n")[0]) as Record<string, unknown>) : {}
          } catch {
            // NDJSON or nothing.
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, text })
        })
      }
    )
    req.on("error", reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })

suite("Quota meter", () => {
  test("counts per key per UTC day, warns once, refuses at the cap, and rolls over at midnight", () => {
    let clock = Date.parse("2026-09-20T23:59:00Z")
    const meter = new QuotaMeter({ default: { requestsPerDay: 4 }, keys: { alice: { tokensPerDay: 1000 } }, warnAt: 0.5 }, () => clock, () => ({ bob: { requests: 2, tokens: 0 } }))
    assert.strictEqual(meter.refuse("bob"), undefined)
    // Seeded with two of four: the third crosses the 50% warning share.
    const warned = meter.count("bob", 0)
    assert.match(warned.warning ?? "", /bob has used 75% of today's quota/)
    meter.count("bob", 0)
    assert.match(meter.refuse("bob") ?? "", /Daily quota reached: 4 requests/)
    assert.strictEqual(meter.count("bob", 0).warning, undefined, "warned once")
    // alice has her own quota: tokens, not requests.
    for (let i = 0; i < 10; i++) meter.count("alice", 90)
    assert.strictEqual(meter.refuse("alice"), undefined)
    meter.count("alice", 100)
    assert.match(meter.refuse("alice") ?? "", /1,000 tokens/)
    assert.strictEqual(meter.standing("alice").exhausted, "tokens")
    assert.deepStrictEqual(Object.keys(meter.standings(["carol"])).sort(), ["alice", "bob", "carol"])
    // Midnight: everything resets.
    clock = Date.parse("2026-09-21T00:00:01Z")
    assert.strictEqual(meter.refuse("bob"), undefined)
    assert.strictEqual(meter.standing("alice").tokens, 0)
    meter.update(undefined)
    assert.strictEqual(meter.refuse("bob"), undefined)
  })

  test("globs and routing rules", () => {
    assert.ok(globMatch("payments-*", "Payments-Api"))
    assert.ok(!globMatch("payments-*", "billing"))
    assert.ok(globMatch("*", "anything"))
    const rules = [
      { workspace: "secret-*", localOnly: true },
      { workspace: "docs", aliases: ["cheap"] }
    ]
    assert.match(refuseByRouting(rules, "secret-sauce", "gpt", true) ?? "", /own machines/)
    assert.strictEqual(refuseByRouting(rules, "secret-sauce", "coder", false), undefined)
    assert.match(refuseByRouting(rules, "docs", "coder", false) ?? "", /may only use "cheap"/)
    assert.strictEqual(refuseByRouting(rules, "docs", "cheap", true), undefined)
    assert.strictEqual(refuseByRouting(rules, "other", "gpt", true), undefined)
    assert.strictEqual(refuseByRouting(rules, undefined, "gpt", true), undefined, "no workspace, no rule")
  })
})

suite("Policy configuration", () => {
  const base = {
    listen: { host: "127.0.0.1", port: 0 },
    auth: { tokenEnv: null, keysFile: path.join(scratch, "cfg", "keys.json"), licenseFile: path.join(scratch, "cfg", "license") },
    usage: { dir: path.join(scratch, "cfg", "usage") },
    providers: { local: { provider: "ollama", apiHostname: "127.0.0.1", apiPort: 1 } },
    models: [{ alias: "coder", provider: "local", model: "x", capabilities: ["chat"] }]
  }

  test("parses templates, quotas and routing, and keeps gateway-only parts from extensions", () => {
    const config = parseGatewayConfig(
      {
        ...base,
        policy: {
          teamOnly: true,
          systemPrompt: "Be terse.",
          templates: [{ name: "sec-review", description: "Security pass", prompt: "Review {{code}} for security." }],
          quotas: { default: { requestsPerDay: 500 }, keys: { alice: { tokensPerDay: 20000 } }, warnAt: 0.9 },
          routing: [{ workspace: "secret-*", localOnly: true }, { workspace: "docs", aliases: ["coder"] }]
        }
      },
      providerRegistry.providerIds()
    )
    assert.deepStrictEqual(config.policy?.quotas, { default: { requestsPerDay: 500 }, keys: { alice: { tokensPerDay: 20000 } }, warnAt: 0.9 })
    assert.strictEqual(config.policy?.routing?.length, 2)
    assert.deepStrictEqual(policyForExtensions(config.policy), {
      teamOnly: true,
      systemPrompt: "Be terse.",
      templates: [{ name: "sec-review", description: "Security pass", prompt: "Review {{code}} for security." }]
    })
    assert.strictEqual(policyForExtensions({ quotas: { default: { requestsPerDay: 1 } } }), undefined)
  })

  test("refuses what would do nothing or point nowhere", () => {
    const problems = (policy: unknown): string[] => {
      try {
        parseGatewayConfig({ ...base, policy }, providerRegistry.providerIds())
        return []
      } catch (error) {
        return (error as { problems?: string[] }).problems ?? [String(error)]
      }
    }
    assert.ok(problems({ routing: [{ workspace: "x" }] }).some((p) => /must set localOnly or aliases/.test(p)))
    assert.ok(problems({ routing: [{ workspace: "x", aliases: ["nope"] }] }).some((p) => /not a configured alias/.test(p)))
    assert.ok(problems({ quotas: { default: { requestsPerDay: 0 } } }).some((p) => /at least 1/.test(p)))
    assert.ok(problems({ templates: [{ name: "bad name!", prompt: "x" }] }).some((p) => /may use letters/.test(p)))
    assert.ok(problems({ templates: [{ name: "a", prompt: "x" }, { name: "A", prompt: "y" }] }).some((p) => /twice/.test(p)))
  })
})

suite("Policy enforced by the gateway (in process)", function () {
  this.timeout(20_000)
  let server: GatewayServer
  let url: string
  let alice: string
  let admin: string
  let backend: http.Server
  let backendUrl: string
  let backendHits = 0

  suiteSetup(async () => {
    // A stand-in OpenAI-compatible backend, so a request can complete and be counted.
    backend = http.createServer((req, res) => {
      backendHits++
      if (req.url === "/v1/models" || req.url === "/api/tags") {
        res.writeHead(200, { "Content-Type": "application/json" })
        return res.end(JSON.stringify({ data: [{ id: "x" }], models: [{ name: "x" }] }))
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }], usage: { prompt_tokens: 60, completion_tokens: 40 } })}\n\n`)
      res.write("data: [DONE]\n\n")
      res.end()
      return undefined
    })
    backendUrl = await new Promise<string>((resolve) => backend.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(backend.address() as { port: number }).port}`)))
    const port = Number(new URL(backendUrl).port)
    const dir = path.join(scratch, "server")
    const signing = generateSigningKeys()
    const config = parseGatewayConfig(
      {
        listen: { host: "127.0.0.1", port: 0 },
        auth: { tokenEnv: null, keysFile: path.join(dir, "keys.json"), licenseFile: path.join(dir, "license") },
        usage: { dir: path.join(dir, "usage") },
        providers: {
          local: { provider: "ollama", apiHostname: "127.0.0.1", apiPort: port },
          cloud: { provider: "openai", apiHostname: "127.0.0.1", apiPort: port, apiKeyEnv: "CLOUD_KEY" }
        },
        models: [
          { alias: "coder", provider: "local", model: "x", capabilities: ["chat"] },
          { alias: "gpt", provider: "cloud", model: "x", capabilities: ["chat"] }
        ],
        policy: {
          systemPrompt: "Team says hi.",
          quotas: { default: { requestsPerDay: 2 }, warnAt: 0.5 },
          routing: [{ workspace: "secret-*", localOnly: true }]
        }
      },
      providerRegistry.providerIds()
    )
    const keys = KeyStore.open(config.auth.keysFile, 0)
    const license = LicenseStore.open(config.auth.licenseFile, [signing.publicKeyRaw], 0)
    license.install(issueLicense({ org: "Acme", seats: 10, features: ["policy"] }, signing.privateKeyPem).token)
    const log = createGatewayLog(() => undefined)
    server = new GatewayServer({
      config,
      keys,
      license,
      routes: buildRouteTable(config, readGatewaySecrets(config, { CLOUD_KEY: "sk-test" }, 1), providerRegistry),
      log,
      quotas: new QuotaMeter(config.policy?.quotas)
    })
    alice = keys.create("alice").key
    admin = keys.create("operator", { admin: true }).key
    url = (await server.start()).url
  })

  suiteTeardown(async () => {
    await server.stop()
    backend.close()
  })

  test("routing rules keep a workspace off hosted models; the team payload carries the prompt but not the rules", async () => {
    const team = await request(`${url}/twinny/v1/team`, "GET", alice)
    assert.strictEqual(team.status, 200)
    const policy = team.body.policy as Record<string, unknown>
    assert.strictEqual(policy.systemPrompt, "Team says hi.")
    assert.strictEqual(policy.quotas, undefined)
    assert.strictEqual(policy.routing, undefined)

    const refused = await request(`${url}/twinny/v1/chat`, "POST", alice, { model: "gpt", messages: [{ role: "user", content: "x" }] }, { "X-Twinny-Workspace": "secret-sauce" })
    assert.strictEqual(refused.status, 401)
    assert.match(refused.text, /own machines/)
    const local = await request(`${url}/twinny/v1/chat`, "POST", alice, { model: "coder", messages: [{ role: "user", content: "x" }] }, { "X-Twinny-Workspace": "secret-sauce" })
    assert.strictEqual(local.status, 200, local.text)
    // Another workspace matches no rule and may use any alias; the local one answers here.
    const other = await request(`${url}/twinny/v1/chat`, "POST", alice, { model: "coder", messages: [{ role: "user", content: "x" }] }, { "X-Twinny-Workspace": "blog" })
    assert.strictEqual(other.status, 200, other.text)
  })

  test("quotas count finished requests, show standings, and refuse at the cap without touching a backend", async () => {
    const before = backendHits
    // Two requests already happened above for alice; the cap is 2.
    const standings = await request(`${url}/twinny/v1/admin/quotas`, "GET", admin)
    assert.strictEqual(standings.status, 200)
    assert.strictEqual(standings.body.enforced, true)
    const alices = (standings.body.standings as Record<string, { requests: number; tokens: number; exhausted?: string; share?: number }>).alice
    assert.strictEqual(alices.requests, 2)
    assert.strictEqual(alices.tokens, 200)
    assert.strictEqual(alices.exhausted, "requests")
    const refused = await request(`${url}/twinny/v1/chat`, "POST", alice, { model: "coder", messages: [{ role: "user", content: "x" }] })
    assert.strictEqual(refused.status, 429)
    assert.match(refused.text, /Daily quota reached: 2 requests/)
    assert.strictEqual(backendHits, before, "refused before the backend saw it")
  })
})

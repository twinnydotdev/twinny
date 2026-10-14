/**
 * Routing rules and the team system prompt: parsed from the
 * configuration, enforced by the gateway with the policy licence, sent
 * to extensions only where they belong.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as http from "http"
import * as os from "os"
import * as path from "path"

import { providerRegistry } from "../../extension/inference/registry"
import { AGENT_PROMPT_MARKER } from "../../extension/tools/protocol"
import { OUTDATED_AGENT_CLIENT } from "../../gateway/agent-rules"
import { parseGatewayConfig, policyForExtensions, readGatewaySecrets } from "../../gateway/config"
import { KeyStore } from "../../gateway/keys"
import { LicenseStore } from "../../gateway/license"
import { createGatewayLog } from "../../gateway/log"
import { buildRouteTable } from "../../gateway/routes"
import { globMatch, refuseByRouting } from "../../gateway/routing"
import { GatewayServer } from "../../gateway/server"
import { AGENT_RULES_HEADER } from "../../protocol/types"
import { parseTeam } from "../../protocol/wire"

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

suite("Routing rules", () => {
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

  test("parses the system prompt and routing, and keeps routing from extensions", () => {
    const config = parseGatewayConfig(
      {
        ...base,
        policy: {
          teamOnly: true,
          systemPrompt: "Be terse.",
          routing: [{ workspace: "secret-*", localOnly: true }, { workspace: "docs", aliases: ["coder"] }]
        }
      },
      providerRegistry.providerIds()
    )
    assert.strictEqual(config.policy?.routing?.length, 2)
    assert.deepStrictEqual(policyForExtensions(config.policy), { teamOnly: true, systemPrompt: "Be terse." })
    assert.strictEqual(policyForExtensions({ routing: [{ workspace: "x", localOnly: true }] }), undefined)
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
    assert.ok(problems({ quotas: { default: { requestsPerDay: 1 } } }).some((p) => /quotas/.test(p)), "unknown key is named")
  })

  test("agent rules are parsed, tidied and sent to extensions", () => {
    const config = parseGatewayConfig(
      {
        ...base,
        policy: { agent: { commands: "ask", edits: "review", mcp: "off", blockedPaths: [" .env* ", "", "infra/", "infra/"], off: false } }
      },
      providerRegistry.providerIds()
    )
    assert.deepStrictEqual(config.policy?.agent, { commands: "ask", edits: "review", mcp: "off", blockedPaths: [".env*", "infra/"] })
    assert.deepStrictEqual(policyForExtensions(config.policy), { agent: config.policy?.agent })
    const empty = parseGatewayConfig({ ...base, policy: { agent: { off: false, blockedPaths: [" "] } } }, providerRegistry.providerIds())
    assert.strictEqual(empty.policy, undefined, "rules that tighten nothing are left out")
  })

  test("agent rules that are not rules are refused by name", () => {
    const problems = (agent: unknown): string[] => {
      try {
        parseGatewayConfig({ ...base, policy: { agent } }, providerRegistry.providerIds())
        return []
      } catch (error) {
        return (error as { problems?: string[] }).problems ?? [String(error)]
      }
    }
    assert.ok(problems("off").some((p) => /policy\.agent must be an object/.test(p)))
    assert.ok(problems({ off: "yes" }).some((p) => /policy\.agent\.off must be true or false/.test(p)))
    assert.ok(problems({ commands: "allow" }).some((p) => /policy\.agent\.commands must be one of ask, off/.test(p)))
    assert.ok(problems({ edits: "apply" }).some((p) => /policy\.agent\.edits must be review/.test(p)))
    assert.ok(problems({ mcp: "on" }).some((p) => /policy\.agent\.mcp must be off/.test(p)))
    assert.ok(problems({ blockedPaths: ".env" }).some((p) => /blockedPaths must be a list/.test(p)))
    assert.ok(problems({ blockedPaths: Array.from({ length: 201 }, (_, i) => `p${i}`) }).some((p) => /more than 200/.test(p)))
    assert.ok(problems({ tools: [] }).some((p) => /policy\.agent/.test(p) && /tools/.test(p)), "an unknown rule is named")
  })
})

suite("Policy enforced by the gateway (in process)", function () {
  this.timeout(20_000)
  let server: GatewayServer
  let url: string
  let alice: string
  let backend: http.Server
  let backendUrl: string

  suiteSetup(async () => {
    // A stand-in OpenAI-compatible backend, so a request can complete.
    backend = http.createServer((req, res) => {
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
          routing: [{ workspace: "secret-*", localOnly: true }],
          agent: { commands: "off", blockedPaths: ["secrets/"] }
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
      log
    })
    alice = keys.create("alice").key
    url = (await server.start()).url
  })

  suiteTeardown(async () => {
    await server.stop()
    backend.close()
  })

  test("with agent rules set, an agent request from an extension that does not follow them is refused, and others pass", async () => {
    const chat = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      request(`${url}/twinny/v1/chat`, "POST", alice, { model: "coder", messages: [{ role: "user", content: "x" }], ...body }, headers)
    const tools = [{ name: "read_file", description: "Reads.", parameters: { type: "object", properties: {} } }]

    const native = await chat({ tools })
    assert.strictEqual(native.status, 403, native.text)
    assert.strictEqual((native.body.error as { message: string }).message, OUTDATED_AGENT_CLIENT)
    assert.doesNotMatch(OUTDATED_AGENT_CLIENT, /\btools?\b|function.?call/i, "an old agent reading it does not fall back to text calls")
    const textMode = await chat({
      messages: [
        { role: "system", content: `You are twinny.\n\n${AGENT_PROMPT_MARKER} tools. To use one, write…` },
        { role: "user", content: "x" }
      ]
    })
    assert.strictEqual(textMode.status, 403, "an agent writing its calls as text is an agent too")
    const answered = await chat({
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "a" }
      ]
    })
    assert.strictEqual(answered.status, 403)

    assert.strictEqual((await chat({ tools }, { [AGENT_RULES_HEADER]: "1" })).status, 200, "an extension that follows them is served")
    assert.strictEqual((await chat({})).status, 200, "a plain chat is served from any client")
  })

  test("routing rules keep a workspace off hosted models; the team payload carries the prompt but not the rules", async () => {
    const team = await request(`${url}/twinny/v1/team`, "GET", alice)
    assert.strictEqual(team.status, 200)
    const policy = team.body.policy as Record<string, unknown>
    assert.strictEqual(policy.systemPrompt, "Team says hi.")
    assert.strictEqual(policy.routing, undefined)
    assert.deepStrictEqual(policy.agent, { commands: "off", blockedPaths: ["secrets/"] })
    assert.deepStrictEqual(parseTeam(team.body).policy?.agent, { commands: "off", blockedPaths: ["secrets/"] }, "and the extension reads them back")

    const refused = await request(`${url}/twinny/v1/chat`, "POST", alice, { model: "gpt", messages: [{ role: "user", content: "x" }] }, { "X-Twinny-Workspace": "secret-sauce" })
    assert.strictEqual(refused.status, 401)
    assert.match(refused.text, /own machines/)
    const local = await request(`${url}/twinny/v1/chat`, "POST", alice, { model: "coder", messages: [{ role: "user", content: "x" }] }, { "X-Twinny-Workspace": "secret-sauce" })
    assert.strictEqual(local.status, 200, local.text)
    // Another workspace matches no rule and may use any alias; the local one answers here.
    const other = await request(`${url}/twinny/v1/chat`, "POST", alice, { model: "coder", messages: [{ role: "user", content: "x" }] }, { "X-Twinny-Workspace": "blog" })
    assert.strictEqual(other.status, 200, other.text)
  })
})

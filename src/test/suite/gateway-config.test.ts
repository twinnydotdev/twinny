/**
 * The gateway configuration: what it accepts, what it refuses, and how
 * the route table refuses a job the chosen adapter cannot do.
 */
import * as assert from "assert"

import { providerRegistry } from "../../extension/inference"
import { ProviderRegistry } from "../../extension/inference/registry"
import {
  DEFAULT_LIMITS,
  GatewayConfigError,
  parseGatewayConfig,
  policyForExtensions,
  providerForRoute,
  readGatewaySecrets
} from "../../gateway/config"
import { buildRouteTable, shieldsBackend } from "../../gateway/routes"

const KNOWN = providerRegistry.providerIds()

const valid = () => ({
  listen: { host: "127.0.0.1", port: 8765 },
  auth: { tokenEnv: "TWINNY_GATEWAY_TOKEN" },
  providers: {
    local: { provider: "ollama", apiHostname: "127.0.0.1", apiPort: 11434 }
  },
  models: [
    { alias: "coder", provider: "local", model: "qwen2.5-coder:7b", capabilities: ["fim", "chat"] },
    { alias: "embed", provider: "local", model: "nomic-embed-text", capabilities: ["embeddings"] }
  ]
})

const problemsOf = (input: unknown): { code: string; problems: string[] } => {
  try {
    parseGatewayConfig(input, KNOWN)
  } catch (error) {
    assert.ok(error instanceof GatewayConfigError, String(error))
    return { code: error.code, problems: error.problems }
  }
  assert.fail("expected the configuration to be refused")
}

suite("Gateway configuration", () => {
  test("a minimal file gets the documented defaults", () => {
    const config = parseGatewayConfig(
      { providers: valid().providers, models: valid().models },
      KNOWN
    )
    assert.deepStrictEqual(config.listen, { host: "127.0.0.1", port: 8765 })
    assert.strictEqual(config.auth.tokenEnv, "TWINNY_GATEWAY_TOKEN")
    assert.deepStrictEqual(config.limits, DEFAULT_LIMITS)
  })

  test("routes take the adapter's usual path unless one is configured", () => {
    const config = parseGatewayConfig(valid(), KNOWN)
    const fim = providerForRoute(config, config.models[0], "fim", undefined)
    assert.strictEqual(fim.apiPath, "/api/generate")
    assert.strictEqual(fim.type, "fim")
    assert.strictEqual(fim.modelName, "qwen2.5-coder:7b")
    const chat = providerForRoute(config, config.models[0], "chat", undefined)
    assert.strictEqual(chat.apiPath, "/v1")
    const custom = parseGatewayConfig(
      {
        ...valid(),
        providers: { local: { provider: "ollama", paths: { fim: "/custom/generate" } } }
      },
      KNOWN
    )
    const route = providerForRoute(custom, custom.models[0], "fim", "k")
    assert.strictEqual(route.apiPath, "/custom/generate")
    assert.strictEqual(route.apiHostname, "localhost")
    assert.strictEqual(route.apiKey, "k")
  })

  test("duplicate aliases are refused, case-insensitively", () => {
    const input = valid()
    input.models.push({ alias: "CODER", provider: "local", model: "x", capabilities: ["chat"] })
    const { code, problems } = problemsOf(input)
    assert.strictEqual(code, "invalid-config")
    assert.ok(problems.some((p) => /"CODER" is already used/.test(p)), problems.join("\n"))
  })

  test("an alias must reference a configured provider", () => {
    const input = valid()
    input.models[0].provider = "elsewhere"
    const { problems } = problemsOf(input)
    assert.ok(problems.some((p) => /"elsewhere" is not in providers/.test(p)), problems.join("\n"))
  })

  test("invalid limits and unknown fields are named", () => {
    const { problems } = problemsOf({
      ...valid(),
      limits: { maxActiveRequests: 0, requestDeadlineMs: "soon", extra: 1 }
    })
    assert.ok(problems.some((p) => /limits.maxActiveRequests/.test(p)))
    assert.ok(problems.some((p) => /limits.requestDeadlineMs/.test(p)))
    assert.ok(problems.some((p) => /unknown field "extra"/.test(p)))
  })

  test("limits.queue is validated and defaults field by field", () => {
    const parsed = parseGatewayConfig({ ...valid(), limits: { queue: { fimWaitMs: 0 } } }, KNOWN)
    assert.deepStrictEqual(parsed.limits.queue, { maxWaiting: 8, fimWaitMs: 0, chatWaitMs: 15_000 })
    const { problems } = problemsOf({ ...valid(), limits: { queue: { maxWaiting: -1, chatWaitMs: "long", extra: true } } })
    assert.ok(problems.some((p) => /limits.queue.maxWaiting/.test(p)))
    assert.ok(problems.some((p) => /limits.queue.chatWaitMs/.test(p)))
    assert.ok(problems.some((p) => /limits.queue: unknown field "extra"/.test(p)))
  })

  test("capabilities must be real and non-empty", () => {
    const input = valid()
    input.models[0].capabilities = ["fim", "search"]
    const { problems } = problemsOf(input)
    assert.ok(problems.some((p) => /"search" is not one of/.test(p)))
    input.models[0].capabilities = []
    assert.ok(problemsOf(input).problems.some((p) => /at least one of/.test(p)))
  })

  test("a provider kind the gateway cannot serve is its own failure", () => {
    const input = valid()
    input.providers.local.provider = "twinny-p2p"
    assert.strictEqual(problemsOf(input).code, "unsupported-provider")
    input.providers.local.provider = "hal9000"
    const { code, problems } = problemsOf(input)
    assert.strictEqual(code, "unsupported-provider")
    assert.ok(problems.some((p) => /Known kinds:/.test(p)))
  })

  test("a route the provider validation rejects is a configuration error", () => {
    const input = valid()
    input.providers.local = { provider: "ollama", apiHostname: "not a host", apiPort: 11434 }
    const { problems } = problemsOf(input)
    assert.ok(problems.some((p) => /coder.*fim.*apiHostname/.test(p)), problems.join("\n"))
  })

  test("secrets come from the named environment variables only", () => {
    const config = parseGatewayConfig(
      {
        ...valid(),
        providers: {
          local: { provider: "ollama", apiHostname: "127.0.0.1", apiPort: 11434, apiKeyEnv: "LOCAL_KEY" }
        }
      },
      KNOWN
    )
    assert.throws(
      () => readGatewaySecrets(config, {}),
      (error: unknown) =>
        error instanceof GatewayConfigError &&
        error.code === "missing-env" &&
        error.problems.some((p) => /TWINNY_GATEWAY_TOKEN/.test(p)) &&
        error.problems.some((p) => /LOCAL_KEY/.test(p))
    )
    assert.throws(
      () => readGatewaySecrets(config, { TWINNY_GATEWAY_TOKEN: "   ", LOCAL_KEY: "k" }),
      /TWINNY_GATEWAY_TOKEN/
    )
    const secrets = readGatewaySecrets(config, { TWINNY_GATEWAY_TOKEN: "t", LOCAL_KEY: "k" })
    assert.strictEqual(secrets.token, "t")
    assert.strictEqual(secrets.providerKeys.local, "k")
  })

  test("the route table refuses a capability the adapter cannot run", () => {
    const config = parseGatewayConfig(
      {
        providers: { mistral: { provider: "mistral", apiHostname: "api.mistral.ai", apiProtocol: "https" } },
        models: [{ alias: "embed", provider: "mistral", model: "x", capabilities: ["embeddings"] }]
      },
      KNOWN
    )
    assert.throws(
      () => buildRouteTable(config, { token: "t", providerKeys: {} }, providerRegistry),
      /cannot serve embeddings/
    )
  })

  test("the route table serves exactly the configured pairs", () => {
    const config = parseGatewayConfig(valid(), KNOWN)
    const table = buildRouteTable(config, { token: "t", providerKeys: {} }, providerRegistry)
    assert.strictEqual(table.size, 3)
    assert.deepStrictEqual(
      table.models().map((m) => [m.id, m.capabilities]),
      [
        ["coder", ["fim", "chat"]],
        ["embed", ["embeddings"]]
      ]
    )
    assert.strictEqual(table.route("coder", "fim").model, "qwen2.5-coder:7b")
    assert.strictEqual(table.route("Coder", "chat").model, "qwen2.5-coder:7b")
    assert.throws(() => table.route("coder", "embeddings"), /not configured for embeddings/)
    assert.throws(() => table.route("ghost", "fim"), /does not serve a model called "ghost"/)
  })
})

suite("Gateway config: team policy", () => {
  const base = {
    providers: { local: { provider: "ollama" } },
    models: [{ alias: "coder", provider: "local", model: "x", capabilities: ["chat"] }]
  }
  const kinds = providerRegistry.providerIds()

  test("a policy is parsed and refused when a rule is not a boolean or names unknown fields", () => {
    const parsed = parseGatewayConfig({ ...base, policy: { teamOnly: true, lockDefaults: true } }, kinds)
    assert.deepStrictEqual(parsed.policy, { teamOnly: true, lockDefaults: true })
    assert.deepStrictEqual(parseGatewayConfig({ ...base, policy: { teamOnly: false } }, kinds).policy, { teamOnly: false })
    assert.strictEqual(parseGatewayConfig(base, kinds).policy, undefined)
    assert.strictEqual(parseGatewayConfig({ ...base, policy: {} }, kinds).policy, undefined)
    assert.throws(() => parseGatewayConfig({ ...base, policy: { teamOnly: ["ollama"] } }, kinds), /teamOnly must be true or false/)
    assert.throws(() => parseGatewayConfig({ ...base, policy: { allowedProviders: ["ollama"] } }, kinds), /unknown field "allowedProviders"/)
    assert.throws(() => parseGatewayConfig({ ...base, policy: { lockDefaults: "yes" } }, kinds), /true or false/)
    assert.throws(() => parseGatewayConfig({ ...base, policy: { telemetry: false } }, kinds), /unknown field "telemetry"/)
    assert.throws(() => parseGatewayConfig({ ...base, policy: [] }, kinds), /policy must be an object/)
  })

  test("the route table exposes the policy without deciding whether to send it", () => {
    const config = parseGatewayConfig({ ...base, policy: { lockDefaults: true } }, kinds)
    const routes = buildRouteTable(config, { providerKeys: {} }, providerRegistry)
    assert.deepStrictEqual(routes.policy(), { lockDefaults: true })
    assert.strictEqual(buildRouteTable(parseGatewayConfig(base, kinds), { providerKeys: {} }, providerRegistry).policy(), undefined)
  })
})

suite("Gateway config: secret shield", () => {
  const kinds = providerRegistry.providerIds()
  const GITHUB = "ghp_" + "a1B2c3D4e5".repeat(4)
  const configFor = (apiHostname: string, secretShield?: string) =>
    parseGatewayConfig(
      {
        providers: { local: { provider: "ollama", apiHostname, apiPort: 11434 } },
        models: [{ alias: "coder", provider: "local", model: "x", capabilities: ["chat"] }],
        ...(secretShield ? { policy: { secretShield } } : {})
      },
      kinds
    )

  /**
   * A route table over a backend that records the prompt it was sent and
   * answers with it, so the test sees both what left and what came back.
   */
  const ask = async (apiHostname: string, secretShield?: string) => {
    const sent: string[] = []
    const registry = new ProviderRegistry().register("ollama", {
      id: "fake",
      create: () => ({
        id: "fake",
        capabilities: () => ["chat"],
        models: async () => [],
        chat: (request) =>
          (async function* () {
            const prompt = String(request.messages[0].content)
            sent.push(prompt)
            yield { content: `echo: ${prompt}` }
          })()
      })
    })
    const routes = buildRouteTable(configFor(apiHostname, secretShield), { providerKeys: {} }, registry)
    let reply = ""
    for await (const chunk of routes.route("coder", "chat").client.chat({
      model: "x",
      messages: [{ role: "user", content: `token = ${GITHUB}` }]
    })) {
      reply += chunk.content
    }
    return { sent: sent[0], reply }
  }

  test("backends on another host get placeholders; replies get the value back", async () => {
    const { sent, reply } = await ask("10.0.0.5")
    assert.ok(!sent.includes(GITHUB), sent)
    assert.match(sent, /REDACTED_/)
    assert.strictEqual(reply, `echo: token = ${GITHUB}`)
  })

  test("a backend on the gateway's host is sent the prompt as it is, unless set to always", async () => {
    assert.ok((await ask("127.0.0.1")).sent.includes(GITHUB))
    assert.ok(!(await ask("127.0.0.1", "always")).sent.includes(GITHUB))
    assert.ok((await ask("10.0.0.5", "off")).sent.includes(GITHUB))
  })

  test("the mode is validated, the default is not stored, and extensions are not told", () => {
    assert.strictEqual(configFor("h", "offMachine").policy, undefined)
    assert.deepStrictEqual(configFor("h", "always").policy, { secretShield: "always" })
    assert.throws(() => configFor("h", "sometimes"), /secretShield must be one of offMachine, always, off/)
    assert.strictEqual(policyForExtensions({ secretShield: "always" }), undefined)
  })

  test("the team pool counts as off the machine", () => {
    const team = { id: "t", label: "t", provider: "team", modelName: "x", type: "chat", apiHostname: "127.0.0.1" }
    assert.ok(shieldsBackend(team, undefined))
    assert.ok(!shieldsBackend(team, { secretShield: "off" }))
  })
})

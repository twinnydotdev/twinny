/**
 * The inference gate, in process: every model call, a developer's or a
 * plugin's, gets its caps, queue, routing rules, output cap and deadline
 * from the same place.
 */
import * as assert from "assert"

import { ChatRequest } from "../../extension/inference"
import { providerRegistry } from "../../extension/inference/registry"
import { GatewayConfig, parseGatewayConfig } from "../../gateway/config"
import { Admission, InferenceGate, Ticket } from "../../gateway/gate"
import { gatewayInference, repoWorkspace } from "../../gateway/plugins/inference"
import { RouteTable } from "../../gateway/routes"

const config = (limits: Record<string, unknown> = {}): GatewayConfig =>
  parseGatewayConfig(
    {
      listen: { host: "127.0.0.1", port: 0 },
      auth: { tokenEnv: null, keysFile: "/nonexistent/keys.json" },
      providers: {
        local: { provider: "ollama", apiHostname: "127.0.0.1", apiPort: 1 },
        cloud: { provider: "openai", apiHostname: "127.0.0.1", apiPort: 1, apiKeyEnv: "CLOUD_KEY" }
      },
      models: [
        { alias: "coder", provider: "local", model: "x", capabilities: ["chat", "embeddings"] },
        { alias: "gpt", provider: "cloud", model: "x", capabilities: ["chat", "embeddings"] }
      ],
      limits,
      policy: { routing: [{ workspace: "secret-*", localOnly: true }] }
    },
    providerRegistry.providerIds()
  )

/** Aliases answer from memory; every chat request is kept. */
const fakeRoutes = () => {
  const chats: ChatRequest[] = []
  const providerOf = (alias: string) => (alias === "gpt" ? "cloud" : "local")
  const routes = {
    models: () => [
      { id: "coder", capabilities: ["chat", "embeddings"] },
      { id: "gpt", capabilities: ["chat", "embeddings"] }
    ],
    providerOf,
    route: (alias: string) => ({
      model: "x",
      provider: providerOf(alias),
      client: {
        async *chat(request: ChatRequest) {
          chats.push(request)
          yield { content: "ok" }
        },
        embeddings: async (request: { input: string[] }) => ({ vectors: request.input.map(() => [1]) })
      }
    })
  } as unknown as RouteTable
  return { routes, chats }
}

const gateFor = (gatewayConfig: GatewayConfig, licensed = true) =>
  new InferenceGate({
    limits: gatewayConfig.limits,
    config: () => gatewayConfig,
    policyLicensed: () => licensed
  })

const admitted = (admission: Admission): Ticket => {
  assert.strictEqual(admission.kind, "admitted", JSON.stringify(admission))
  return (admission as { ticket: Ticket }).ticket
}

const drain = async (stream: AsyncIterable<string>) => {
  let text = ""
  for await (const piece of stream) text += piece
  return text
}

suite("Inference gate", () => {
  test("a plugin's chat and embeddings obey the routing rules for its repository", async () => {
    const { routes } = fakeRoutes()
    const gate = gateFor(config())
    const inference = gatewayInference({ routes: () => routes, gate: () => gate, principal: "plugin:github" })
    const signal = new AbortController().signal
    const workspace = repoWorkspace("acme/secret-sauce")
    assert.strictEqual(workspace, "secret-sauce")

    await assert.rejects(drain(inference.chat("gpt", [{ role: "user", content: "diff" }], { signal, workspace })), /own machines/)
    await assert.rejects(inference.embed("gpt", ["code"], signal, workspace), /own machines/)
    assert.strictEqual(await drain(inference.chat("coder", [{ role: "user", content: "diff" }], { signal, workspace })), "ok")
    assert.strictEqual(await drain(inference.chat("gpt", [{ role: "user", content: "diff" }], { signal, workspace: "blog" })), "ok")
    assert.strictEqual(gate.active, 0, "every ticket is given back, refused or not")

    // Without the policy licence the rules stay on paper.
    const unlicensed = gateFor(config(), false)
    const free = gatewayInference({ routes: () => routes, gate: () => unlicensed, principal: "plugin:github" })
    assert.strictEqual(await drain(free.chat("gpt", [{ role: "user", content: "diff" }], { signal, workspace })), "ok")
  })

  test("a plugin's chat gets the gateway's output cap", async () => {
    const { routes, chats } = fakeRoutes()
    const gate = gateFor(config({ maxOutputTokens: 256 }))
    const inference = gatewayInference({ routes: () => routes, gate: () => gate, principal: "plugin:gitlab" })
    const signal = new AbortController().signal
    await drain(inference.chat("coder", [{ role: "user", content: "x" }], { signal, maxTokens: 4000 }))
    await drain(inference.chat("coder", [{ role: "user", content: "x" }], { signal, maxTokens: 100 }))
    await drain(inference.chat("coder", [{ role: "user", content: "x" }], { signal }))
    assert.deepStrictEqual(chats.map((chat) => chat.maxTokens), [256, 100, 256])
  })

  test("one slot: the second waits and is admitted when the first finishes, the third finds the queue full", async () => {
    const { routes } = fakeRoutes()
    const gate = gateFor(config({ maxActiveRequests: 1, queue: { maxWaiting: 1, chatWaitMs: 5_000, fimWaitMs: 5_000 } }))
    const first = admitted(await gate.admit({ principal: "alice", route: "chat", routes }))
    const second = gate.admit({ principal: "bob", route: "fim", routes })
    const third = await gate.admit({ principal: "carol", route: "chat", routes })
    assert.strictEqual(third.kind, "refused")
    assert.deepStrictEqual(
      third.kind === "refused" && { reason: third.reason, generating: third.generating, waiting: third.waiting },
      { reason: "gateway", generating: 1, waiting: 1 }
    )
    // Embeddings never count against the caps.
    admitted(await gate.admit({ principal: "carol", route: "embeddings", routes })).finish()

    first.finish()
    first.finish()
    const next = admitted(await second)
    assert.strictEqual(gate.active, 1)
    next.finish()
    assert.strictEqual(gate.active, 0)
  })

  test("plugins take a slot like anyone, and are counted apart from developers", async () => {
    const { routes } = fakeRoutes()
    const gate = gateFor(config({ maxActiveRequests: 1, queue: { maxWaiting: 0 } }))
    const plugin = admitted(await gate.admit({ principal: "plugin:github", route: "chat", routes, background: true }))
    assert.strictEqual(gate.active, 1)
    assert.strictEqual(gate.developerActive, 0)
    const developer = await gate.admit({ principal: "alice", route: "chat", routes })
    assert.strictEqual(developer.kind, "refused")
    plugin.finish()
    const now = admitted(await gate.admit({ principal: "alice", route: "chat", routes }))
    assert.strictEqual(gate.developerActive, 1)
    now.finish()
  })

  test("a caller that stops waiting leaves the queue", async () => {
    const { routes } = fakeRoutes()
    const gate = gateFor(config({ maxActiveRequests: 1, queue: { maxWaiting: 1, chatWaitMs: 5_000 } }))
    const first = admitted(await gate.admit({ principal: "alice", route: "chat", routes }))
    const client = new AbortController()
    const waiting = gate.admit({ principal: "bob", route: "chat", routes, signal: client.signal })
    client.abort()
    assert.strictEqual((await waiting).kind, "gone")
    // The queue has room again.
    const again = gate.admit({ principal: "carol", route: "chat", routes })
    first.finish()
    admitted(await again).finish()
  })

  test("the deadline aborts a ticket; closing refuses waiters and newcomers; abortAll stops the rest", async () => {
    const { routes } = fakeRoutes()
    const gatewayConfig = config({ maxActiveRequests: 1, queue: { maxWaiting: 1, chatWaitMs: 5_000 } })
    const gate = new InferenceGate({
      limits: { ...gatewayConfig.limits, requestDeadlineMs: 20 },
      config: () => gatewayConfig,
      policyLicensed: () => true
    })
    const late = admitted(await gate.admit({ principal: "alice", route: "chat", routes }))
    await new Promise((resolve) => late.signal.addEventListener("abort", resolve))
    assert.match(String((late.signal.reason as Error).message), /deadline/)
    late.finish()

    const running = admitted(await gate.admit({ principal: "alice", route: "chat", routes }))
    const waiting = gate.admit({ principal: "bob", route: "chat", routes })
    gate.close()
    const refused = await waiting
    assert.strictEqual(refused.kind, "refused")
    assert.match(refused.kind === "refused" ? refused.message : "", /shutting down/)
    assert.strictEqual((await gate.admit({ principal: "carol", route: "embeddings", routes })).kind, "refused")
    gate.abortAll(new Error("stop"))
    assert.ok(running.signal.aborted)
    running.finish()
  })
})

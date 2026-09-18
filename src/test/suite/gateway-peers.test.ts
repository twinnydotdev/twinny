/**
 * Teammates' computers as a backend: a real gateway in this process with
 * a `team` alias, sharers built from the extension's own `Sharer` running
 * jobs on the fake backend, and requesters talking to the gateway through
 * the remote provider. Nothing here needs a model or the network.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { providerForBackend } from "../../common/backend-route"
import { API_PROVIDERS } from "../../common/constants"
import { TwinnyProvider } from "../../common/types"
import {
  FimRequest,
  InferenceCapability,
  InferenceError,
  InferenceProvider,
  isInferenceError,
  providerRegistry,
  readText,
  resolveInferenceProvider
} from "../../extension/inference"
import { Sharer } from "../../extension/team/sharer"
import { parseGatewayConfig, readGatewaySecrets, TEAM_PROVIDER_KIND } from "../../gateway/config"
import { KeyStore } from "../../gateway/keys"
import { createGatewayLog } from "../../gateway/log"
import { PeerRegistry } from "../../gateway/peers"
import { buildRouteTable } from "../../gateway/routes"
import { GatewayServer } from "../../gateway/server"
import { teamPoolAdapter } from "../../gateway/team-pool"
import { readUsage, UsageRecorder } from "../../gateway/usage"
import { RemoteInferenceProvider } from "../../protocol/client"
import { encodePeerFrame, PEER_CLOSE } from "../../protocol/peer"
import { dialWebSocket, WebSocketHandshakeError } from "../../protocol/websocket"

import { Backend, STALL, startBackend } from "./support/backend"

const TOKEN = "shared-token-for-peer-tests"
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const until = async (check: () => boolean, ms = 4_000, what = "condition") => {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await wait(20)
  assert.ok(check(), `${what} not met in time`)
}

const expectKind = async (run: () => Promise<unknown>, kind: string): Promise<InferenceError> => {
  try {
    await run()
  } catch (error) {
    assert.ok(isInferenceError(error), `expected an InferenceError, got ${String(error)}`)
    assert.strictEqual(error.kind, kind, error.message)
    return error
  }
  assert.fail(`expected a ${kind} error`)
}

/* -------------------------------------------------------------------------- */
/*  An in-process gateway with a team pool                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
  server: GatewayServer
  url: string
  peers: PeerRegistry
  keys: KeyStore
  key: Record<string, string>
  usageDir: string
  lines: string[]
  stop(): Promise<void>
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-peers-test-"))
let harnessCount = 0

const startHarness = async (backendPort: number, options: { pingIntervalMs?: number; helloTimeoutMs?: number; maxActiveRequests?: number } = {}): Promise<Harness> => {
  const dir = path.join(scratch, `h${harnessCount++}`)
  fs.mkdirSync(dir, { recursive: true })
  const lines: string[] = []
  const log = createGatewayLog((line) => lines.push(line))
  const keys = KeyStore.open(path.join(dir, "keys.json"))
  const key: Record<string, string> = {}
  for (const name of ["alice", "bob", "carol"]) key[name] = keys.create(name).key
  key.admin = keys.create("admin", { admin: true }).key
  const raw = {
    listen: { host: "127.0.0.1", port: 0 },
    auth: { tokenEnv: "TWINNY_GATEWAY_TOKEN", keysFile: path.join(dir, "keys.json"), licenseFile: path.join(dir, "license") },
    usage: { dir: path.join(dir, "usage"), retentionDays: 30 },
    providers: {
      local: { provider: "ollama", apiHostname: "127.0.0.1", apiPort: backendPort },
      pool: { provider: TEAM_PROVIDER_KIND }
    },
    models: [
      { alias: "coder", provider: "pool", model: "backend-coder:7b", capabilities: ["fim", "chat"] },
      { alias: "embed", provider: "pool", model: "backend-embed", capabilities: ["embeddings"] },
      { alias: "direct", provider: "local", model: "backend-coder:7b", capabilities: ["fim"] }
    ],
    limits: { maxActiveRequests: options.maxActiveRequests ?? 8 },
    teamDefaults: { fim: "coder" }
  }
  let config = parseGatewayConfig(raw, providerRegistry.providerIds())
  const peers = new PeerRegistry({
    log,
    wanted: () => ["backend-coder:7b", "backend-embed"],
    configured: () => true,
    keyActive: (name) => {
      keys.reload()
      return keys.active().some((record) => record.name === name)
    },
    pingIntervalMs: options.pingIntervalMs,
    helloTimeoutMs: options.helloTimeoutMs
  })
  providerRegistry.register(TEAM_PROVIDER_KIND, teamPoolAdapter(peers))
  config = parseGatewayConfig(raw, providerRegistry.providerIds())
  const secrets = readGatewaySecrets(config, { TWINNY_GATEWAY_TOKEN: TOKEN }, keys.active().length)
  const routes = buildRouteTable(config, secrets, providerRegistry)
  const usage = new UsageRecorder(config.usage.dir, 30)
  usage.start()
  const server = new GatewayServer({ config, token: TOKEN, keys, routes, log, usage, peers })
  const address = await server.start()
  return {
    server,
    url: address.url,
    peers,
    keys,
    key,
    usageDir: config.usage.dir,
    lines,
    stop: async () => {
      await server.stop()
      await usage.stop()
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Sharers                                                                   */
/* -------------------------------------------------------------------------- */

/** A provider that never answers until cancelled: a peer whose server hangs. */
class HangingProvider implements InferenceProvider {
  public readonly id = "hanging"
  public aborted = 0
  capabilities(): InferenceCapability[] {
    return ["fim", "chat", "embeddings"]
  }
  async models() {
    return [{ id: "backend-coder:7b", name: "backend-coder:7b", capabilities: this.capabilities() }]
  }
  async *fim(_request: FimRequest, options?: { signal?: AbortSignal }) {
    await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }))
    this.aborted++
    yield { text: "" }
  }
}

const sharerFor = (
  harness: Harness,
  name: string,
  backendPort: number,
  extra: { models?: string[]; slots?: number; provider?: InferenceProvider; machine?: string } = {}
): Sharer => {
  const models = extra.models ?? ["backend-coder:7b", "backend-embed"]
  const endpoint = { provider: API_PROVIDERS.Ollama, apiHostname: "127.0.0.1", apiPort: backendPort }
  return new Sharer({
    session: async () => ({ url: harness.url, token: harness.key[name] }),
    machine: extra.machine ?? `${name}-box`,
    backendKind: "ollama",
    listModels: async () => models.map((id) => ({ id, name: id })),
    route: (model, capability) => ({
      client: extra.provider
        ? resolveInferenceProvider({ ...providerForBackend(endpoint, model, capability, { id: "x", label: "x" }), provider: "hanging-kind" })
        : resolveInferenceProvider(providerForBackend(endpoint, model, capability, { id: "x", label: "x" })),
      model,
      provider: "ollama"
    }),
    slots: () => extra.slots ?? 2,
    reconnect: { minMs: 50, maxMs: 200 },
    jobDeadlineMs: 5_000
  })
}

const online = async (sharer: Sharer) => {
  await sharer.start()
  await until(() => sharer.state === "online", 4_000, `${sharer.status().error ?? "online"}`)
}

const requester = (harness: Harness, name: string, type: "fim" | "chat" | "embedding" = "fim") =>
  resolveInferenceProvider({
    id: "gw",
    label: "Gateway",
    modelName: "coder",
    provider: API_PROVIDERS.TwinnyRemote,
    type,
    apiHostname: "127.0.0.1",
    apiPort: Number(new URL(harness.url).port),
    apiProtocol: "http",
    apiPath: "",
    apiKey: harness.key[name]
  } satisfies TwinnyProvider)

const fimRequest = (prompt = "def add(a, b):"): FimRequest => ({ model: "coder", prompt, maxTokens: 8, temperature: 0 })

/* -------------------------------------------------------------------------- */

suite("Gateway: teammates' computers as a backend", function () {
  this.timeout(30_000)

  let backend: Backend
  let harness: Harness
  const sharers: Sharer[] = []

  suiteSetup(async () => {
    backend = await startBackend()
  })

  suiteTeardown(async () => {
    await backend.close()
    providerRegistry.unregister("hanging-kind")
  })

  setup(async () => {
    backend.requests.length = 0
    harness = await startHarness(backend.port, { pingIntervalMs: 300, helloTimeoutMs: 400 })
  })

  teardown(async () => {
    for (const sharer of sharers.splice(0)) sharer.stop()
    await harness.stop()
  })

  test("with nobody sharing, the pool's aliases fail with provider-unavailable and status says so", async () => {
    const failure = await expectKind(() => readText(requester(harness, "alice").fim(fimRequest())), "provider-unavailable")
    assert.match(failure.message, /No teammate is sharing backend-coder:7b/)
    const status = await new RemoteInferenceProvider({ baseUrl: harness.url, token: harness.key.alice }).status()
    const pool = status.backends.find((b) => b.provider === "pool")
    assert.ok(pool && !pool.ok && pool.peers === 0, JSON.stringify(status))
    const team = await new RemoteInferenceProvider({ baseUrl: harness.url, token: harness.key.alice }).team()
    assert.deepStrictEqual(team.sharing, { wanted: ["backend-coder:7b", "backend-embed"] })
    assert.deepStrictEqual(team.policy?.peers, ["coder", "embed"])
  })

  test("FIM, chat and embeddings flow through a sharer, and usage names who served", async () => {
    const alice = sharerFor(harness, "alice", backend.port)
    sharers.push(alice)
    await online(alice)
    assert.deepStrictEqual(alice.status().wanted, ["backend-coder:7b", "backend-embed"])

    const text = await readText(requester(harness, "bob").fim(fimRequest()))
    assert.strictEqual(text, "def add")
    assert.strictEqual(backend.requests[0].path, "/api/generate")
    assert.strictEqual(backend.requests[0].model, "backend-coder:7b")

    const chat = await readText(requester(harness, "bob", "chat").chat({ model: "coder", messages: [{ role: "user", content: "hi" }] }))
    assert.strictEqual(chat, "Hello there")

    const { vectors } = await requester(harness, "bob", "embedding").embeddings({ model: "embed", input: ["a", "b"] })
    assert.strictEqual(vectors.length, 2)

    await until(() => alice.status().served === 3)
    await wait(100)
    const records = readUsage(harness.usageDir, new Date(Date.now() - 60_000), new Date())
    assert.strictEqual(records.length, 3)
    assert.ok(records.every((r) => r.key === "bob" && r.peer === "alice@alice-box" && r.outcome === "ok"), JSON.stringify(records))
    assert.ok(harness.lines.some((line) => /event=request .*outcome=ok.*peer=alice@alice-box/.test(line)), harness.lines.join("\n"))
    const status = await new RemoteInferenceProvider({ baseUrl: harness.url, token: harness.key.alice }).status()
    assert.strictEqual(status.backends.find((b) => b.provider === "pool")?.peers, 1)
  })

  test("the least-loaded peer is chosen; every slot busy is rate-limited, not queued", async () => {
    const alice = sharerFor(harness, "alice", backend.port, { slots: 1 })
    const bob = sharerFor(harness, "bob", backend.port, { slots: 1 })
    sharers.push(alice, bob)
    await online(alice)
    await online(bob)

    const client = requester(harness, "carol")
    const first = client.fim(fimRequest(STALL))[Symbol.asyncIterator]()
    assert.strictEqual(((await first.next()).value as { text: string }).text, "def")
    await until(() => harness.peers.snapshot().filter((p) => p.inflight === 1).length === 1)
    const second = client.fim(fimRequest(STALL))[Symbol.asyncIterator]()
    assert.strictEqual(((await second.next()).value as { text: string }).text, "def")
    await until(() => harness.peers.snapshot().every((p) => p.inflight === 1))

    const refused = await expectKind(() => readText(client.fim(fimRequest())), "rate-limited")
    assert.match(refused.message, /busy/)
    assert.strictEqual(backend.requests.length, 2)
    await first.return?.()
    await second.return?.()
    await until(() => backend.requests.every((r) => r.cancelled), 4_000, "cancel reached the sharers")
  })

  test("a requester cancelling reaches the sharer's local server", async () => {
    const alice = sharerFor(harness, "alice", backend.port)
    sharers.push(alice)
    await online(alice)
    const controller = new AbortController()
    const stream = requester(harness, "bob").fim(fimRequest(STALL), { signal: controller.signal })[Symbol.asyncIterator]()
    await stream.next()
    controller.abort()
    await expectKind(() => stream.next(), "cancelled")
    await until(() => backend.requests[0]?.cancelled === true)
    await until(() => harness.peers.snapshot()[0].inflight === 0)
  })

  test("a sharer lost mid-stream ends the request with provider-unavailable", async () => {
    const alice = sharerFor(harness, "alice", backend.port)
    sharers.push(alice)
    await online(alice)
    const stream = requester(harness, "bob").fim(fimRequest(STALL))[Symbol.asyncIterator]()
    await stream.next()
    alice.stop()
    const failure = await expectKind(() => stream.next(), "provider-unavailable")
    assert.match(failure.message, /went offline/)
    await until(() => harness.peers.online() === 0)
  })

  test("a sharer lost before its first chunk is replaced by another once", async () => {
    const hanging = new HangingProvider()
    providerRegistry.register("hanging-kind", { id: "hanging-kind", create: () => hanging })
    const stuck = sharerFor(harness, "alice", backend.port, { provider: hanging, models: ["backend-coder:7b"] })
    const bob = sharerFor(harness, "bob", backend.port)
    sharers.push(stuck, bob)
    // The earliest-connected idle peer wins a tie, so the hanging one is first.
    await online(stuck)
    await online(bob)
    const client = requester(harness, "carol")
    const pending = readText(client.fim(fimRequest()))
    await until(() => harness.peers.snapshot().find((p) => p.key === "alice")?.inflight === 1)
    stuck.stop()
    assert.strictEqual(await pending, "def add")
    assert.strictEqual(backend.requests.length, 1)
  })

  test("a model the sharer did not announce is never sent to it", async () => {
    const alice = sharerFor(harness, "alice", backend.port, { models: ["backend-coder:7b"] })
    sharers.push(alice)
    await online(alice)
    const failure = await expectKind(() => requester(harness, "bob", "embedding").embeddings({ model: "embed", input: "x" }), "provider-unavailable")
    assert.match(failure.message, /No teammate is sharing backend-embed/)
    assert.strictEqual(backend.requests.length, 0)
  })

  test("the shared token cannot share; a bad key and a wrong path are refused at the handshake", async () => {
    for (const [token, status] of [
      [TOKEN, 403],
      ["tsk_00000000_" + "0".repeat(64), 401],
      ["", 401]
    ] as const) {
      try {
        await dialWebSocket(`${harness.url}/twinny/v1/peers`, token ? { Authorization: `Bearer ${token}` } : {})
        assert.fail("expected a refusal")
      } catch (error) {
        assert.ok(error instanceof WebSocketHandshakeError, String(error))
        assert.strictEqual(error.status, status)
      }
    }
    try {
      await dialWebSocket(`${harness.url}/twinny/v1/elsewhere`, { Authorization: `Bearer ${harness.key.alice}` })
      assert.fail("expected a refusal")
    } catch (error) {
      assert.ok(error instanceof WebSocketHandshakeError)
      assert.strictEqual(error.status, 404)
    }
    assert.strictEqual(harness.peers.online(), 0)
  })

  test("no hello in time, and junk frames, close the socket with a protocol error", async () => {
    const silent = await dialWebSocket(`${harness.url}/twinny/v1/peers`, { Authorization: `Bearer ${harness.key.alice}` })
    const closed = new Promise<number>((resolve) => silent.once("close", (code) => resolve(code)))
    assert.strictEqual(await closed, PEER_CLOSE.protocol)

    const junk = await dialWebSocket(`${harness.url}/twinny/v1/peers`, { Authorization: `Bearer ${harness.key.alice}` })
    const junkClosed = new Promise<[number, string]>((resolve) => junk.once("close", (code, reason) => resolve([code, reason])))
    await junk.send("{\"type\":\"pong\"}")
    const [code, reason] = await junkClosed
    assert.strictEqual(code, PEER_CLOSE.protocol)
    assert.match(reason, /first frame must be hello/)

    const malformed = await dialWebSocket(`${harness.url}/twinny/v1/peers`, { Authorization: `Bearer ${harness.key.alice}` })
    const malformedClosed = new Promise<[number, string]>((resolve) => malformed.once("close", (code, reason) => resolve([code, reason])))
    await malformed.send("{\"type\":\"chunk\"}")
    const [malformedCode, malformedReason] = await malformedClosed
    assert.strictEqual(malformedCode, PEER_CLOSE.protocol)
    assert.match(malformedReason, /no job id/)
    assert.strictEqual(harness.peers.online(), 0)
  })

  test("a revoked key is closed with 4001 and the sharer does not come back", async () => {
    const alice = sharerFor(harness, "alice", backend.port)
    sharers.push(alice)
    await online(alice)
    const record = harness.keys.list().find((k) => k.name === "alice")!
    harness.keys.revoke(record.id)
    await until(() => alice.state === "off", 4_000, "sharer switched off")
    assert.ok(alice.status().refused)
    assert.match(alice.status().error ?? "", /revoked/)
    assert.strictEqual(harness.peers.online(), 0)
    assert.ok(harness.lines.some((line) => /event=peer\.disconnected .*code=4001/.test(line)))
  })

  test("the admin API lists peers and can disconnect one; the sharer reconnects", async () => {
    const alice = sharerFor(harness, "alice", backend.port)
    sharers.push(alice)
    await online(alice)
    const admin = (route: string, init: RequestInit = {}) =>
      fetch(`${harness.url}/twinny/v1/admin/${route}`, { ...init, headers: { Authorization: `Bearer ${harness.key.admin}` } })
    const listed = (await (await admin("peers")).json()) as { peers: Array<{ id: string; label: string; models: string[] }>; wanted: string[] }
    assert.strictEqual(listed.peers.length, 1)
    assert.strictEqual(listed.peers[0].label, "alice@alice-box")
    assert.deepStrictEqual(listed.peers[0].models, ["backend-coder:7b", "backend-embed"])
    assert.deepStrictEqual(listed.wanted, ["backend-coder:7b", "backend-embed"])

    const developer = await fetch(`${harness.url}/twinny/v1/admin/peers`, { headers: { Authorization: `Bearer ${harness.key.bob}` } })
    assert.strictEqual(developer.status, 403)

    const disconnected = await admin(`peers/${listed.peers[0].id}/disconnect`, { method: "POST" })
    assert.strictEqual(disconnected.status, 200)
    await until(() => alice.state === "reconnecting" || alice.state === "connecting" || (alice.state === "online" && harness.peers.snapshot()[0]?.id !== listed.peers[0].id))
    await until(() => alice.state === "online" && harness.peers.online() === 1, 5_000, "reconnected")
    assert.notStrictEqual(harness.peers.snapshot()[0].id, listed.peers[0].id)
  })

  test("a sharer whose local server is down is degraded and the request fails with provider-unavailable", async () => {
    const dead = await startBackend()
    await dead.close()
    const alice = sharerFor(harness, "alice", dead.port)
    sharers.push(alice)
    await online(alice)
    await expectKind(() => readText(requester(harness, "bob").fim(fimRequest())), "provider-unavailable")
    await until(() => !!harness.peers.snapshot()[0]?.degradedUntil)
    assert.strictEqual(alice.status().backendOk, false)
  })

  test("the pool's models are the union of what peers offer; an unrelated alias still goes direct", async () => {
    const alice = sharerFor(harness, "alice", backend.port, { models: ["backend-coder:7b"] })
    const bob = sharerFor(harness, "bob", backend.port, { models: ["backend-embed", "other"] })
    sharers.push(alice, bob)
    await online(alice)
    await online(bob)
    assert.deepStrictEqual(harness.peers.models(), ["backend-coder:7b", "backend-embed", "other"])
    const direct = await readText(requester(harness, "carol").fim({ ...fimRequest(), model: "direct" }))
    assert.strictEqual(direct, "def add")
    const records = readUsage(harness.usageDir, new Date(Date.now() - 60_000), new Date())
    assert.strictEqual(records.find((r) => r.alias === "direct")?.peer, undefined)
  })

  test("stopping the gateway closes peers with 1001 after their jobs finish", async () => {
    const alice = sharerFor(harness, "alice", backend.port)
    sharers.push(alice)
    await online(alice)
    const stream = requester(harness, "bob").fim(fimRequest())[Symbol.asyncIterator]()
    const head = await stream.next()
    assert.strictEqual((head.value as { text: string }).text, "def")
    await harness.server.stop()
    let rest = ""
    for (let next = await stream.next(); !next.done; next = await stream.next()) rest += (next.value as { text: string }).text
    assert.strictEqual(rest, " add")
    await until(() => alice.state === "reconnecting", 4_000, "sharer waiting to reconnect")
    assert.ok(!alice.status().refused)
    // The close reason, or the refused redial if the first retry already ran.
    assert.match(alice.status().error ?? "", /stopping|dropped|closed|ECONNREFUSED/)
  })

  test("a raw peer that does not answer pings is dropped and its jobs fail", async () => {
    const raw = await dialWebSocket(`${harness.url}/twinny/v1/peers`, { Authorization: `Bearer ${harness.key.alice}` })
    const frames: string[] = []
    raw.on("message", (text) => frames.push(text))
    await raw.send(encodePeerFrame({ type: "hello", protocol: 1, name: "silent", backend: { kind: "ollama" }, models: [{ id: "backend-coder:7b", name: "x" }], slots: 1 }))
    await until(() => frames.some((f) => f.includes("\"welcome\"")))
    assert.strictEqual(harness.peers.online(), 1, `peer listed after welcome; frames: ${frames.join(" | ")}`)
    assert.deepStrictEqual(harness.peers.snapshot()[0].models, ["backend-coder:7b"])
    const pending = expectKind(() => readText(requester(harness, "bob").fim(fimRequest())), "provider-unavailable")
    await until(() => frames.some((f) => f.includes("\"job\"")))
    const closed = new Promise<number>((resolve) => raw.once("close", (code) => resolve(code)))
    // Two ping intervals with no pong: gone.
    assert.strictEqual(await closed, PEER_CLOSE.protocol)
    const failure = await pending
    assert.match(failure.message, /went offline/)
    assert.strictEqual(harness.peers.online(), 0)
  })
})

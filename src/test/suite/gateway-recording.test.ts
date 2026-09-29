/**
 * Recording: the JSONL store, the recorder's gating and sweep, the
 * training export, and an in-process gateway with a fake backend where
 * nothing is kept until the licence allows it and the routes are on, and
 * then chat, autocomplete and embedding content is kept, disclosed on the
 * team route, readable and exportable by admins only.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as http from "http"
import * as os from "os"
import * as path from "path"

import { providerRegistry } from "../../extension/inference/registry"
import { parseGatewayConfig, readGatewaySecrets } from "../../gateway/config"
import { GatewayConfiguration } from "../../gateway/configuration"
import { KeyStore } from "../../gateway/keys"
import { LicenseStore } from "../../gateway/license"
import { createGatewayLog } from "../../gateway/log"
import { exportLines, toTrainingLine } from "../../gateway/recording/export"
import { Recorder } from "../../gateway/recording/recorder"
import { JsonlRecordingStore, newRecordingId, previewOf, RecordingRecord } from "../../gateway/recording/store"
import { buildRouteTable } from "../../gateway/routes"
import { GatewayServer } from "../../gateway/server"
import { RemoteInferenceProvider } from "../../protocol/client"

import { Backend, startBackend } from "./support/backend"
import { generateSigningKeys, issueLicense } from "./support/sign-license"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-recording-test-"))

const record = (over: Partial<RecordingRecord> = {}): RecordingRecord => ({
  id: newRecordingId(new Date(over.at ?? "2026-09-15T10:00:00Z")),
  at: "2026-09-15T10:00:00.000Z",
  key: "alice",
  route: "chat",
  alias: "coder",
  model: "backend-coder:7b",
  outcome: "ok",
  ms: 120,
  request: { messages: [{ role: "user", content: "Write a haiku about tests" }] },
  response: { content: "Green lights, then red." },
  ...over
})

suite("Recording store (jsonl)", () => {
  test("appends per day, lists newest first with paging and filters, gets, counts, prunes", () => {
    const store = new JsonlRecordingStore(path.join(scratch, "jsonl"))
    const days = ["2026-09-13", "2026-09-14", "2026-09-15"]
    for (const day of days) {
      for (let i = 0; i < 3; i++) {
        const at = `${day}T1${i}:00:00.000Z`
        store.append(record({ at, key: i === 0 ? "bob" : "alice", route: i === 2 ? "fim" : "chat", request: i === 2 ? { prompt: `p${i}`, suffix: "" } : { messages: [{ role: "user", content: `hello ${day} ${i}` }] }, response: i === 2 ? { text: "done" } : { content: `reply ${i}` } }))
      }
    }
    assert.strictEqual(fs.readdirSync(path.join(scratch, "jsonl")).sort().join(","), days.map((d) => `${d}.jsonl`).join(","))
    assert.strictEqual(store.count(), 9)
    assert.strictEqual(store.count({ route: "fim" }), 3)
    assert.strictEqual(store.count({ key: "bob" }), 3)
    assert.deepStrictEqual(store.keys(), ["alice", "bob"])

    const first = store.list({ limit: 4 })
    assert.strictEqual(first.records.length, 4)
    assert.ok(first.records[0].at > first.records[3].at, "newest first")
    assert.ok(first.nextBefore)
    const second = store.list({ limit: 4, before: first.nextBefore })
    assert.strictEqual(second.records.length, 4)
    assert.ok(second.records[0].id < first.records[3].id)
    const third = store.list({ limit: 4, before: second.nextBefore })
    assert.strictEqual(third.records.length, 1)
    assert.strictEqual(third.nextBefore, undefined)

    const searched = store.list({ search: "2026-09-14 1" })
    assert.strictEqual(searched.records.length, 1)
    assert.strictEqual(searched.records[0].preview, "hello 2026-09-14 1")
    assert.strictEqual(store.list({ since: new Date("2026-09-15T00:00:00Z") }).records.length, 3)
    assert.strictEqual(store.list({ until: new Date("2026-09-14T00:00:00Z") }).records.length, 3)

    const one = store.get(first.records[0].id)
    assert.ok(one)
    assert.deepStrictEqual((one.response as { text: string }).text, "done")
    assert.strictEqual(store.get("00000000000000-deadbeef"), undefined)
    assert.strictEqual([...store.each({ route: "chat" })].length, 6)
    assert.ok([...store.each()][0].at < [...store.each()][8].at, "each is oldest first")

    assert.strictEqual(store.prune(new Date("2026-09-15T00:00:00Z")), 6)
    assert.strictEqual(store.count(), 3)
    store.append(record({ at: "2026-09-15T13:00:00.000Z", outcome: "error", response: { content: "" } }))
    assert.strictEqual(store.count({ outcome: "error" }), 1)
    assert.strictEqual(store.list({ outcome: "ok" }).records.length, 3)
    assert.strictEqual(store.list({ outcome: "cancelled" }).records.length, 0)
    assert.strictEqual(previewOf(record({ route: "embeddings", request: { input: ["a", "b"] } })), "a ⏎ b")
  })
})

suite("Recorder and export", () => {
  test("nothing is kept unless the route is on and the licence allows it; sweep applies retention", () => {
    const store = new JsonlRecordingStore(path.join(scratch, "recorder"))
    let licensed = false
    const recorder = new Recorder({ store, settings: { chat: true, fim: false, embeddings: false, retentionDays: 7 }, licensed: () => licensed })
    const input = { key: "alice", route: "chat" as const, alias: "coder", outcome: "ok" as const, ms: 10, capture: { request: { messages: [] }, response: { content: "x" } } }
    assert.strictEqual(recorder.record(input), undefined, "unlicensed")
    assert.deepStrictEqual(recorder.active(), [])
    licensed = true
    assert.deepStrictEqual(recorder.active(), ["chat"])
    assert.ok(recorder.record(input))
    assert.strictEqual(recorder.record({ ...input, route: "fim" }), undefined, "fim is off")
    recorder.update({ chat: true, fim: true, embeddings: false, retentionDays: 7 })
    assert.ok(recorder.record({ ...input, route: "fim", capture: { request: { prompt: "a" }, response: { text: "b" } } }))
    assert.strictEqual(store.count(), 2)
    // An autocomplete the editor stopped reading is a success ended by the client, not a cancellation.
    const stopped = recorder.record({ ...input, route: "fim", outcome: "cancelled", capture: { request: { prompt: "a" }, response: { text: "def add" } } })
    assert.strictEqual(stopped?.outcome, "ok")
    assert.strictEqual(stopped?.ended, "client")
    const empty = recorder.record({ ...input, route: "fim", outcome: "cancelled", capture: { request: { prompt: "a" }, response: { text: "" } } })
    assert.strictEqual(empty?.outcome, "cancelled")
    const chat = recorder.record({ ...input, outcome: "cancelled", capture: { request: { messages: [] }, response: { content: "partial" } } })
    assert.strictEqual(chat?.outcome, "cancelled", "a stopped chat reply is still partial")
    store.append(record({ at: "2026-01-01T00:00:00.000Z" }))
    assert.strictEqual(recorder.sweep(new Date("2026-09-15T00:00:00Z")), 1)
    assert.strictEqual(recorder.summary().store.count, 5)
    recorder.stop()
  })

  test("the training shape keeps only successful, complete examples", () => {
    const chat = toTrainingLine(record())
    assert.deepStrictEqual(chat?.messages, [{ role: "user", content: "Write a haiku about tests" }, { role: "assistant", content: "Green lights, then red." }])
    const fim = toTrainingLine(record({ route: "fim", request: { prompt: "<PRE> def add(a, b): <SUF> \nprint(add(1, 2)) <MID>", prefix: "def add(a, b):", suffix: "\nprint(add(1, 2))" }, response: { text: " return a + b" } }))
    assert.deepStrictEqual({ prompt: fim?.prompt, suffix: fim?.suffix, completion: fim?.completion }, { prompt: "def add(a, b):", suffix: "\nprint(add(1, 2))", completion: " return a + b" }, "the raw code, not the templated prompt")
    const untemplated = toTrainingLine(record({ route: "fim", request: { prompt: "def add(a, b):" }, response: { text: " return a + b" } }))
    assert.strictEqual(untemplated?.prompt, "def add(a, b):")
    const embed = toTrainingLine(record({ route: "embeddings", request: { input: ["x"] }, response: { count: 1, dimensions: 3 } }))
    assert.deepStrictEqual(embed?.input, ["x"])
    assert.strictEqual(toTrainingLine(record({ outcome: "cancelled" })), undefined)
    assert.strictEqual(toTrainingLine(record({ response: { content: "" } })), undefined)
    const lines = [...exportLines([record(), record({ outcome: "error" })], "training")]
    assert.strictEqual(lines.length, 1)
    assert.strictEqual([...exportLines([record(), record({ outcome: "error" })], "raw")].length, 2)
  })
})

/* -------------------------------------------------------------------------- */

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

const request = (url: string, method: string, key: string, body?: unknown): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const target = new URL(url)
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      { host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method, headers: { Authorization: `Bearer ${key}`, ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) } },
      (res) => {
        let text = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => (text += chunk))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }))
      }
    )
    req.on("error", reject)
    req.end(payload)
  })

const json = (reply: Reply) => JSON.parse(reply.body) as Record<string, unknown>

suite("Gateway recording (in process)", function () {
  this.timeout(30_000)
  const dir = path.join(scratch, "gateway")
  const signing = generateSigningKeys()
  let backend: Backend
  let server: GatewayServer
  let url: string
  let admin: string
  let alice: string
  let configuration: GatewayConfiguration
  let recorder: Recorder
  let license: LicenseStore

  suiteSetup(async () => {
    backend = await startBackend()
    const file = path.join(dir, "gateway.json")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify({
        listen: { host: "127.0.0.1", port: 0 },
        auth: { tokenEnv: null, keysFile: path.join(dir, "keys.json"), licenseFile: path.join(dir, "license") },
        usage: { dir: path.join(dir, "usage") },
        recording: { chat: true, fim: true, embeddings: true, retentionDays: 30, dir: path.join(dir, "recordings"), store: "jsonl" },
        providers: { local: { provider: "ollama", apiHostname: "127.0.0.1", apiPort: backend.port } },
        models: [
          { alias: "coder", provider: "local", model: "backend-coder:7b", capabilities: ["fim", "chat"] },
          { alias: "embed", provider: "local", model: "backend-embed", capabilities: ["embeddings"] }
        ],
        teamDefaults: { chat: "coder" }
      })
    )
    const config = parseGatewayConfig(JSON.parse(fs.readFileSync(file, "utf8")), providerRegistry.providerIds())
    const keys = KeyStore.open(config.auth.keysFile, 0)
    admin = keys.create("operator", { admin: true }).key
    alice = keys.create("alice").key
    license = LicenseStore.open(config.auth.licenseFile, [signing.publicKeyRaw], 0)
    const routes = buildRouteTable(config, readGatewaySecrets(config, {}, keys.active().length), providerRegistry)
    configuration = new GatewayConfiguration(file, config, routes, {})
    recorder = new Recorder({
      store: new JsonlRecordingStore(path.join(config.recording.dir, "jsonl")),
      settings: config.recording,
      licensed: () => license.current().features.includes("recording")
    })
    server = new GatewayServer({ config, keys, license, routes, log: createGatewayLog(() => undefined), configuration, recorder })
    url = (await server.start()).url
  })

  suiteTeardown(async () => {
    await server.stop()
    await backend.close()
  })

  const client = () => new RemoteInferenceProvider({ baseUrl: url, token: alice })
  const readAll = async (stream: AsyncIterable<{ text?: string; content?: string }>) => {
    let out = ""
    for await (const chunk of stream) out += chunk.text ?? chunk.content ?? ""
    return out
  }

  test("without the licence feature nothing is kept, and the team route discloses nothing", async () => {
    assert.strictEqual(await readAll(client().chat({ model: "coder", messages: [{ role: "user", content: "hi" }] })), "Hello there")
    const list = json(await request(`${url}/twinny/v1/admin/recordings`, "GET", admin))
    assert.deepStrictEqual(list.records, [])
    const summary = list.summary as { active: string[]; licensed: boolean; settings: { chat: boolean } }
    assert.deepStrictEqual(summary.active, [])
    assert.strictEqual(summary.licensed, false)
    assert.strictEqual(summary.settings.chat, true)
    const team = json(await request(`${url}/twinny/v1/team`, "GET", alice))
    assert.strictEqual(team.policy, undefined)
    assert.strictEqual((await request(`${url}/twinny/v1/admin/recordings`, "GET", alice)).status, 403)
  })

  test("with the licence, chat, autocomplete and embedding content is kept and disclosed", async () => {
    license.install(issueLicense({ org: "Acme", seats: 10, features: ["recording"] }, signing.privateKeyPem).token)
    assert.deepStrictEqual((json(await request(`${url}/twinny/v1/team`, "GET", alice)).policy as { recording: string[] }).recording, ["chat", "fim", "embeddings"])

    assert.strictEqual(await readAll(client().chat({ model: "coder", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Say hello" }], temperature: 0.1 })), "Hello there")
    assert.strictEqual(await readAll(client().fim({ model: "coder", prompt: "def add(a, b):", suffix: "\nprint(add(1, 2))", maxTokens: 8 })), "def add")
    const vectors = await client().embeddings({ model: "embed", input: ["one", "two"] })
    assert.strictEqual(vectors.vectors.length, 2)

    const list = json(await request(`${url}/twinny/v1/admin/recordings`, "GET", admin))
    const records = list.records as Array<{ id: string; route: string; key: string; model: string; preview: string; outcome: string }>
    assert.deepStrictEqual(records.map((r) => r.route), ["embeddings", "fim", "chat"])
    assert.ok(records.every((r) => r.key === "alice" && r.outcome === "ok"))
    assert.strictEqual(records[2].model, "backend-coder:7b")
    assert.strictEqual(records[2].preview, "Say hello")

    const chat = json(await request(`${url}/twinny/v1/admin/recordings/${records[2].id}`, "GET", admin))
    assert.deepStrictEqual(chat.request, { messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Say hello" }], temperature: 0.1 })
    assert.deepStrictEqual(chat.response, { content: "Hello there" })
    assert.strictEqual(chat.provider, "local")
    const fim = json(await request(`${url}/twinny/v1/admin/recordings/${records[1].id}`, "GET", admin))
    assert.deepStrictEqual(fim.request, { prompt: "def add(a, b):", suffix: "\nprint(add(1, 2))", maxTokens: 8 })
    assert.deepStrictEqual(fim.response, { text: "def add" })
    assert.deepStrictEqual((fim.usage as { promptTokens: number }).promptTokens, 12)
    const embed = json(await request(`${url}/twinny/v1/admin/recordings/${records[0].id}`, "GET", admin))
    assert.deepStrictEqual(embed.request, { input: ["one", "two"] })
    assert.deepStrictEqual(embed.response, { count: 2, dimensions: 3 })
    assert.ok(!JSON.stringify(embed).includes("0.1,0.2,0.3"), "vectors must not be kept")

    const exported = await request(`${url}/twinny/v1/admin/recordings/export?route=chat`, "GET", admin)
    assert.strictEqual(exported.status, 200)
    assert.match(String(exported.headers["content-disposition"]), /attachment; filename="twinny-recordings-chat-/)
    const lines = exported.body.trim().split("\n").map((line) => JSON.parse(line) as { messages: Array<{ role: string; content: string }> })
    assert.strictEqual(lines.length, 1)
    assert.deepStrictEqual(lines[0].messages.at(-1), { role: "assistant", content: "Hello there" })
    const raw = await request(`${url}/twinny/v1/admin/recordings/export?format=raw`, "GET", admin)
    assert.strictEqual(raw.body.trim().split("\n").length, 3)
    assert.strictEqual((await request(`${url}/twinny/v1/admin/recordings/export`, "GET", alice)).status, 403)
    assert.strictEqual((await request(`${url}/twinny/v1/admin/recordings?route=nope`, "GET", admin)).status, 400)
    assert.strictEqual((await request(`${url}/twinny/v1/admin/recordings/00000000000000-deadbeef`, "GET", admin)).status, 404)
  })

  test("saving the configuration switches routes off live and the disclosure follows", async () => {
    const snapshot = json(await request(`${url}/twinny/v1/admin/config`, "GET", admin))
    const saved = await request(`${url}/twinny/v1/admin/config`, "PUT", admin, { revision: snapshot.revision, recording: { chat: true, fim: false, embeddings: false, retentionDays: 30, dir: path.join(dir, "recordings"), store: "jsonl" } })
    assert.strictEqual(saved.status, 200, saved.body)
    assert.deepStrictEqual((json(await request(`${url}/twinny/v1/team`, "GET", alice)).policy as { recording: string[] }).recording, ["chat"])
    const before = recorder.store.count()
    assert.strictEqual(await readAll(client().fim({ model: "coder", prompt: "x", maxTokens: 4 })), "def add")
    assert.strictEqual(recorder.store.count(), before, "fim is off now")
    assert.strictEqual(await readAll(client().chat({ model: "coder", messages: [{ role: "user", content: "again" }] })), "Hello there")
    assert.strictEqual(recorder.store.count(), before + 1)
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, "gateway.json"), "utf8")).recording.fim, false)
  })
})

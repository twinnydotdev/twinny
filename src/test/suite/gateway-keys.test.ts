/**
 * Access keys and usage records, without a server: the key store's file
 * format and verification, the usage files and their summary, and the
 * token counts the adapters pull out of each backend dialect.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import {
  usageFromEmbeddingResponse,
  usageFromResponse
} from "../../extension/inference/adapters/fim-dialects"
import { parseGatewayConfig, readGatewaySecrets } from "../../gateway/config"
import { hashSecret, KeyStore } from "../../gateway/keys"
import { dayOf, parseSince, summarizeUsage, UsageRecorder } from "../../gateway/usage"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-keys-test-"))

suite("Gateway access keys", () => {
  test("a key is shown once, stored as a hash, and verifies in constant time", () => {
    const file = path.join(scratch, "a", "keys.json")
    const store = KeyStore.open(file)
    assert.deepStrictEqual(store.list(), [])
    const { key, record } = store.create("alice")
    assert.match(key, /^tsk_[0-9a-f]{8}_[0-9a-f]{64}$/)
    const secret = key.split("_")[2]
    assert.strictEqual(record.hash, hashSecret(secret))
    const stored = fs.readFileSync(file, "utf8")
    assert.ok(!stored.includes(secret))
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)

    assert.strictEqual(store.verify(key)?.name, "alice")
    assert.strictEqual(store.verify(`${key}x`), undefined)
    assert.strictEqual(store.verify(key.replace(/.$/, (c) => (c === "a" ? "b" : "a"))), undefined)
    assert.strictEqual(store.verify("tsk_00000000_" + secret), undefined)
    assert.strictEqual(store.verify("not-a-key"), undefined)
    assert.strictEqual(store.verify(undefined), undefined)
    assert.ok(KeyStore.looksLikeKey(key))
    assert.ok(!KeyStore.looksLikeKey("shared-token"))
  })

  test("names are validated and unique among active keys; revoking frees the name", () => {
    const store = KeyStore.open(path.join(scratch, "b", "keys.json"))
    assert.throws(() => store.create("bad name!"), /not a valid key name/)
    const first = store.create("bob")
    assert.throws(() => store.create("bob"), /already exists/)
    const revoked = store.revoke("bob")
    assert.strictEqual(revoked?.id, first.record.id)
    assert.ok(revoked?.revokedAt)
    assert.strictEqual(store.verify(first.key), undefined)
    assert.strictEqual(store.revoke("bob"), undefined)
    const second = store.create("bob")
    assert.notStrictEqual(second.record.id, first.record.id)
    assert.strictEqual(store.revoke(second.record.id)?.name, "bob")
    assert.strictEqual(store.active().length, 0)
    assert.strictEqual(store.list().length, 2)
  })

  test("a store rereads the file when another process changed it", async () => {
    const file = path.join(scratch, "c", "keys.json")
    const writer = KeyStore.open(file)
    const reader = KeyStore.open(file, 0)
    const { key } = writer.create("carol")
    assert.strictEqual(reader.verify(key), undefined, "not yet reread")
    reader.refresh(Date.now() + 10)
    assert.strictEqual(reader.verify(key)?.name, "carol")
    await new Promise((resolve) => setTimeout(resolve, 20))
    writer.revoke("carol")
    reader.refresh(Date.now() + 20)
    assert.strictEqual(reader.verify(key), undefined)
    fs.unlinkSync(file)
    reader.refresh(Date.now() + 30)
    assert.deepStrictEqual(reader.list(), [])
  })

  test("a malformed keys file is refused rather than treated as empty", () => {
    const file = path.join(scratch, "d", "keys.json")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "{ nope")
    assert.throws(() => KeyStore.open(file), /not valid JSON/)
    fs.writeFileSync(file, JSON.stringify({ version: 2, keys: [] }))
    assert.throws(() => KeyStore.open(file), /not a twinny-server keys file/)
  })

  test("the shared token is optional once keys exist, and can be retired", () => {
    const base = {
      providers: { local: { provider: "ollama" } },
      models: [{ alias: "a", provider: "local", model: "m", capabilities: ["fim"] }]
    }
    const config = parseGatewayConfig(base, ["ollama"])
    assert.throws(() => readGatewaySecrets(config, {}, 0), /keys create/)
    assert.deepStrictEqual(readGatewaySecrets(config, {}, 1), { providerKeys: {} })
    assert.strictEqual(readGatewaySecrets(config, { TWINNY_GATEWAY_TOKEN: "t" }, 1).token, "t")

    const retired = parseGatewayConfig({ ...base, auth: { tokenEnv: null } }, ["ollama"])
    assert.strictEqual(retired.auth.tokenEnv, null)
    assert.strictEqual(readGatewaySecrets(retired, { TWINNY_GATEWAY_TOKEN: "t" }, 1).token, undefined)
    assert.throws(() => readGatewaySecrets(retired, {}, 0), /no active keys/)

    const custom = parseGatewayConfig(
      { ...base, auth: { keysFile: "~/x/keys.json" }, usage: { dir: "~/x/usage", retentionDays: 7 } },
      ["ollama"]
    )
    assert.strictEqual(custom.auth.keysFile, path.join(os.homedir(), "x", "keys.json"))
    assert.strictEqual(custom.usage.dir, path.join(os.homedir(), "x", "usage"))
    assert.strictEqual(custom.usage.retentionDays, 7)
    assert.throws(
      () => parseGatewayConfig({ ...base, usage: { retentionDays: 0 } }, ["ollama"]),
      /usage.retentionDays/
    )
  })
})

suite("Gateway usage records", () => {
  test("token counts come from each dialect, and only when reported", () => {
    assert.deepStrictEqual(usageFromResponse({ response: "", done: true, prompt_eval_count: 5, eval_count: 7 }), {
      promptTokens: 5,
      completionTokens: 7
    })
    assert.deepStrictEqual(
      usageFromResponse({ usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }),
      { promptTokens: 3, completionTokens: 4 }
    )
    assert.deepStrictEqual(usageFromResponse({ tokens_evaluated: 9, tokens_predicted: 1 }), {
      promptTokens: 9,
      completionTokens: 1
    })
    assert.strictEqual(usageFromResponse({ response: "hi", done: false }), undefined)
    assert.strictEqual(usageFromResponse(undefined), undefined)
    assert.deepStrictEqual(usageFromEmbeddingResponse({ prompt_eval_count: 11 }), { promptTokens: 11 })
    assert.deepStrictEqual(usageFromEmbeddingResponse({ usage: { prompt_tokens: 2 } }), { promptTokens: 2 })
    assert.strictEqual(usageFromEmbeddingResponse({}), undefined)
  })

  test("records land in a per-day file and the summary groups them", async () => {
    const dir = path.join(scratch, "usage-a")
    const recorder = new UsageRecorder(dir, 30)
    recorder.start()
    recorder.record({ key: "alice", route: "fim", alias: "coder", outcome: "ok", status: 200, ms: 100, usage: { promptTokens: 10, completionTokens: 2 } })
    recorder.record({ key: "alice", route: "chat", alias: "chat", outcome: "error", kind: "timeout", status: 504, ms: 5000 })
    recorder.record({ key: "bob", route: "fim", alias: "coder", outcome: "cancelled", kind: "cancelled", status: 200, ms: 40 })
    recorder.record({ key: "shared", route: "embeddings", alias: "embed", outcome: "ok", status: 200, ms: 20, usage: { promptTokens: 4 } })
    await recorder.stop()

    const files = fs.readdirSync(dir)
    assert.deepStrictEqual(files, [`${dayOf(new Date())}.jsonl`])
    const lines = fs.readFileSync(path.join(dir, files[0]), "utf8").trim().split("\n")
    assert.strictEqual(lines.length, 4)
    const first = JSON.parse(lines[0])
    assert.deepStrictEqual(Object.keys(first).sort(), ["alias", "completionTokens", "key", "ms", "outcome", "promptTokens", "route", "status", "ts"])

    const summary = summarizeUsage(dir, new Date(Date.now() - 60_000))
    assert.strictEqual(summary.total.requests, 4)
    assert.strictEqual(summary.total.ok, 2)
    assert.strictEqual(summary.total.failed, 1)
    assert.strictEqual(summary.total.cancelled, 1)
    assert.strictEqual(summary.total.promptTokens, 14)
    assert.strictEqual(summary.total.completionTokens, 2)
    assert.strictEqual(summary.total.counted, 2)
    assert.strictEqual(summary.byKey.alice.requests, 2)
    assert.strictEqual(summary.byKey.alice.failed, 1)
    assert.strictEqual(summary.byModel.coder.requests, 2)
    assert.strictEqual(summary.byKeyAndModel.bob.coder.cancelled, 1)
    assert.strictEqual(summarizeUsage(dir, new Date(Date.now() + 60_000)).total.requests, 0)
  })

  test("files past the retention are deleted, current ones kept", () => {
    const dir = path.join(scratch, "usage-b")
    fs.mkdirSync(dir, { recursive: true })
    const today = dayOf(new Date())
    const old = dayOf(new Date(Date.now() - 40 * 24 * 3_600_000))
    fs.writeFileSync(path.join(dir, `${today}.jsonl`), "")
    fs.writeFileSync(path.join(dir, `${old}.jsonl`), "")
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep me")
    const removed = new UsageRecorder(dir, 30).sweep()
    assert.deepStrictEqual(removed, [`${old}.jsonl`])
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), [`${today}.jsonl`, "notes.txt"])
  })

  test("periods parse as relative durations or dates", () => {
    const now = new Date("2026-09-14T12:00:00Z")
    assert.strictEqual(parseSince("7d", now).toISOString(), "2026-09-07T12:00:00.000Z")
    assert.strictEqual(parseSince("24h", now).toISOString(), "2026-09-13T12:00:00.000Z")
    assert.strictEqual(parseSince("30m", now).toISOString(), "2026-09-14T11:30:00.000Z")
    assert.strictEqual(parseSince("2026-09-01", now).toISOString(), "2026-09-01T00:00:00.000Z")
    assert.throws(() => parseSince("yesterday", now), /not a period/)
  })
})

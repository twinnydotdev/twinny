/**
 * The usage summary: embedding calls are grouped into indexing runs so a
 * workspace index does not read as hundreds of requests.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { RUN_GAP_MS, summarizeUsage, UsageRecord } from "../../gateway/usage"

const base = Date.UTC(2026, 8, 15, 10, 0, 0)

const record = (offsetMs: number, extra: Partial<UsageRecord> = {}): UsageRecord => ({
  ts: new Date(base + offsetMs).toISOString(),
  key: "alice",
  route: "embeddings",
  alias: "embed",
  outcome: "ok",
  status: 200,
  ms: 100,
  inputs: 16,
  ...extra
})

const write = (records: UsageRecord[]): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-usage-test-"))
  fs.writeFileSync(path.join(dir, "2026-09-15.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  return dir
}

suite("gateway usage summary", () => {
  test("embedding calls in a row are one run, counted as one request", () => {
    const dir = write([
      record(0, { route: "chat", alias: "coder", inputs: undefined, ms: 500 }),
      ...Array.from({ length: 30 }, (_, i) => record(1_000 + i * 1_000)),
      record(1_000 + 30 * 1_000 + RUN_GAP_MS + 1),
      record(2_000, { key: "bob" })
    ])
    const summary = summarizeUsage(dir, new Date(base - 1), new Date(base + 60 * 60 * 1000))
    assert.strictEqual(summary.total.requests, 4, "one chat, two runs for alice, one for bob")
    assert.strictEqual(summary.total.ok, 4)
    assert.deepStrictEqual(summary.total.indexing, { runs: 3, calls: 32, texts: 32 * 16 })
    assert.strictEqual(summary.byKey.alice.requests, 3)
    assert.deepStrictEqual(summary.byKey.alice.indexing, { runs: 2, calls: 31, texts: 31 * 16 })
    assert.strictEqual(summary.byKey.bob.requests, 1)
    assert.strictEqual(summary.byModel.embed.requests, 3)
    assert.strictEqual(summary.byModel.coder.requests, 1)
    assert.strictEqual(summary.byKeyAndModel.alice.embed.indexing.runs, 2)
    assert.strictEqual(summary.byDay[0].requests, 4)
    assert.deepStrictEqual(summary.byDay[0].byKey, { alice: 3, bob: 1 })
    // A run's duration is its calls' added up.
    assert.strictEqual(summary.byKey.bob.ms, 100)
    assert.strictEqual(summary.byKey.alice.ms, 500 + 31 * 100)
  })

  test("a run fails once any of its calls does, and counts once", () => {
    const dir = write([
      record(0),
      record(1_000, { outcome: "error", kind: "rate-limited", status: 429 }),
      record(2_000, { outcome: "error", kind: "rate-limited", status: 429 }),
      record(3_000)
    ])
    const summary = summarizeUsage(dir, new Date(base - 1), new Date(base + 60_000))
    assert.strictEqual(summary.total.requests, 1)
    assert.strictEqual(summary.total.ok, 0)
    assert.strictEqual(summary.total.failed, 1)
    assert.strictEqual(summary.total.indexing.calls, 4)
  })

  test("runs served by teammates' computers are grouped per computer", () => {
    const dir = write([
      record(0, { peer: "bob@box" }),
      record(1_000, { peer: "carol@box" }),
      record(2_000, { peer: "bob@box" })
    ])
    const summary = summarizeUsage(dir, new Date(base - 1), new Date(base + 60_000))
    assert.strictEqual(summary.total.requests, 1)
    assert.strictEqual(summary.byPeer["bob@box"].requests, 1)
    assert.strictEqual(summary.byPeer["bob@box"].indexing.calls, 2)
    assert.strictEqual(summary.byPeer["carol@box"].requests, 1)
  })
})

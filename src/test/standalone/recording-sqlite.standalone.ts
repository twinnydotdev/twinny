/**
 * The sqlite recording store, run with plain Node (`npm run test:sqlite`)
 * rather than inside the VS Code test host, whose Node predates
 * `node:sqlite`. Skips itself where the module is missing.
 */
import * as assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { loadSqlite, newRecordingId, openRecordingStore, RecordingRecord, sqliteAvailable, SqliteRecordingStore } from "../../gateway/recording/store"

const record = (over: Partial<RecordingRecord> = {}): RecordingRecord => ({
  id: newRecordingId(new Date(over.at ?? "2026-09-15T10:00:00Z")),
  at: "2026-09-15T10:00:00.000Z",
  key: "alice",
  route: "chat",
  alias: "coder",
  model: "m",
  provider: "local",
  outcome: "ok",
  ended: "client",
  ms: 5,
  usage: { promptTokens: 3, completionTokens: 2 },
  request: { messages: [{ role: "user", content: "Hello World" }] },
  response: { content: "hi" },
  ...over
})

test("sqlite store: append, list, page, filter, search, get, count, each, keys, prune", { skip: !sqliteAvailable() && "node:sqlite not available" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-sqlite-"))
  const store = openRecordingStore("auto", dir)
  assert.strictEqual(store.kind, "sqlite")
  assert.ok(store instanceof SqliteRecordingStore)
  for (let day = 13; day <= 15; day++) {
    for (let i = 0; i < 3; i++) {
      store.append(
        record({
          at: `2026-09-${day}T1${i}:00:00.000Z`,
          key: i === 0 ? "bob" : "alice",
          route: i === 2 ? "fim" : "chat",
          request: i === 2 ? { prompt: `p${day}`, suffix: "" } : { messages: [{ role: "user", content: `hello ${day} ${i}` }] },
          response: i === 2 ? { text: "done" } : { content: `reply ${i}` }
        })
      )
    }
  }
  assert.strictEqual(store.count(), 9)
  assert.strictEqual(store.count({ route: "fim" }), 3)
  assert.strictEqual(store.count({ key: "bob" }), 3)
  assert.deepStrictEqual(store.keys(), ["alice", "bob"])

  const first = store.list({ limit: 4 })
  assert.strictEqual(first.records.length, 4)
  assert.ok(first.records[0].at > first.records[3].at)
  assert.ok(first.nextBefore)
  const second = store.list({ limit: 4, before: first.nextBefore })
  assert.strictEqual(second.records.length, 4)
  const third = store.list({ limit: 4, before: second.nextBefore })
  assert.strictEqual(third.records.length, 1)
  assert.strictEqual(third.nextBefore, undefined)

  assert.strictEqual(store.list({ search: "HELLO 14 1" }).records.length, 1)
  assert.strictEqual(store.list({ search: "100%" }).records.length, 0, "LIKE wildcards are escaped")
  assert.strictEqual(store.list({ since: new Date("2026-09-15T00:00:00Z") }).records.length, 3)

  const one = store.get(first.records[0].id)
  assert.ok(one)
  assert.deepStrictEqual(one.response, { text: "done" })
  assert.deepStrictEqual(one.usage, { promptTokens: 3, completionTokens: 2 })
  assert.strictEqual(one.provider, "local")
  assert.strictEqual(one.ended, "client")
  assert.strictEqual(first.records[0].ended, "client")
  const all = [...store.each()]
  assert.strictEqual(all.length, 9)
  assert.ok(all[0].at < all[8].at)

  assert.strictEqual(store.prune(new Date("2026-09-15T00:00:00Z")), 6)
  assert.strictEqual(store.count(), 3)
  store.append(record({ at: "2026-09-15T13:00:00.000Z", outcome: "error", response: { content: "" } }))
  assert.strictEqual(store.count({ outcome: "error" }), 1)
  assert.strictEqual(store.list({ outcome: "ok" }).records.length, 3)
  store.close()

  // Reopening sees the same rows.
  const again = openRecordingStore("sqlite", dir)
  assert.strictEqual(again.count(), 4)
  again.close()
  assert.strictEqual(openRecordingStore("jsonl", dir).kind, "jsonl")
})

test("sqlite store: chat records carry their conversation's thread, old rows get one on open", { skip: !sqliteAvailable() && "node:sqlite not available" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-sqlite-thread-"))
  const opener = { role: "user", content: "fix the build" }
  const steps = [
    { messages: [{ role: "system", content: "s" }, opener] },
    { messages: [{ role: "system", content: "s" }, opener, { role: "assistant", content: "", tool_calls: [] }, { role: "tool", content: "ok" }] },
    { messages: [{ role: "system", content: "s2" }, opener, { role: "assistant", content: "done" }, { role: "user", content: "[For reference: …]\nnotes\n\n[The user's new message:]\nand the tests?" }] }
  ]
  const store = openRecordingStore("sqlite", dir) as SqliteRecordingStore
  steps.forEach((request, i) => store.append(record({ at: `2026-09-15T10:00:0${i}.000Z`, request })))
  store.append(record({ at: "2026-09-15T10:00:05.000Z", request: { messages: [{ role: "user", content: "something else" }] } }))
  store.append(record({ at: "2026-09-15T10:00:06.000Z", route: "fim", request: { prompt: "a", suffix: "" }, response: { text: "b" } }))
  const rows = store.list().records
  assert.strictEqual(rows[0].thread, undefined, "autocomplete has no thread")
  assert.ok(rows[1].thread && rows[1].thread !== rows[2].thread)
  assert.strictEqual(new Set(rows.slice(2).map((r) => r.thread)).size, 1, "every step and turn of one conversation")
  assert.strictEqual(rows[2].preview, "and the tests?", "the tool notes are not the preview")

  // A database from before threads: the column empty, the preview as it was.
  const db = new (loadSqlite()!.DatabaseSync)(path.join(dir, "recordings.sqlite"))
  db.exec("UPDATE recordings SET thread = NULL, preview = 'old'")
  db.close()
  store.close()
  const reopened = openRecordingStore("sqlite", dir)
  const again = reopened.list().records
  assert.deepStrictEqual(again.map((r) => r.thread), rows.map((r) => r.thread))
  assert.strictEqual(again[2].preview, "and the tests?")
  assert.strictEqual(again[0].preview, "old", "only chat rows are backfilled")
  reopened.close()
})

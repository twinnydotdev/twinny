/**
 * Backups of the sqlite recording store, run with plain Node
 * (`npm run test:sqlite`) since the VS Code test host's Node predates
 * `node:sqlite`. Skips itself where the module is missing.
 */
import * as assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { buildArchive, collectFiles, openArchive, restoreArchive } from "../../gateway/plugins/backups/archive"
import type { GatewayPaths } from "../../gateway/plugins/host"
import { newRecordingId, RecordingRecord, sqliteAvailable, SqliteRecordingStore } from "../../gateway/recording/store"

const layout = (name: string): GatewayPaths => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `twinny-backup-sqlite-${name}-`))
  return {
    dataDir,
    keysFile: path.join(dataDir, "keys.json"),
    licenseFile: path.join(dataDir, "license"),
    usageDir: path.join(dataDir, "usage"),
    recordingsDir: path.join(dataDir, "recordings")
  }
}

const record = (i: number): RecordingRecord => ({
  id: newRecordingId(new Date(Date.UTC(2026, 8, 15, 10, 0, i))),
  at: new Date(Date.UTC(2026, 8, 15, 10, 0, i)).toISOString(),
  key: "alice",
  route: "chat",
  alias: "coder",
  outcome: "ok",
  ms: 5,
  request: { messages: [{ role: "user", content: `question ${i}` }] },
  response: { content: "x".repeat(2_000) }
})

test(
  "a backup of a live WAL-mode recording store is one consistent database, and a restore drops a stale WAL",
  { skip: !sqliteAvailable() && "node:sqlite not available" },
  () => {
    const from = layout("from")
    const live = new SqliteRecordingStore(path.join(from.recordingsDir, "recordings.sqlite"))
    for (let i = 0; i < 50; i++) live.append(record(i))
    // The store stays open: the rows sit in recordings.sqlite-wal, not in the main file.
    assert.ok(fs.existsSync(path.join(from.recordingsDir, "recordings.sqlite-wal")))

    const entries = collectFiles(from, true)
    const names = entries.map((entry) => entry.name)
    assert.ok(names.includes("recordings/recordings.sqlite"), names.join(", "))
    assert.ok(!names.some((name) => /\.sqlite-(wal|shm)$/.test(name)), names.join(", "))
    assert.ok(!fs.readdirSync(from.recordingsDir).some((name) => name.endsWith(".snapshot")), "the snapshot is removed")

    const to = layout("to")
    fs.mkdirSync(to.recordingsDir, { recursive: true })
    fs.writeFileSync(path.join(to.recordingsDir, "recordings.sqlite-wal"), "stale frames")
    const built = buildArchive(from, { includeRecordings: true })
    restoreArchive(openArchive(built.data), to)
    assert.ok(!fs.existsSync(path.join(to.recordingsDir, "recordings.sqlite-wal")), "stale -wal removed")

    const restored = new SqliteRecordingStore(path.join(to.recordingsDir, "recordings.sqlite"))
    assert.strictEqual(restored.count({}), 50)
    restored.close()
    live.close()
  }
)

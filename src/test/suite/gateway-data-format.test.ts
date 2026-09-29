/**
 * The data directory's format marker: written for a fresh or a legacy
 * directory, migrations run in order and resume, a newer directory is
 * refused.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import {
  DATA_FORMAT,
  DATA_FORMAT_FILE,
  DataFormatError,
  DataMigration,
  openDataDir
} from "../../gateway/data-format"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-data-format-"))
let n = 0
const fresh = () => path.join(scratch, `dir-${n++}`)

const readMarker = (dir: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, DATA_FORMAT_FILE), "utf8")) as { format: number; server: string; writtenAt: string }

suite("Gateway data format", () => {
  test("a fresh directory is created and marked with the current format", () => {
    const dir = fresh()
    const opened = openDataDir(dir, { server: "4.2.0", now: () => new Date("2026-09-21T10:00:00Z") })
    assert.deepStrictEqual(opened, { format: DATA_FORMAT, legacy: false, migrated: [] })
    assert.deepStrictEqual(readMarker(dir), { format: DATA_FORMAT, server: "4.2.0", writtenAt: "2026-09-21T10:00:00.000Z" })
    assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700)
  })

  test("a directory from before the marker is taken as format 1 and marked", () => {
    const dir = fresh()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "keys.json"), "[]")
    const opened = openDataDir(dir, { server: "4.2.0" })
    assert.strictEqual(opened.legacy, true)
    assert.strictEqual(opened.format, DATA_FORMAT)
    assert.strictEqual(readMarker(dir).format, DATA_FORMAT)
  })

  test("reopening reports the previous format and rewrites only when the server changed", () => {
    const dir = fresh()
    openDataDir(dir, { server: "4.2.0", now: () => new Date("2026-09-21T10:00:00Z") })
    const again = openDataDir(dir, { server: "4.2.0", now: () => new Date("2026-09-22T10:00:00Z") })
    assert.strictEqual(again.previous, DATA_FORMAT)
    assert.strictEqual(readMarker(dir).writtenAt, "2026-09-21T10:00:00.000Z")
    openDataDir(dir, { server: "4.2.1", now: () => new Date("2026-09-23T10:00:00Z") })
    assert.deepStrictEqual(readMarker(dir), { format: DATA_FORMAT, server: "4.2.1", writtenAt: "2026-09-23T10:00:00.000Z" })
  })

  test("a newer directory is refused and left alone", () => {
    const dir = fresh()
    fs.mkdirSync(dir, { recursive: true })
    const marker = JSON.stringify({ format: DATA_FORMAT + 1, server: "9.9.9", writtenAt: "x" })
    fs.writeFileSync(path.join(dir, DATA_FORMAT_FILE), marker)
    assert.throws(
      () => openDataDir(dir, { server: "4.2.0" }),
      (error: unknown) =>
        error instanceof DataFormatError &&
        error.code === "newer" &&
        new RegExp(`data format ${DATA_FORMAT + 1}, version 9\\.9\\.9; this version reads format ${DATA_FORMAT}`).test(error.message)
    )
    assert.strictEqual(fs.readFileSync(path.join(dir, DATA_FORMAT_FILE), "utf8"), marker)
  })

  test("a marker that is not one says what to do", () => {
    const dir = fresh()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, DATA_FORMAT_FILE), "{ not json")
    assert.throws(
      () => openDataDir(dir, { server: "4.2.0" }),
      (error: unknown) => error instanceof DataFormatError && error.code === "unreadable" && /delete the file/.test(error.message)
    )
  })

  test("migrations run in order from the format found, the marker follows each, and a failure resumes", () => {
    const dir = fresh()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, DATA_FORMAT_FILE), JSON.stringify({ format: 1, server: "4.2.0", writtenAt: "x" }))
    const steps: string[] = []
    const events: string[] = []
    let failAt3 = true
    const migrations: DataMigration[] = [
      { to: 3, describe: "three", run: () => { if (failAt3) throw new Error("disk full"); steps.push("3") } },
      { to: 2, describe: "two", run: (d) => { fs.writeFileSync(path.join(d, "two"), ""); steps.push("2") } }
    ]
    const log = (event: string, fields: Record<string, string | number>) => events.push(`${event} ${fields.from}->${fields.to}`)
    assert.throws(() => openDataDir(dir, { server: "4.2.0", migrations, target: 3, log }), /disk full/)
    assert.deepStrictEqual(steps, ["2"])
    assert.strictEqual(readMarker(dir).format, 2, "the marker records the last migration that finished")
    failAt3 = false
    const opened = openDataDir(dir, { server: "4.2.0", migrations, target: 3, log })
    assert.deepStrictEqual(steps, ["2", "3"], "the finished migration is not run again")
    assert.deepStrictEqual(opened, { format: 3, previous: 2, legacy: false, migrated: [3] })
    assert.deepStrictEqual(events, ["data.migrate 1->2", "data.migrate 2->3", "data.migrate 2->3"])
    assert.ok(fs.existsSync(path.join(dir, "two")))
  })
})

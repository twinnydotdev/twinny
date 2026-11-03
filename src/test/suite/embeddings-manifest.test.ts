import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { EmbeddingDatabase, IndexManifest } from "../../extension/embeddings/database"

const manifest = (generation: number): IndexManifest => ({
  version: 3,
  model: "fixture-model",
  dimensions: 3,
  files: {
    "notes.md": { hash: String(generation), size: generation, mtimeMs: generation, chunks: 1 }
  },
  updatedAt: generation
})

const withStore = async (
  run: (db: EmbeddingDatabase, dir: string) => Promise<void>
) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-manifest-"))
  try {
    await run(new EmbeddingDatabase(dir), dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

suite("Embeddings: manifest publication", () => {
  test("concurrent saves all finish and publish the last submitted snapshot", async () => {
    await withStore(async (db, dir) => {
      const submitted = Array.from({ length: 40 }, (_, i) => manifest(i))
      const results = await Promise.allSettled(submitted.map((value) => db.saveManifest(value)))
      assert.deepStrictEqual(results.filter((result) => result.status === "rejected"), [])
      const last = submitted[submitted.length - 1]
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")), last)
      assert.deepStrictEqual(db.manifest, last)
      assert.deepStrictEqual(fs.readdirSync(dir), ["manifest.json"])
    })
  })

  test("overlapping callers retain independent file updates through earlier saves", async () => {
    await withStore(async (db, dir) => {
      await db.saveManifest(manifest(0))
      let resume!: () => void
      const waiting = new Promise<void>((resolve) => { resume = resolve })
      const updateA = (async () => {
        const current = db.manifest!
        await waiting
        current.files["a.md"] = manifest(1).files["notes.md"]
        await db.saveManifest(current)
      })()
      const updateB = db.manifest!
      updateB.files["b.md"] = manifest(2).files["notes.md"]
      await db.saveManifest(updateB)
      const updateC = db.manifest!
      updateC.files["c.md"] = manifest(3).files["notes.md"]
      await db.saveManifest(updateC)
      resume()
      await updateA
      assert.deepStrictEqual(Object.keys(db.manifest!.files).sort(), ["a.md", "b.md", "c.md", "notes.md"])
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")), db.manifest)
    })
  })

  test("disk bytes are snapshotted without replacing the shared live object", async () => {
    await withStore(async (db, dir) => {
      const submitted = manifest(1)
      const saved = db.saveManifest(submitted)
      submitted.model = "changed-by-caller"
      submitted.files["notes.md"].chunks = 99
      await saved
      assert.strictEqual(db.manifest, submitted)
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")), manifest(1))
    })
  })

  test("a failed rename cleans its temporary file and does not poison later saves", async () => {
    await withStore(async (db, dir) => {
      await db.saveManifest(manifest(1))
      // A directory at the destination deterministically refuses replacement
      // on every platform without relying on process privileges.
      const destination = path.join(dir, "manifest.json")
      fs.unlinkSync(destination)
      fs.mkdirSync(destination)
      const submitted = manifest(2)
      await assert.rejects(db.saveManifest(submitted))
      assert.strictEqual(db.manifest, submitted, "the existing live cache is not a rollback transaction")
      assert.deepStrictEqual(fs.readdirSync(dir), ["manifest.json"], "failed save removes its temporary file")
      fs.rmdirSync(destination)
      await db.saveManifest(manifest(3))
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(destination, "utf8")), manifest(3))
      assert.deepStrictEqual(db.manifest, manifest(3))
    })
  })
})

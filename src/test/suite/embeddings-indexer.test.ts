import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type * as vscode from "vscode"

import { EmbeddingDatabase } from "../../extension/embeddings/database"
import { Embedder } from "../../extension/embeddings/embedder"
import { WorkspaceIndexer } from "../../extension/embeddings/indexer"
import { keywordQuery } from "../../extension/embeddings/rank"

const withIndex = async (
  run: (indexer: WorkspaceIndexer, db: EmbeddingDatabase, file: string, dir: string) => Promise<void>
) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-empty-file-"))
  const file = path.join(dir, "notes.md")
  const kept = path.join(dir, "keep.md")
  fs.writeFileSync(file, "obsoletequartz document content that should disappear after the file is cleared.\n")
  fs.writeFileSync(kept, "retainedsapphire document content that stays indexed.\n")
  const db = new EmbeddingDatabase(path.join(dir, "database"))
  const context = { globalState: { get: () => undefined } } as unknown as vscode.ExtensionContext
  const embedder = {
    model: "fixture-model",
    provider: {},
    parallel: 1,
    embed: async (inputs: string[]) => inputs.map(() => [0.1, 0.2, 0.3])
  } as unknown as Embedder
  // Supply the editor's file discovery boundary; the real indexer still reads,
  // chunks, embeds and persists both files through its public run method.
  const indexer = new WorkspaceIndexer(context, db, embedder)
  Object.assign(indexer, {
    isIndexable: () => true,
    scanWorkspace: async () => [file, kept].map((entry) => {
      const stats = fs.statSync(entry)
      return {
        file: entry,
        relative: path.basename(entry),
        size: stats.size,
        mtimeMs: stats.mtimeMs
      }
    })
  })
  try {
    await db.connect()
    const result = await indexer.run({ mode: "rebuild" })
    assert.strictEqual(result.embedded, 2)
    assert.ok(db.manifest.files[file])
    assert.ok((await db.textSearch(keywordQuery("obsoletequartz"), 5)).some((hit) => hit.file === file))
    await run(indexer, db, file, dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

suite("Embeddings: empty saved files", () => {
  test("removes previously indexed chunks and the persisted stamp when a file becomes empty", async function () {
    this.timeout(30000)
    await withIndex(async (indexer, db, file, dir) => {
      fs.writeFileSync(file, "")
      assert.strictEqual(await indexer.updateFile(file), true)
      assert.strictEqual(db.manifest.files[file], undefined)
      const persisted = JSON.parse(fs.readFileSync(path.join(dir, "database", "manifest.json"), "utf8"))
      assert.strictEqual(persisted.files[file], undefined)
      assert.deepStrictEqual(await db.textSearch(keywordQuery("obsoletequartz"), 5), [])
      const vectors = await db.vectorSearch([0.1, 0.2, 0.3], 5)
      assert.ok(vectors.length > 0, "another file remains searchable")
      assert.ok(vectors.every((hit) => hit.file !== file))
      assert.strictEqual(await indexer.updateFile(file), false, "repeated empty saves are a no-op")
    })
  })

  test("an empty file that was never indexed does not change the existing index", async function () {
    this.timeout(30000)
    await withIndex(async (indexer, db, _file, dir) => {
      const empty = path.join(dir, "empty.md")
      fs.writeFileSync(empty, "")
      const before = JSON.stringify(db.manifest)
      assert.strictEqual(await indexer.updateFile(empty), false)
      assert.strictEqual(JSON.stringify(db.manifest), before)
      assert.strictEqual(await db.countChunks(), 2)
    })
  })

  test("a stat failure preserves previously indexed content", async function () {
    this.timeout(30000)
    await withIndex(async (indexer, db, file) => {
      fs.unlinkSync(file)
      const before = JSON.stringify(db.manifest)
      assert.strictEqual(await indexer.updateFile(file), false)
      assert.strictEqual(JSON.stringify(db.manifest), before)
      assert.ok((await db.textSearch(keywordQuery("obsoletequartz"), 5)).some((hit) => hit.file === file))
    })
  })
})

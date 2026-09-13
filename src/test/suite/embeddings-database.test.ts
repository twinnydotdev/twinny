import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { EmbeddingDatabase } from "../../extension/embeddings/database"

const row = (file: string, content: string, seed: number) => ({
  file,
  content,
  startLine: 1,
  endLine: 2,
  vector: [seed, 1 - seed, 0.5]
})

suite("Embeddings: database", () => {
  test("keyword search builds the missing index instead of failing", async function () {
    this.timeout(30000)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-db-"))
    const db = new EmbeddingDatabase(dir)
    try {
      await db.connect()
      // An index run that died before finishWrites: rows, no keyword index.
      await db.replaceFiles([], [
        row("src/a.ts", "connection details are loaded here", 0.1),
        row("src/b.ts", "function unrelated() {}", 0.9)
      ])
      const hits = await db.textSearch("connection details", 5)
      assert.deepStrictEqual(hits.map((hit) => hit.file), ["src/a.ts"])
      // And the repair sticks: the next search needs no rebuild.
      const again = await db.textSearch("unrelated", 5)
      assert.deepStrictEqual(again.map((hit) => hit.file), ["src/b.ts"])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { EmbeddingDatabase } from "../../extension/embeddings/database"
import { keywordQuery, keywordText, pathKeywords } from "../../extension/embeddings/rank"

const row = (file: string, content: string, seed: number, part = 0, startLine = 1) => ({
  file,
  content,
  startLine,
  endLine: startLine + 1,
  keywords: `${pathKeywords(file)} ${keywordText(content)}`,
  part,
  vector: [seed, 1 - seed, 0.5]
})

const withDb = async (run: (db: EmbeddingDatabase) => Promise<void>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-db-"))
  const db = new EmbeddingDatabase(dir)
  try {
    await db.connect()
    await run(db)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

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
      const hits = await db.textSearch(keywordQuery("connection details"), 5)
      assert.deepStrictEqual(hits.map((hit) => hit.file), ["src/a.ts"])
      // And the repair sticks: the next search needs no rebuild.
      const again = await db.textSearch(keywordQuery("unrelated"), 5)
      assert.deepStrictEqual(again.map((hit) => hit.file), ["src/b.ts"])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("keyword search finds identifiers by their words, plurals and file names", async function () {
    this.timeout(30000)
    await withDb(async (db) => {
      await db.replaceFiles([], [
        row("src/extension/status-bar.ts", "const statusBar = window.createStatusBarItem()", 0.1),
        row("src/main/csp.ts", "export const policy = `default-src 'self'`", 0.5),
        row("src/other.ts", "function unrelated() { return chunks.length }", 0.9)
      ])
      await db.finishWrites()
      const files = async (question: string) =>
        (await db.textSearch(keywordQuery(question), 5)).map((hit) => hit.file)
      assert.strictEqual((await files("status bar"))[0], "src/extension/status-bar.ts")
      assert.strictEqual((await files("statusBar"))[0], "src/extension/status-bar.ts")
      assert.strictEqual((await files("csp"))[0], "src/main/csp.ts")
      // Stemming: "chunk" finds "chunks".
      assert.strictEqual((await files("chunk"))[0], "src/other.ts")
    })
  })

  test("a chunk stored in several windows is one candidate", async function () {
    this.timeout(30000)
    await withDb(async (db) => {
      await db.replaceFiles([], [
        row("src/a.ts", "first half of a long chunk", 0.1, 0),
        row("src/a.ts", "first half of a long chunk", 0.2, 1),
        row("src/b.ts", "another chunk", 0.9, 0, 10)
      ])
      await db.finishWrites()
      const nearest = await db.vectorSearch([0.15, 0.85, 0.5], 2)
      assert.deepStrictEqual(
        nearest.map((hit) => `${hit.file}:${hit.startLine}`),
        ["src/a.ts:1", "src/b.ts:10"]
      )
      const words = await db.textSearch(keywordQuery("long chunk"), 5)
      assert.strictEqual(words.filter((hit) => hit.file === "src/a.ts").length, 1)
    })
  })
})

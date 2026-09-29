import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { EmbeddingDatabase } from "../../extension/embeddings/database"
import { Embedder } from "../../extension/embeddings/embedder"
import { SyntaxLike } from "../../extension/embeddings/expand"
import { Candidate } from "../../extension/embeddings/rank"
import { Reranker } from "../../extension/embeddings/reranker"
import {
  FileParser,
  SearchOptions,
  SearchProgress,
  WorkspaceSearch
} from "../../extension/embeddings/search"

const chunk = (file: string, startLine: number, score: number): Candidate & { score: number } => ({
  file,
  content: `chunk ${file}:${startLine}`,
  startLine,
  endLine: startLine + 4,
  score
})

/**
 * A search over fakes: the database answers with fixed rows, the reranker
 * answers with the score baked into each row's fixture. Only the plumbing
 * around them is under test.
 */
const searchWith = (
  rows: (Candidate & { score: number })[],
  overrides: {
    embedFails?: boolean
    noReranker?: boolean
    /** Sees the file filter of every retrieval. */
    onRetrieve?: (files: string[] | undefined) => void
    parse?: FileParser
  } = {}
) => {
  const db = {
    hasIndex: true,
    vectorSearch: async (_vector: number[], _limit: number, files?: string[]) => {
      overrides.onRetrieve?.(files)
      return rows
        .filter((row) => !files || files.includes(row.file))
        .map(({ file, content, startLine, endLine }) => ({
          file,
          content,
          startLine,
          endLine
        }))
    },
    textSearch: async (_query: string, _limit: number, files?: string[]) => {
      overrides.onRetrieve?.(files)
      return []
    }
  } as unknown as EmbeddingDatabase
  const embedder = {
    embedOne: async () => {
      if (overrides.embedFails) throw new Error("connection refused")
      return [1, 0, 0]
    }
  } as unknown as Embedder
  const reranker = {
    rerank: async (_query: string, passages: string[]) =>
      overrides.noReranker
        ? undefined
        : passages.map(
            (passage) => rows.find((row) => passage.endsWith(row.content))?.score ?? 0
          )
  } as unknown as Reranker
  return new WorkspaceSearch(db, embedder, reranker, overrides.parse ?? (async () => undefined))
}

const options = (extra: Partial<SearchOptions> = {}): SearchOptions => ({
  limit: 5,
  threshold: 0.08,
  maxChars: 10_000,
  ...extra
})

suite("Embeddings: search report", () => {
  test("reports each stage in order with the candidate count", async () => {
    const stages: SearchProgress[] = []
    const search = searchWith([chunk("/w/a.ts", 0, 0.9), chunk("/w/b.ts", 0, 0.5)])
    await search.searchDetailed("question", options({ onProgress: (p) => stages.push(p) }))
    assert.deepStrictEqual(stages, [
      { stage: "embedding" },
      { stage: "retrieving" },
      { stage: "reranking", candidates: 2 }
    ])
  })

  test("splits scored candidates into hits and the best near misses", async () => {
    const search = searchWith([
      chunk("/w/a.ts", 0, 0.9),
      chunk("/w/b.ts", 0, 0.07),
      chunk("/w/c.ts", 0, 0.01),
      chunk("/w/d.ts", 0, 0.05),
      chunk("/w/e.ts", 0, 0.02),
      chunk("/w/f.ts", 0, 0.3)
    ])
    const result = await search.searchDetailed("question", options())
    assert.deepStrictEqual(
      result.hits.map((hit) => hit.file),
      ["/w/a.ts", "/w/f.ts"]
    )
    assert.strictEqual(result.candidates, 6)
    // Highest first, and never more than a few: the point is to say what
    // came closest, not to list the whole rejected pile.
    assert.deepStrictEqual(
      result.nearMisses.map((hit) => [hit.file, hit.score]),
      [["/w/b.ts", 0.07], ["/w/d.ts", 0.05], ["/w/e.ts", 0.02]]
    )
    assert.strictEqual(result.note, undefined)
  })

  test("says so when the embedding server is down, and still searches keywords", async () => {
    const stages: SearchProgress[] = []
    const search = searchWith([], { embedFails: true })
    const result = await search.searchDetailed(
      "question",
      options({ onProgress: (p) => stages.push(p) })
    )
    assert.deepStrictEqual(result.hits, [])
    assert.match(result.note || "", /embedding server/)
    // Retrieval still ran: the keyword pass does not need a vector.
    assert.ok(stages.some((p) => p.stage === "retrieving"))
  })

  test("falls back to retrieval order without a reranker and says so", async () => {
    const search = searchWith(
      [chunk("/w/a.ts", 0, 0), chunk("/w/b.ts", 0, 0)],
      { noReranker: true }
    )
    const result = await search.searchDetailed("question", options())
    assert.deepStrictEqual(result.hits.map((hit) => hit.file), ["/w/a.ts", "/w/b.ts"])
    assert.ok(result.hits[0].score > result.hits[1].score)
    assert.match(result.note || "", /reranker/)
  })

  test("an empty question or a missing index is an empty report", async () => {
    const search = searchWith([chunk("/w/a.ts", 0, 0.9)])
    assert.deepStrictEqual(await search.searchDetailed("   ", options()), {
      hits: [],
      candidates: 0,
      nearMisses: []
    })
  })

  test("search() is the hits alone", async () => {
    const search = searchWith([chunk("/w/a.ts", 0, 0.9)])
    const hits = await search.search("question", options())
    assert.deepStrictEqual(hits.map((hit) => hit.file), ["/w/a.ts"])
  })
})

suite("Embeddings: focus files and widening", () => {
  test("focus files get their own retrieval pass and reach the reranker", async () => {
    const filters: (string[] | undefined)[] = []
    const search = searchWith([chunk("/w/a.ts", 0, 0.9), chunk("/w/hot.ts", 0, 0.6)], {
      onRetrieve: (files) => filters.push(files)
    })
    const result = await search.searchDetailed(
      "question",
      options({ focus: ["/w/hot.ts"] })
    )
    // Two global passes and two focus passes, the latter restricted.
    assert.deepStrictEqual(
      filters.filter(Boolean),
      [["/w/hot.ts"], ["/w/hot.ts"]]
    )
    assert.deepStrictEqual(
      result.hits.map((hit) => hit.file),
      ["/w/a.ts", "/w/hot.ts"]
    )
  })

  test("no focus files means only the two global passes", async () => {
    const filters: (string[] | undefined)[] = []
    const search = searchWith([chunk("/w/a.ts", 0, 0.9)], {
      onRetrieve: (files) => filters.push(files)
    })
    await search.searchDetailed("question", options())
    assert.deepStrictEqual(filters, [undefined, undefined])
  })

  test("hits are left alone when widening is off or there is no grammar", async () => {
    const search = searchWith([chunk("/w/a.ts", 0, 0.9)])
    const result = await search.searchDetailed("question", options({ expandChars: 3000 }))
    assert.deepStrictEqual(
      result.hits.map((hit) => [hit.startLine, hit.endLine]),
      [[0, 4]]
    )
  })
})

suite("Embeddings: widening against a real file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-widen-"))
  const file = path.join(dir, "c.ts")
  const lines = [
    "import a from \"a\"",
    "",
    "class C {",
    "  one() {",
    "    return 1",
    "  }",
    "}",
    ""
  ]
  fs.writeFileSync(file, lines.join("\n"))
  const node = (type: string, from: number, to: number, children: SyntaxLike[] = []): SyntaxLike => ({
    type,
    startPosition: { row: from },
    endPosition: { row: to },
    children
  })
  let disposed = 0
  const parse: FileParser = async () => ({
    root: node("program", 0, 7, [
      node("import_statement", 0, 0),
      node("class_declaration", 2, 6, [node("method_definition", 3, 5)])
    ]),
    dispose: () => disposed++
  })

  suiteTeardown(() => fs.rmSync(dir, { recursive: true, force: true }))

  test("a hit grows to its definition and the imports trail it", async () => {
    const row = { ...chunk(file, 4, 0.9), content: "    return 1", endLine: 4 }
    const search = searchWith([row], { parse })
    const result = await search.searchDetailed(
      "question",
      options({ expandChars: lines.slice(2, 7).join("\n").length + 5 })
    )
    assert.deepStrictEqual(
      result.hits.map((hit) => [hit.startLine, hit.endLine, hit.kind]),
      [[2, 6, undefined], [0, 0, "imports"]]
    )
    assert.strictEqual(result.hits[0].content, lines.slice(2, 7).join("\n"))
    assert.strictEqual(result.hits[1].content, "import a from \"a\"")
    assert.strictEqual(result.hits[1].score, 0.9)
    assert.strictEqual(disposed, 1)
  })

  test("imports are dropped when the budget is spent on code", async () => {
    const row = { ...chunk(file, 4, 0.9), content: "    return 1", endLine: 4 }
    const search = searchWith([row], { parse })
    const budget = lines.slice(2, 7).join("\n").length
    const result = await search.searchDetailed(
      "question",
      options({ expandChars: budget + 5, maxChars: budget + 5 })
    )
    assert.deepStrictEqual(result.hits.map((hit) => hit.kind), [undefined])
  })
})

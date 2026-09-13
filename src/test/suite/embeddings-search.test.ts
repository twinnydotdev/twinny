import * as assert from "assert"

import { EmbeddingDatabase } from "../../extension/embeddings/database"
import { Embedder } from "../../extension/embeddings/embedder"
import { Candidate } from "../../extension/embeddings/rank"
import { Reranker } from "../../extension/embeddings/reranker"
import {
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
  overrides: { embedFails?: boolean; noReranker?: boolean } = {}
) => {
  const db = {
    hasIndex: true,
    vectorSearch: async () =>
      rows.map(({ file, content, startLine, endLine }) => ({
        file,
        content,
        startLine,
        endLine
      })),
    textSearch: async () => []
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
  return new WorkspaceSearch(db, embedder, reranker)
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

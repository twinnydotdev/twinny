import * as assert from "assert"

import { vectorsFromResponse, withTaskPrefix } from "../../extension/embeddings/embedder"
import {
  Candidate,
  fitHitsToBudget,
  fuseRankings,
  Hit,
  keywordQuery,
  mergeAdjacentHits,
  sigmoid,
  sqlString
} from "../../extension/embeddings/rank"

const candidate = (file: string, startLine: number, endLine = startLine): Candidate => ({
  file,
  content: `chunk ${file} ${startLine}`,
  startLine,
  endLine
})

suite("Embeddings: ranking", () => {
  test("reciprocal rank fusion favours chunks found by both retrievers", () => {
    const a = candidate("a.ts", 0)
    const b = candidate("b.ts", 0)
    const c = candidate("c.ts", 0)
    // a leads the semantic list only; b is second in both; c leads the
    // keyword list only. Two second places beat one first place.
    const fused = fuseRankings([[a, b], [c, b]])
    assert.strictEqual(fused[0].file, "b.ts")
    assert.strictEqual(fused.length, 3)
  })

  test("fusion tolerates an empty list", () => {
    const a = candidate("a.ts", 0)
    assert.deepStrictEqual(fuseRankings([[a], []]), [a])
    assert.deepStrictEqual(fuseRankings([[], []]), [])
  })

  test("sigmoid maps logits to probabilities", () => {
    assert.ok(Math.abs(sigmoid(0) - 0.5) < 1e-9)
    assert.ok(sigmoid(5) > 0.99)
    assert.ok(sigmoid(-5) < 0.01)
  })

  test("adjacent hits from one file merge into a single block", () => {
    const source = Array.from({ length: 10 }, (_, i) => `line ${i}`)
    const hits: Hit[] = [
      { file: "a.ts", content: "line 0\nline 1", startLine: 0, endLine: 1, score: 0.4 },
      { file: "a.ts", content: "line 2\nline 3", startLine: 2, endLine: 3, score: 0.6 },
      { file: "a.ts", content: "line 8", startLine: 8, endLine: 8, score: 0.2 },
      { file: "b.ts", content: "other", startLine: 0, endLine: 0, score: 0.5 }
    ]
    const merged = mergeAdjacentHits(hits, (file) => (file === "a.ts" ? source : undefined))
    assert.strictEqual(merged.length, 3)
    const block = merged.find((hit) => hit.file === "a.ts" && hit.startLine === 0)!
    assert.strictEqual(block.endLine, 3)
    assert.strictEqual(block.content, source.slice(0, 4).join("\n"))
    assert.strictEqual(block.score, 0.6)
    assert.strictEqual(merged[0].score, 0.6, "sorted by score after merging")
  })

  test("budget keeps the best hits that fit", () => {
    const hits: Hit[] = [
      { file: "a", content: "x".repeat(50), startLine: 0, endLine: 0, score: 0.9 },
      { file: "b", content: "x".repeat(80), startLine: 0, endLine: 0, score: 0.8 },
      { file: "c", content: "x".repeat(30), startLine: 0, endLine: 0, score: 0.7 }
    ]
    assert.deepStrictEqual(
      fitHitsToBudget(hits, 100).map((hit) => hit.file),
      ["a", "c"]
    )
  })

  test("keyword query keeps identifiers and splits them into words", () => {
    const query = keywordQuery("where does fetchModelEmbedding call getProviderOrigin?")
    for (const word of ["fetchModelEmbedding", "fetch", "model", "embedding", "provider", "origin"]) {
      assert.ok(query.split(" ").includes(word), `${word} in "${query}"`)
    }
    assert.ok(!query.includes("?"))
    assert.strictEqual(keywordQuery("?? !!"), "")
  })

  test("sql strings escape quotes", () => {
    assert.strictEqual(sqlString("it's"), "'it''s'")
  })
})

suite("Embeddings: embedder", () => {
  test("reads every server dialect in input order", () => {
    assert.deepStrictEqual(
      vectorsFromResponse({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }),
      [[1], [2]]
    )
    assert.deepStrictEqual(vectorsFromResponse({ embeddings: [[1], [2]] }), [[1], [2]])
    assert.deepStrictEqual(vectorsFromResponse({ embedding: [3] }), [[3]])
    assert.deepStrictEqual(vectorsFromResponse({}), [])
  })

  test("adds task prefixes only for models trained with them", () => {
    assert.strictEqual(withTaskPrefix("nomic-embed-text", "query", "q"), "search_query: q")
    assert.strictEqual(withTaskPrefix("nomic-embed-text", "document", "d"), "search_document: d")
    assert.strictEqual(withTaskPrefix("all-minilm", "query", "q"), "q")
  })
})

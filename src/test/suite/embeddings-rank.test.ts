import * as assert from "assert"

import { vectorsFromResponse, withTaskPrefix } from "../../extension/embeddings/embedder"
import {
  Candidate,
  fitHitsToBudget,
  fuseRankings,
  Hit,
  isFollowUp,
  keywordQuery,
  mergeAdjacentHits,
  searchQuery,
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

suite("Embeddings: follow-up questions", () => {
  test("a message with almost nothing to search is a follow-up", () => {
    assert.ok(isFollowUp("why?"))
    assert.ok(isFollowUp("and how is it tested?"))
    assert.ok(isFollowUp("what about caching"))
    assert.ok(isFollowUp("explain this"))
  })

  test("a short message with a pronoun leans on the last one", () => {
    assert.ok(isFollowUp("does that use a cache"))
    assert.ok(isFollowUp("where is it called from"))
  })

  test("a short but self-contained question stands alone", () => {
    assert.ok(!isFollowUp("where is the login handled"))
    assert.ok(!isFollowUp("fix the bug in parseConfig"))
    assert.ok(!isFollowUp("how does the embedding indexer decide what to skip"))
  })

  test("the search text carries the previous question only for a follow-up", () => {
    assert.strictEqual(
      searchQuery("and how is it tested?", "how does the indexer work"),
      "how does the indexer work\nand how is it tested?"
    )
    assert.strictEqual(
      searchQuery("where is the login handled", "how does the indexer work"),
      "where is the login handled"
    )
    assert.strictEqual(searchQuery("why?", undefined), "why?")
    assert.strictEqual(searchQuery("  why?  ", "   "), "why?")
  })

  test("merging keeps a kind only when both sides share it", () => {
    const hit = (startLine: number, endLine: number, kind?: "imports"): Hit => ({
      file: "a.ts",
      content: "",
      startLine,
      endLine,
      score: 0.5,
      kind
    })
    const lines = () => Array.from({ length: 10 }, (_, i) => `line ${i}`)
    const [merged] = mergeAdjacentHits([hit(0, 1, "imports"), hit(2, 4)], lines)
    assert.strictEqual(merged.startLine, 0)
    assert.strictEqual(merged.endLine, 4)
    assert.strictEqual(merged.kind, undefined)
  })
})

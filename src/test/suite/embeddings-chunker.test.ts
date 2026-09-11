import * as assert from "assert"

import {
  chunkText,
  packSegments,
  proseBreaks
} from "../../extension/embeddings/chunker"

const options = { minSize: 20, maxSize: 60, overlap: 15 }

suite("Embeddings: chunker", () => {
  test("chunks are exact line slices with correct ranges", () => {
    const lines = ["function a() {", "  return 1", "}", "", "function b() {", "  return 2", "}"]
    const chunks = packSegments(lines, [[0, 3], [4, 6]], options)
    assert.ok(chunks.length >= 1)
    for (const chunk of chunks) {
      const expected = lines.slice(chunk.startLine, chunk.endLine + 1).join("\n")
      assert.strictEqual(chunk.content, expected)
    }
    // Every line of the file is covered by some chunk.
    const covered = new Set<number>()
    for (const chunk of chunks) {
      for (let i = chunk.startLine; i <= chunk.endLine; i++) covered.add(i)
    }
    assert.strictEqual(covered.size, lines.length)
  })

  test("small segments are packed together, big ones are cut on lines", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`)
    // One segment covering the whole file is larger than maxSize (60 chars)
    // and must be split; each piece stays under the limit.
    const chunks = packSegments(lines, [[0, 11]], options)
    assert.ok(chunks.length > 1)
    for (const chunk of chunks) {
      assert.ok(chunk.content.length <= options.maxSize + options.overlap + 1)
    }
    // Several tiny segments fit into one chunk.
    const packed = packSegments(lines.slice(0, 4), [[0, 0], [1, 1], [2, 2], [3, 3]], options)
    assert.strictEqual(packed.length, 1)
    assert.strictEqual(packed[0].startLine, 0)
    assert.strictEqual(packed[0].endLine, 3)
  })

  test("overlap carries the previous lines into the next chunk", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `l${i}`.padEnd(14, "."))
    const chunks = packSegments(lines, [[0, 9]], { minSize: 5, maxSize: 45, overlap: 16 })
    assert.ok(chunks.length > 1)
    const second = chunks[1]
    assert.ok(second.startLine < chunks[0].endLine + 1, "second chunk starts inside the first")
    assert.ok(second.content.startsWith(lines[second.startLine]))
  })

  test("a chunk shorter than the minimum is folded into the one before", () => {
    const lines = ["const a = 1", "const b = 2", "const c = 3", "x"]
    const chunks = packSegments(lines, [[0, 2], [3, 3]], { minSize: 5, maxSize: 40, overlap: 0 })
    assert.strictEqual(chunks[chunks.length - 1].endLine, 3)
    assert.ok(chunks.every((chunk) => chunk.content.length >= 5))
  })

  test("prose breaks at blank lines and headings", () => {
    const lines = ["# Title", "para one", "still one", "", "para two", "## Sub", "para three"]
    assert.deepStrictEqual(proseBreaks(lines), [0, 4, 5])
  })

  test("prose files chunk by paragraph and never lose text", () => {
    const text = ["# Guide", "", "First paragraph here.", "More of it.", "", "Second paragraph."].join("\n")
    const chunks = chunkText(text, { minSize: 10, maxSize: 40, overlap: 0 })
    assert.ok(chunks.length >= 2)
    const joined = chunks.map((chunk) => chunk.content).join("\n")
    for (const line of text.split("\n").filter(Boolean)) assert.ok(joined.includes(line))
  })

  test("one giant line is cut on characters, keeping its line number", () => {
    const giant = "x".repeat(500)
    const chunks = chunkText(giant, { minSize: 10, maxSize: 100, overlap: 0 })
    assert.strictEqual(chunks.length, 5)
    assert.ok(chunks.every((chunk) => chunk.startLine === 0 && chunk.endLine === 0))
    assert.strictEqual(chunks.map((chunk) => chunk.content).join(""), giant)
  })

  test("whitespace-only input yields nothing", () => {
    assert.deepStrictEqual(chunkText("\n\n  \n", options), [])
    assert.deepStrictEqual(chunkText("", options), [])
  })
})

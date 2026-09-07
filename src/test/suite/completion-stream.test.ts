import * as assert from "assert"

import {
  bracketDelta,
  CompletionStream,
  CompletionStreamOptions
} from "../../extension/completion/stream"

const makeStream = (overrides: Partial<CompletionStreamOptions> = {}) =>
  new CompletionStream({
    stopWords: ["<EOT>"],
    multiline: true,
    maxLines: 40,
    textBeforeCursor: "",
    textAfterCursor: "",
    suffixFirstLine: "",
    ...overrides
  })

/** Feed chunks one at a time and return the final text plus where it stopped. */
const run = (stream: CompletionStream, chunks: string[]) => {
  for (let i = 0; i < chunks.length; i++) {
    const { done, text } = stream.push(chunks[i])
    if (done) return { text, stoppedAt: i, done: true }
  }
  return { text: stream.finish(), stoppedAt: chunks.length, done: false }
}

suite("Completion stream", () => {
  test("bracketDelta ignores brackets in strings and line comments", () => {
    assert.strictEqual(bracketDelta("foo(a, b)"), 0)
    assert.strictEqual(bracketDelta("foo({"), 2)
    assert.strictEqual(bracketDelta("const s = \"{[(\""), 0)
    assert.strictEqual(bracketDelta("const s = '}' + \"(\""), 0)
    assert.strictEqual(bracketDelta("x) // ((("), -1)
    assert.strictEqual(bracketDelta("'\\'(' + 1"), 0)
  })

  test("cuts at the first stop word, even when split across chunks", () => {
    const stream = makeStream({ stopWords: ["<|endoftext|>", "<|file_sep|>"] })
    const result = run(stream, ["foo(", ")<|end", "oftext|>garbage"])
    assert.strictEqual(result.text, "foo()")
    assert.strictEqual(result.done, true)
  })

  test("uses the earliest stop word", () => {
    const stream = makeStream({ stopWords: ["<B>", "<A>"] })
    assert.strictEqual(run(stream, ["x<A>y<B>z"]).text, "x")
  })

  test("gives up on a whitespace-only stream", () => {
    const stream = makeStream()
    const result = run(stream, [" ".repeat(300)])
    assert.strictEqual(result.text, "")
    assert.strictEqual(result.done, true)
  })

  test("single-line mode stops at the first line break after content", () => {
    const stream = makeStream({ multiline: false })
    const result = run(stream, ["foo(a", ", b)\nbar()\n"])
    assert.strictEqual(result.text, "foo(a, b)")
    assert.strictEqual(result.stoppedAt, 1)
  })

  test("single-line mode tolerates a leading line break", () => {
    const stream = makeStream({ multiline: false })
    assert.strictEqual(run(stream, ["\n", "  foo()\n", "bar()"]).text, "\n  foo()")
  })

  test("rejects a completion that starts on the next line when the cursor is mid-line", () => {
    const stream = makeStream({
      multiline: false,
      textBeforeCursor: "const env = process.env.NAME || '",
      textAfterCursor: "'"
    })
    const result = run(stream, ["\n", "if (env === '') {\n"])
    assert.strictEqual(result.text, "")
    assert.strictEqual(result.stoppedAt, 0)
    const multi = makeStream({ textBeforeCursor: "foo(", textAfterCursor: ")" })
    assert.strictEqual(run(multi, ["\n  bar()\n"]).text, "")
  })

  test("still allows a leading line break at the end of a line", () => {
    const stream = makeStream({ multiline: false, textBeforeCursor: "foo()", textAfterCursor: "  " })
    assert.strictEqual(run(stream, ["\n", "bar()\n"]).text, "\nbar()")
  })

  test("returns the whole text when the stream ends naturally", () => {
    const stream = makeStream({ multiline: false })
    assert.strictEqual(run(stream, ["foo(", "a)"]).text, "foo(a)")
  })

  test("multiline: stops at a blank line once outside its own brackets", () => {
    const stream = makeStream({ textBeforeCursor: "" })
    const chunks = ["function foo() {\n", "  return 1\n", "}\n", "\n", "function bar() {}\n"]
    assert.strictEqual(
      run(stream, chunks).text,
      "function foo() {\n  return 1\n}"
    )
  })

  test("multiline: blank lines inside an open bracket do not end it", () => {
    const stream = makeStream({ textBeforeCursor: "const x = " })
    const chunks = ["{\n", "  a: 1,\n", "\n", "  b: 2\n", "}\n", "\n", "next()"]
    assert.strictEqual(
      run(stream, chunks).text,
      "{\n  a: 1,\n\n  b: 2\n}"
    )
  })

  test("multiline: includes the closer of a block opened on the cursor line", () => {
    const stream = makeStream({ textBeforeCursor: "function foo() {" })
    const chunks = ["\n  return 1\n", "}\n", "\nfunction bar() {}"]
    assert.strictEqual(run(stream, chunks).text, "\n  return 1\n}")
  })

  test("multiline: drops a closer the suffix already contains", () => {
    const stream = makeStream({
      textBeforeCursor: "function foo() {",
      suffixFirstLine: "}"
    })
    const chunks = ["\n  return 1\n", "}\n", "more()"]
    assert.strictEqual(run(stream, chunks).text, "\n  return 1")
  })

  test("multiline: stops before a sibling at the cursor line's indent", () => {
    const stream = makeStream({ textBeforeCursor: "  if (x) {" })
    const chunks = ["\n    doA()\n", "  }\n", "  doB()\n"]
    assert.strictEqual(run(stream, chunks).text, "\n    doA()\n  }")
  })

  test("multiline: on a blank line siblings at the same indent belong to the block", () => {
    const stream = makeStream({ textBeforeCursor: "  ", suffixFirstLine: "}" })
    const chunks = ["const x = 1\n", "  const y = 2\n", "  return x + y\n", "}\n"]
    assert.strictEqual(
      run(stream, chunks).text,
      "const x = 1\n  const y = 2\n  return x + y"
    )
  })

  test("multiline: python block ends at the dedent", () => {
    const stream = makeStream({ textBeforeCursor: "def foo():" })
    const chunks = ["\n    x = 1\n", "    return x\n", "\n", "def bar():\n"]
    assert.strictEqual(run(stream, chunks).text, "\n    x = 1\n    return x")
  })

  test("multiline: stops before a closer for a bracket opened above the cursor", () => {
    const stream = makeStream({ textBeforeCursor: "  ", suffixFirstLine: "})" })
    const chunks = ["a: 1,\n", "  b: 2\n", "})\n", "next()"]
    assert.strictEqual(run(stream, chunks).text, "a: 1,\n  b: 2")
  })

  test("multiline: keeps a closer for an outer bracket when the suffix lacks it", () => {
    const stream = makeStream({ textBeforeCursor: "  ", suffixFirstLine: "" })
    const chunks = ["a: 1\n", "}\n", "next()"]
    // The dedent rule wins: `}` is outside the blank line's block.
    assert.strictEqual(run(stream, chunks).text, "a: 1")
  })

  test("multiline: stops when the model reaches the suffix", () => {
    const stream = makeStream({
      textBeforeCursor: "  ",
      suffixFirstLine: "return result"
    })
    const chunks = ["const result = []\n", "  result.push(1)\n", "  return result\n", "}\n"]
    assert.strictEqual(
      run(stream, chunks).text,
      "const result = []\n  result.push(1)"
    )
  })

  test("multiline: a suffix line inside the model's own brackets is not a duplicate", () => {
    const stream = makeStream({ textBeforeCursor: "  ", suffixFirstLine: "break" })
    const chunks = ["for (const x of xs) {\n", "    if (x) break\n", "    break\n", "  }\n", "\n"]
    assert.strictEqual(
      run(stream, chunks).text,
      "for (const x of xs) {\n    if (x) break\n    break\n  }"
    )
  })

  test("multiline: respects the max line limit", () => {
    const stream = makeStream({ maxLines: 3, textBeforeCursor: "" })
    const chunks = ["a\n", "b\n", "c\n", "d\n"]
    assert.strictEqual(run(stream, chunks).text, "a\nb\nc")
  })

  test("finish judges a trailing partial line", () => {
    const stream = makeStream({ textBeforeCursor: "  if (x) {" })
    const result = run(stream, ["\n    doA()\n", "  }\n", "  doB("])
    assert.strictEqual(result.text, "\n    doA()\n  }")
  })

  test("push after done is a no-op", () => {
    const stream = makeStream({ multiline: false })
    stream.push("a\n")
    assert.deepStrictEqual(stream.push("b"), { done: true, text: "a" })
    assert.strictEqual(stream.finish(), "a")
  })
})

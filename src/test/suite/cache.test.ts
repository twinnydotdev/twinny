import * as assert from "assert"

import {
  getSuggestionContinuation,
  LastSuggestion,
  LRUCache
} from "../../extension/completion/cache"

suite("Completion cache", () => {
  test("evicts the least recently used entry", () => {
    const lru = new LRUCache<string>(2)
    lru.set("a", "1")
    lru.set("b", "2")
    lru.get("a")
    lru.set("c", "3")
    assert.strictEqual(lru.get("b"), undefined)
    assert.strictEqual(lru.get("a"), "1")
    assert.strictEqual(lru.get("c"), "3")
  })

  test("keys preserve whitespace and token boundaries", () => {
    const lru = new LRUCache<string>(5)
    lru.setCache({ prefix: "foo  bar\n", suffix: "\n baz" }, "x")
    assert.strictEqual(lru.getCache({ prefix: "foo  bar\n", suffix: "\n baz" }), "x")
    assert.strictEqual(lru.getCache({ prefix: "foo bar", suffix: "baz" }), undefined)
    assert.strictEqual(
      lru.getCache({ prefix: "foobar", suffix: "baz" }),
      undefined
    )
  })

  test("separates documents, providers and document versions", () => {
    const lru = new LRUCache<string>(5)
    const context = { prefix: "const value = ", suffix: "\n" }
    lru.setCache(context, "one", "file-a/model-a/v1")
    assert.strictEqual(lru.getCache(context, "file-a/model-a/v1"), "one")
    for (const scope of ["file-b/model-a/v1", "file-a/model-b/v1", "file-a/model-a/v2"]) {
      assert.strictEqual(lru.getCache(context, scope), undefined)
    }
  })

  test("prefix/suffix delimiter text cannot collide", () => {
    const lru = new LRUCache<string>(5)
    assert.notStrictEqual(
      lru.getKey({ prefix: "a #### b", suffix: "c" }),
      lru.getKey({ prefix: "a", suffix: "b #### c" })
    )
  })

  suite("suggestion continuation", () => {
    const last: LastSuggestion = {
      prefix: "const total = ",
      suffix: "\nexport {}",
      completion: "items.reduce((a, b) => a + b, 0)"
    }

    test("never continues a suggestion from another file or provider", () => {
      const scoped = { ...last, scope: "file-a/model-a" }
      assert.strictEqual(getSuggestionContinuation(scoped, last, scoped.scope), last.completion)
      assert.strictEqual(getSuggestionContinuation(scoped, last, "file-b/model-a"), undefined)
      assert.strictEqual(getSuggestionContinuation(scoped, last, "file-a/model-b"), undefined)
    })

    test("serves the remainder after the user types part of it", () => {
      assert.strictEqual(
        getSuggestionContinuation(last, {
          prefix: "const total = items.red",
          suffix: "\nexport {}"
        }),
        "uce((a, b) => a + b, 0)"
      )
    })

    test("re-serves the whole suggestion at the same position", () => {
      assert.strictEqual(
        getSuggestionContinuation(last, { ...last }),
        last.completion
      )
    })

    test("gives nothing once the suggestion is fully typed", () => {
      assert.strictEqual(
        getSuggestionContinuation(last, {
          prefix: last.prefix + last.completion,
          suffix: last.suffix
        }),
        undefined
      )
    })

    test("gives nothing when the typed text diverges", () => {
      assert.strictEqual(
        getSuggestionContinuation(last, {
          prefix: "const total = itemz",
          suffix: last.suffix
        }),
        undefined
      )
    })

    test("gives nothing when the suffix changed", () => {
      assert.strictEqual(
        getSuggestionContinuation(last, {
          prefix: "const total = items",
          suffix: "\nexport { x }"
        }),
        undefined
      )
    })

    test("gives nothing when the cursor moved elsewhere", () => {
      assert.strictEqual(
        getSuggestionContinuation(last, {
          prefix: "something else entirely",
          suffix: last.suffix
        }),
        undefined
      )
      assert.strictEqual(getSuggestionContinuation(undefined, last), undefined)
    })

    test("survives the prefix window sliding forward by a line", () => {
      const longPrefix = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")
      const suggestion: LastSuggestion = {
        prefix: longPrefix + "\nconst total = ",
        suffix: "",
        completion: "sum(\n  items\n)"
      }
      const slid = longPrefix.split("\n").slice(1).join("\n")
      assert.strictEqual(
        getSuggestionContinuation(suggestion, {
          prefix: slid + "\nconst total = sum(\n  it",
          suffix: ""
        }),
        "ems\n)"
      )
    })
  })
})

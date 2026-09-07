import * as assert from "assert"

import {
  getSuggestionContinuation,
  LastSuggestion,
  LRUCache
} from "../../extension/cache"

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

  test("keys ignore whitespace differences but not token boundaries", () => {
    const lru = new LRUCache<string>(5)
    lru.setCache({ prefix: "foo  bar\n", suffix: "\n baz" }, "x")
    assert.strictEqual(lru.getCache({ prefix: "foo bar", suffix: "baz" }), "x")
    assert.strictEqual(
      lru.getCache({ prefix: "foobar", suffix: "baz" }),
      undefined
    )
  })

  suite("suggestion continuation", () => {
    const last: LastSuggestion = {
      prefix: "const total = ",
      suffix: "\nexport {}",
      completion: "items.reduce((a, b) => a + b, 0)"
    }

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

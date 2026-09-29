import * as assert from "assert"

import {
  DefinitionSource,
  definitionText,
  scanIdentifiers
} from "../../extension/completion/definitions"
import { SyntaxLike } from "../../extension/embeddings/expand"

const node = (type: string, from: number, to: number, children: SyntaxLike[] = []): SyntaxLike => ({
  type,
  startPosition: { row: from },
  endPosition: { row: to },
  children
})

suite("FIM definitions near the cursor", () => {
  test("identifiers come nearest the cursor first, once each, without keywords", () => {
    const names = scanIdentifiers(
      "const total = applyDiscount(cart, rate)\nreturn formatPrice(total, applyDiscount("
    ).map((item) => item.name)
    assert.deepStrictEqual(names, ["applyDiscount", "total", "formatPrice", "rate", "cart"])
  })

  test("words inside string literals are not names", () => {
    const names = scanIdentifiers(
      "import { applyDiscount } from \"./utils\"\nconst label = `total ${formatPrice(total)}`"
    ).map((item) => item.name)
    assert.deepStrictEqual(names, ["label", "applyDiscount"])
  })

  test("a comment block right above the definition comes along when it fits", () => {
    const lines = ["/**", " * Applies a rate.", " */", "def apply(cart, rate):", "    return cart * rate", ""]
    assert.strictEqual(definitionText({ lines }, 3)?.startLine, 0)
    assert.strictEqual(definitionText({ lines }, 3)?.text, lines.slice(0, 5).join("\n"))
    // Not when the comment would push the block over budget.
    const body = lines.slice(3, 5).join("\n").length
    assert.strictEqual(definitionText({ lines }, 3, body + 4)?.startLine, 2)
  })

  test("short names and language keywords are skipped, offsets point at the name", () => {
    const found = scanIdentifiers("if (x) { await fetchUser(id) }")
    assert.deepStrictEqual(found.map((item) => item.name), ["fetchUser"])
    assert.strictEqual("if (x) { await fetchUser(id) }".slice(found[0].offset, found[0].offset + 9), "fetchUser")
  })

  test("a definition is the whole declaration when the tree says it fits", () => {
    const lines = ["export function applyDiscount(cart: Cart, rate: number) {", "  return cart.total * rate", "}", "", "const other = 1"]
    const source: DefinitionSource = {
      lines,
      root: node("program", 0, 5, [
        node("export_statement", 0, 2, [node("function_declaration", 0, 2)]),
        node("lexical_declaration", 4, 4)
      ])
    }
    // The declaration is 88 characters; the budget lets it through but
    // not the whole file, which would be the widest fitting node.
    assert.deepStrictEqual(definitionText(source, 0, 100), {
      text: lines.slice(0, 3).join("\n"),
      startLine: 0,
      endLine: 2
    })
    assert.strictEqual(definitionText(source, 0, 10_000)?.endLine, 4)
  })

  test("without a tree the definition runs to the next blank line, capped", () => {
    const lines = ["def apply(cart, rate):", "    total = cart.total", "    return total * rate", "", "def other():", "    pass"]
    assert.deepStrictEqual(definitionText({ lines }, 0), {
      text: lines.slice(0, 3).join("\n"),
      startLine: 0,
      endLine: 2
    })
    const long = { lines: Array.from({ length: 30 }, (_, i) => `line ${i}`) }
    assert.strictEqual(definitionText(long, 0)?.endLine, 7)
    assert.strictEqual(definitionText(long, 0, 12)?.text, "line 0\nline ")
  })

  test("a line outside the file, or an empty one, is nothing", () => {
    assert.strictEqual(definitionText({ lines: ["a"] }, 3), undefined)
    assert.strictEqual(definitionText({ lines: ["", ""] }, 0), undefined)
  })
})

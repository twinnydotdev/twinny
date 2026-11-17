/**
 * What keeps a completion prompt beginning the same way from one request
 * to the next, and the completion asked for ahead of the user.
 */
import * as assert from "node:assert"
import { test } from "node:test"

import { prefetchProgress, textToNextLine } from "../../extension/completion/prefetch"
import { HeldDefinitions, HOLD_LINES, sharedStart, StableOrder } from "../../extension/completion/stable-context"

const block = (name: string, text = `text of ${name}`) => ({ name, text })
const names = (blocks: { name: string }[]) => blocks.map((b) => b.name).join(" ")

test("blocks sent before keep their places and new ones follow", () => {
  const order = new StableOrder()
  assert.strictEqual(names(order.arrange("doc", [block("a"), block("b")])), "a b")
  // Offered the other way round, with one more: nothing sent before moves.
  assert.strictEqual(names(order.arrange("doc", [block("c"), block("b"), block("a")])), "a b c")
  // One gone: the rest close up in order.
  assert.strictEqual(names(order.arrange("doc", [block("c"), block("a")])), "a c")
})

test("a block whose text changed counts as new, and another document starts over", () => {
  const order = new StableOrder()
  order.arrange("doc", [block("a"), block("b")])
  const changed = order.arrange("doc", [block("a", "edited"), block("b")])
  assert.deepStrictEqual(changed, [block("b"), block("a", "edited")])
  assert.strictEqual(names(order.arrange("other", [block("b"), block("a")])), "b a")
})

test("definitions stay while the cursor is near, through an empty lookup", () => {
  const held = new HeldDefinitions()
  assert.strictEqual(names(held.hold("doc", 10, [block("add")], 1000)), "add")
  assert.strictEqual(names(held.hold("doc", 11, [], 1000)), "add", "a lookup that timed out")
  assert.strictEqual(names(held.hold("doc", 14, [block("mul")], 1000)), "add mul")
  assert.strictEqual(names(held.hold("doc", 15, [block("add")], 1000)), "add mul", "nothing new, nothing moves")
})

test("definitions are let go far from where they were found, and in another document", () => {
  const held = new HeldDefinitions()
  held.hold("doc", 10, [block("add")], 1000)
  assert.strictEqual(names(held.hold("doc", 10 + HOLD_LINES + 1, [block("mul")], 1000)), "mul")
  assert.strictEqual(names(held.hold("other", 10, [], 1000)), "")
})

test("the oldest definitions go when there is no room, and an edited one is shown once", () => {
  const held = new HeldDefinitions()
  held.hold("doc", 1, [block("a", "x".repeat(400))], 1000)
  held.hold("doc", 2, [block("b", "x".repeat(400))], 1000)
  assert.strictEqual(names(held.hold("doc", 3, [block("c", "x".repeat(400))], 1000)), "b c")
  assert.deepStrictEqual(held.hold("doc", 4, [block("b", "now different")], 1000), [
    block("c", "x".repeat(400)),
    block("b", "now different")
  ])
})

test("sharedStart is the part of the next prompt already read", () => {
  assert.strictEqual(sharedStart("abcd", "abcd"), 1)
  assert.strictEqual(sharedStart("abcd", "abXd"), 0.5)
  assert.strictEqual(sharedStart("", "abcd"), 0)
})

test("the next line keeps the indentation, and goes one deeper after a line that opens a block", () => {
  assert.strictEqual(textToNextLine("  const a = ", "add(1, 2)", "  "), "add(1, 2)\n  ")
  assert.strictEqual(textToNextLine("", "if (ready) {", "  "), "if (ready) {\n  ")
  assert.strictEqual(textToNextLine("\t", "for x in xs:", "\t"), "for x in xs:\n\t\t")
  assert.strictEqual(textToNextLine("function f() {", "\n  return 1\n}", "  "), "\n  return 1\n}\n")
  assert.strictEqual(textToNextLine("a", "b\nc", "  ", "\r\n"), "b\r\nc\r\n")
})

test("progress runs from the suggestion showing to the line after it", () => {
  const origin = { prefix: "const total = sum(items)\nconst mean = ", suffix: "\nexport {}\n" }
  const added = textToNextLine("const mean = ", "total / items.length", "  ")
  const at = (typed: string) => prefetchProgress(origin, added, { prefix: origin.prefix + typed, suffix: origin.suffix })
  assert.strictEqual(at(""), 0)
  assert.strictEqual(at("total /"), 7, "typing the suggestion out")
  assert.strictEqual(at("total / items.length"), 20, "accepted")
  assert.strictEqual(at("total / items.length\n"), added.length, "and Enter")
})

test("anywhere else is off the way", () => {
  const origin = { prefix: "const total = sum(items)\nconst mean = ", suffix: "\nexport {}\n" }
  const added = "total / items.length\n"
  assert.strictEqual(
    prefetchProgress(origin, added, { prefix: origin.prefix + "total * 2", suffix: origin.suffix }),
    undefined,
    "typed something else"
  )
  assert.strictEqual(
    prefetchProgress(origin, added, { prefix: origin.prefix + "total / items.length\n  ", suffix: origin.suffix }),
    undefined,
    "the editor indented differently"
  )
  assert.strictEqual(
    prefetchProgress(origin, added, { prefix: origin.prefix, suffix: "\nconst other = 1\n" }),
    undefined,
    "the code after the cursor changed"
  )
  assert.strictEqual(
    prefetchProgress(origin, added, { prefix: "import x from 'y'\n", suffix: origin.suffix }),
    undefined,
    "the cursor moved up the file"
  )
})

import * as assert from "assert"

import { diffLines, diffWords, layoutDiff } from "../../extension/edit/diff"
import {
  buildEditMessages,
  buildEditPrompt,
  clampContext,
  commonIndent,
  EDIT_CONTEXT_CHARS,
  extractEditedCode,
  finalizeEdit,
  matchIndentation,
  previewEdit
} from "../../extension/edit/prompt"

suite("Inline edit", () => {
  suite("buildEditPrompt", () => {
    test("names the file, quotes the code and ends with the instruction", () => {
      const prompt = buildEditPrompt({
        instruction: "add a null check",
        code: "return user.name",
        language: "typescript",
        fileName: "src/a.ts"
      })
      assert.ok(prompt.startsWith("File: src/a.ts"))
      assert.ok(prompt.includes("```typescript\nreturn user.name\n```"))
      assert.ok(prompt.includes("Instruction: add a null check"))
      assert.ok(!prompt.includes("Surrounding code"))
    })

    test("shows surrounding code as context only", () => {
      const prompt = buildEditPrompt({
        instruction: "x",
        code: "b",
        before: "a",
        after: "c"
      })
      const context = prompt.indexOf("Surrounding code")
      const code = prompt.indexOf("Code to edit:")
      assert.ok(context !== -1 && context < code)
      assert.ok(prompt.includes("[... the code to edit goes here ...]"))
    })

    test("messages are a system prompt plus one user turn", () => {
      const messages = buildEditMessages({ instruction: "x", code: "y" })
      assert.deepStrictEqual(
        messages.map((m) => m.role),
        ["system", "user"]
      )
    })
  })

  suite("extractEditedCode", () => {
    test("takes a bare reply verbatim", () => {
      assert.strictEqual(extractEditedCode("const a = 1\n"), "const a = 1\n")
    })

    test("unwraps a fenced block and drops chatter around it", () => {
      const reply =
        "Here is the code:\n```ts\nconst a = 1\n```\nLet me know if that helps."
      assert.strictEqual(extractEditedCode(reply), "const a = 1")
    })

    test("unwraps a fence that has not closed yet", () => {
      assert.strictEqual(extractEditedCode("```ts\nconst a"), "const a")
      assert.strictEqual(extractEditedCode("```"), "")
    })

    test("ignores fences that appear inside the code", () => {
      const reply = "```\nconst md = `\n```js\n`\n```"
      assert.strictEqual(extractEditedCode(reply), "const md = `\n```js\n`")
    })

    test("drops reasoning, finished or not", () => {
      assert.strictEqual(
        extractEditedCode("<think>hmm</think>\nconst a = 1"),
        "const a = 1"
      )
      assert.strictEqual(extractEditedCode("<think>still going"), "")
    })
  })

  suite("indentation", () => {
    test("commonIndent ignores blank lines", () => {
      assert.strictEqual(commonIndent("    a\n\n    b\n      c"), "    ")
      assert.strictEqual(commonIndent("a\n  b"), "")
      assert.strictEqual(commonIndent("\t\ta\n\tb"), "\t")
    })

    test("matchIndentation re-indents a flattened reply", () => {
      const original = "    if (a) {\n      b()\n    }"
      const reply = "if (a) {\n  b()\n}"
      assert.strictEqual(matchIndentation(reply, original), original)
    })

    test("matchIndentation removes extra indentation", () => {
      assert.strictEqual(matchIndentation("  a\n  b", "a\nb"), "a\nb")
    })
  })

  suite("finalizeEdit", () => {
    test("keeps the original's trailing newline", () => {
      assert.strictEqual(finalizeEdit("```\nx\n```\n\n", "y\n"), "x\n")
      assert.strictEqual(finalizeEdit("x\n\n", "y"), "x")
    })

    test("falls back to the original when the reply is empty", () => {
      assert.strictEqual(finalizeEdit("```\n```", "keep"), "keep")
      assert.strictEqual(finalizeEdit("<think>only thoughts", "keep"), "keep")
    })

    test("re-indents to where the original sat", () => {
      const original = "  const a = 1\n  const b = 2\n"
      assert.strictEqual(
        finalizeEdit("```js\nconst a = 1\nconst b = 3\n```", original),
        "  const a = 1\n  const b = 3\n"
      )
    })
  })

  suite("clampContext", () => {
    test("keeps the end of the text before the selection", () => {
      const text = "a".repeat(EDIT_CONTEXT_CHARS) + "TAIL"
      assert.ok(clampContext(text, true).endsWith("TAIL"))
      assert.strictEqual(clampContext(text, true).length, EDIT_CONTEXT_CHARS)
    })

    test("keeps the start of the text after the selection", () => {
      const text = "HEAD" + "a".repeat(EDIT_CONTEXT_CHARS)
      assert.ok(clampContext(text, false).startsWith("HEAD"))
    })
  })

  suite("previewEdit", () => {
    test("re-indents but keeps the unfinished last line", () => {
      assert.strictEqual(
        previewEdit("```js\nconst a = 1\nconst b", "  x\n  y"),
        "  const a = 1\n  const b"
      )
    })
  })

  suite("diffLines", () => {
    const kinds = (ops: ReturnType<typeof diffLines>) =>
      ops.map((op) => `${op.kind[0]}:${op.line}`)

    test("identical input is all equal", () => {
      assert.deepStrictEqual(kinds(diffLines(["a", "b"], ["a", "b"])), [
        "e:a",
        "e:b"
      ])
    })

    test("a changed line is a removal then an addition", () => {
      assert.deepStrictEqual(kinds(diffLines(["a", "b", "c"], ["a", "B", "c"])), [
        "e:a",
        "r:b",
        "a:B",
        "e:c"
      ])
    })

    test("keeps lines that moved past an insertion", () => {
      assert.deepStrictEqual(kinds(diffLines(["a", "c"], ["a", "b", "c"])), [
        "e:a",
        "a:b",
        "e:c"
      ])
      assert.deepStrictEqual(kinds(diffLines(["a", "b", "c"], ["a", "c"])), [
        "e:a",
        "r:b",
        "e:c"
      ])
    })

    test("handles empty sides", () => {
      assert.deepStrictEqual(kinds(diffLines([], ["a"])), ["a:a"])
      assert.deepStrictEqual(kinds(diffLines(["a"], [])), ["r:a"])
      assert.deepStrictEqual(kinds(diffLines([], [])), [])
    })

    test("finds the longest common subsequence in the middle", () => {
      const ops = kinds(diffLines(["x", "a", "b", "c", "y"], ["x", "b", "d", "y"]))
      assert.deepStrictEqual(ops, ["e:x", "r:a", "e:b", "r:c", "a:d", "e:y"])
    })
  })

  suite("diffWords", () => {
    test("marks the words that differ", () => {
      const words = diffWords("sum += item.price", "sum += item.price * qty")
      assert.deepStrictEqual(words.removed, [])
      assert.deepStrictEqual(words.added, [[17, 23]])
      const rename = diffWords("const a = x", "const b = x")
      assert.deepStrictEqual(rename.removed, [[6, 7]])
      assert.deepStrictEqual(rename.added, [[6, 7]])
    })

    test("gives up on lines that share little", () => {
      const words = diffWords("return sum", "throw new Error('no')")
      assert.deepStrictEqual(words, { removed: [], added: [] })
    })
  })

  suite("layoutDiff", () => {
    test("pairs removed and added lines within a hunk for word highlights", () => {
      const layout = layoutDiff("a\nlet x = 1\nlet y = 2", "a\nlet x = 10\nlet y = 2")
      assert.strictEqual(layout.text, "a\nlet x = 1\nlet x = 10\nlet y = 2")
      assert.deepStrictEqual(layout.removedWords, [{ line: 1, start: 8, end: 9 }])
      assert.deepStrictEqual(layout.addedWords, [{ line: 2, start: 8, end: 10 }])
    })

    test("pairs each removed line with the added line it resembles", () => {
      const layout = layoutDiff(
        "sum += item.price",
        "if (!item) continue\nsum += item.price * item.quantity"
      )
      assert.deepStrictEqual(layout.removedWords, [])
      assert.deepStrictEqual(layout.addedWords, [{ line: 2, start: 17, end: 33 }])
    })

    test("does not pair a streaming partial line", () => {
      const layout = layoutDiff("let x = 1", "let x = 1", true)
      assert.deepStrictEqual(layout.removedWords, [])
      assert.deepStrictEqual(layout.addedWords, [])
    })

    test("merges old and new lines and points at each", () => {
      const layout = layoutDiff("a\nb\nc", "a\nB\nc")
      assert.strictEqual(layout.text, "a\nb\nB\nc")
      assert.deepStrictEqual(layout.removed, [1])
      assert.deepStrictEqual(layout.added, [2])
    })

    test("an unchanged rewrite has nothing to review", () => {
      const layout = layoutDiff("a\nb", "a\nb")
      assert.strictEqual(layout.text, "a\nb")
      assert.deepStrictEqual(layout.removed, [])
      assert.deepStrictEqual(layout.added, [])
    })

    test("while streaming, the partial line sits below the unreached lines", () => {
      const layout = layoutDiff("a\nb\nc", "a\nB", true)
      assert.strictEqual(layout.text, "a\nb\nc\nB")
      assert.deepStrictEqual(layout.removed, [1, 2])
      assert.deepStrictEqual(layout.added, [3])
    })

    test("while streaming, unreached lines stay red above the new ones", () => {
      const layout = layoutDiff("a\nb\nc", "a\nB\n", true)
      assert.strictEqual(layout.text, "a\nb\nc\nB")
      assert.deepStrictEqual(layout.removed, [1, 2])
      assert.deepStrictEqual(layout.added, [3])
      const reached = layoutDiff("a\nb\nc", "a\nB\nc\n", true)
      assert.strictEqual(reached.text, "a\nb\nB\nc")
      assert.deepStrictEqual(reached.removed, [1])
      assert.deepStrictEqual(reached.added, [2])
    })

    test("a streamed line that matches collapses once complete", () => {
      const partial = layoutDiff("a\nb", "a\nb", true)
      assert.strictEqual(partial.text, "a\nb\nb")
      const done = layoutDiff("a\nb", "a\nb\n", true)
      assert.strictEqual(done.text, "a\nb")
      assert.deepStrictEqual(done.added, [])
    })
  })
})

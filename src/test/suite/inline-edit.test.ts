import * as assert from "assert"

import {
  buildEditMessages,
  buildEditPrompt,
  clampContext,
  commonIndent,
  EDIT_CONTEXT_CHARS,
  extractEditedCode,
  finalizeEdit,
  matchIndentation
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
})

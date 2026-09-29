import * as assert from "assert"

import {
  cleanCommitMessage,
  truncateDiff
} from "../../extension/review/commit-message"

suite("Commit message", () => {
  suite("truncateDiff", () => {
    test("leaves short diffs alone", () => {
      const diff = "diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b\n"
      assert.strictEqual(truncateDiff(diff, 1000), diff)
    })

    test("cuts at a hunk boundary and says how much was dropped", () => {
      const hunk = "@@ -1,3 +1,3 @@\n-old line\n+new line\n context\n"
      const diff = "diff --git a/x b/x\n" + hunk.repeat(20)
      const result = truncateDiff(diff, 200)

      assert.ok(result.length < diff.length)
      assert.ok(/\[diff truncated: \d+ more characters not shown\]$/.test(result))
      const body = result.slice(0, result.indexOf("\n\n[diff truncated"))
      assert.ok(body.endsWith(" context"), `cut mid-hunk: ${JSON.stringify(body.slice(-40))}`)
    })

    test("falls back to a hard cut when there is no boundary", () => {
      const diff = "x".repeat(500)
      const result = truncateDiff(diff, 100)
      assert.ok(result.startsWith("x".repeat(100)))
      assert.ok(result.includes("[diff truncated: 400 more characters not shown]"))
    })
  })

  suite("cleanCommitMessage", () => {
    test("strips fences, quotes and prefixes", () => {
      assert.strictEqual(
        cleanCommitMessage("```\nAdd status bar menu\n```"),
        "Add status bar menu"
      )
      assert.strictEqual(
        cleanCommitMessage("```text\nFix spinner\n\nIt never stopped.\n```"),
        "Fix spinner\n\nIt never stopped."
      )
      assert.strictEqual(
        cleanCommitMessage("\"Refactor activation\""),
        "Refactor activation"
      )
      assert.strictEqual(
        cleanCommitMessage("Commit message: Remove dead code"),
        "Remove dead code"
      )
    })

    test("drops chatter around a fenced answer", () => {
      const raw =
        "Okay, here's the commit message based on the diff:\n\n```\nAdd commit command\n\nWires the SCM button.\n```\n\nLet me know if you want changes."
      assert.strictEqual(
        cleanCommitMessage(raw),
        "Add commit command\n\nWires the SCM button."
      )
      assert.strictEqual(
        cleanCommitMessage("Here is a commit message:\nFix typo"),
        "Fix typo"
      )
    })

    test("collapses runs of blank lines", () => {
      assert.strictEqual(
        cleanCommitMessage("Subject\n\n\n\nBody"),
        "Subject\n\nBody"
      )
    })
  })
})

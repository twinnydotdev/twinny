import * as assert from "assert"
import * as vscode from "vscode"

import {
  diffHunk,
  EditHunk,
  MAX_HUNKS,
  RecentEdits,
  renderHunk,
  renderRecentEdits
} from "../../extension/completion/recent-edits"

const hunk = (overrides: Partial<EditHunk> = {}): EditHunk => ({
  file: "src/a.ts",
  removed: ["const a = foo(1)"],
  added: ["const a = bar(1)"],
  line: 3,
  at: 1,
  ...overrides
})

const edit = async (document: vscode.TextDocument, range: vscode.Range, text: string) => {
  const change = new vscode.WorkspaceEdit()
  change.replace(document.uri, range, text)
  assert.ok(await vscode.workspace.applyEdit(change))
}

suite("FIM recent edits", () => {
  test("a diff is the changed lines only, with the shared head and tail trimmed", () => {
    const before = ["a", "b", "c", "d", "e"].join("\n")
    const after = ["a", "b", "C", "c2", "d", "e"].join("\n")
    assert.deepStrictEqual(diffHunk(before, after), {
      removed: ["c"],
      added: ["C", "c2"],
      line: 2
    })
    assert.deepStrictEqual(diffHunk("a\nb\nc", "a\nc"), { removed: ["b"], added: [], line: 1 })
    assert.deepStrictEqual(diffHunk("a\r\nb", "a\r\nb\r\nc"), { removed: [], added: ["c"], line: 2 })
  })

  test("identical or whitespace-only changes are not edits", () => {
    assert.strictEqual(diffHunk("a\nb", "a\nb"), undefined)
    assert.strictEqual(diffHunk("a\n  b", "a\nb"), undefined)
    assert.strictEqual(diffHunk("a\nb", "a\nb\n"), undefined)
  })

  test("a hunk renders as its file, then removed and added lines", () => {
    assert.strictEqual(
      renderHunk(hunk()),
      "src/a.ts:\n-const a = foo(1)\n+const a = bar(1)"
    )
    const long = renderHunk(hunk({ added: Array.from({ length: 50 }, (_, i) => `line ${i}`) }))
    assert.ok(long.includes("+line 14\n+... 20 lines ...\n+line 35"))
    assert.ok(!long.includes("line 20"))
  })

  test("the block keeps the most recent hunks within budget, oldest first", () => {
    const hunks = [hunk({ at: 1, file: "one.ts" }), hunk({ at: 2, file: "two.ts" }), hunk({ at: 3, file: "three.ts" })]
    const block = renderRecentEdits(hunks)
    assert.ok(block.startsWith("Recent edits by the user, most recent last."))
    assert.ok(block.indexOf("one.ts") < block.indexOf("two.ts"))
    assert.ok(block.indexOf("two.ts") < block.indexOf("three.ts"))
    const tight = renderRecentEdits(hunks, 90)
    assert.ok(tight.includes("three.ts") && !tight.includes("one.ts"))
    assert.strictEqual(renderRecentEdits([]), "")
  })

  test("tracks edits in open documents, freezing a hunk when the user jumps away", async () => {
    const recent = new RecentEdits()
    try {
      const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`)
      const document = await vscode.workspace.openTextDocument({
        content: lines.join("\n"),
        language: "typescript"
      })
      assert.strictEqual(recent.get(document), undefined)

      // A rename on line 5, typed in two steps, is one hunk.
      await edit(document, new vscode.Range(5, 5, 5, 6), "X")
      await edit(document, new vscode.Range(5, 6, 5, 6), "Y")
      let hunks = recent.hunks(document, 40)
      assert.strictEqual(hunks.length, 1)
      assert.deepStrictEqual(hunks[0].removed, ["line 5"])
      assert.deepStrictEqual(hunks[0].added, ["line XY"])
      assert.strictEqual(hunks[0].line, 5)

      // While the cursor sits inside that hunk it is not shown: the prefix has it.
      assert.strictEqual(recent.hunks(document, 5).length, 0)

      // Editing far below freezes the first hunk and starts a second one.
      await edit(document, new vscode.Range(60, 0, 60, 0), "inserted\n")
      hunks = recent.hunks(document, 0)
      assert.strictEqual(hunks.length, 2)
      assert.deepStrictEqual(hunks[0].added, ["line XY"])
      assert.deepStrictEqual(hunks[1].removed, [])
      assert.deepStrictEqual(hunks[1].added, ["inserted"])
      assert.strictEqual(hunks[1].line, 60)

      const block = recent.get(document, 0)
      assert.ok(block?.text.includes("-line 5\n+line XY"))
      assert.ok(block?.text.includes("+inserted"))
      assert.ok(block!.text.indexOf("line XY") < block!.text.indexOf("inserted"))

      // A document nobody edited contributes nothing.
      const other = await vscode.workspace.openTextDocument({ content: "untouched" })
      assert.strictEqual(recent.hunks(other, 0).length, 2)
      assert.ok(MAX_HUNKS >= 2)
    } finally {
      recent.dispose()
    }
  })
})

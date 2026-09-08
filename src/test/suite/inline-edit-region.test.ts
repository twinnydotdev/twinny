import * as assert from "assert"
import * as vscode from "vscode"

import { layoutDiff } from "../../extension/edit/diff"
import { DiffRegion } from "../../extension/edit/service"

/** An editor on an untitled document, plus a region that follows its changes. */
const open = async (content: string, from: number, to: number) => {
  const document = await vscode.workspace.openTextDocument({
    content,
    language: "plaintext"
  })
  const editor = await vscode.window.showTextDocument(document)
  const range = new vscode.Range(from, 0, to, document.lineAt(to).range.end.character)
  const region = new DiffRegion(editor, range)
  const listener = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document === document) region.track(event.contentChanges)
  })
  return { document, editor, region, dispose: () => listener.dispose() }
}

const type = (editor: vscode.TextEditor, at: vscode.Position, text: string) =>
  editor.edit((builder) => builder.insert(at, text))

suite("Inline edit region", () => {
  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
  })

  test("streams a merged diff, then accepting keeps only the new lines", async () => {
    const t = await open("head\nkeep\nold\ntail", 1, 2)
    const original = "keep\nold"
    await t.region.render(layoutDiff(original, "keep\nne", true))
    assert.strictEqual(t.document.getText(), "head\nkeep\nold\nne\ntail")
    await t.region.render(layoutDiff(original, "keep\nnew"))
    assert.strictEqual(t.document.getText(), "head\nkeep\nold\nnew\ntail")
    assert.deepStrictEqual(t.region.removed, [2])
    assert.deepStrictEqual(t.region.added, [3])

    assert.ok(await t.region.settle(t.editor, "accept"))
    assert.strictEqual(t.document.getText(), "head\nkeep\nnew\ntail")

    await vscode.commands.executeCommand("undo")
    assert.strictEqual(t.document.getText(), "head\nkeep\nold\ntail", "one undo step")
    t.dispose()
  })

  test("rejecting keeps only the old lines", async () => {
    const t = await open("a\nb\nc", 0, 2)
    await t.region.render(layoutDiff("a\nb\nc", "a\nB\nc\nd"))
    assert.strictEqual(t.document.getText(), "a\nb\nB\nc\nd")
    assert.ok(await t.region.settle(t.editor, "reject"))
    assert.strictEqual(t.document.getText(), "a\nb\nc")
    t.dispose()
  })

  test("deletes a removed line at the very end of the document cleanly", async () => {
    const t = await open("a\nb", 1, 1)
    await t.region.render(layoutDiff("b", "B"))
    assert.strictEqual(t.document.getText(), "a\nb\nB")
    assert.ok(await t.region.settle(t.editor, "accept"))
    assert.strictEqual(t.document.getText(), "a\nB")
    t.dispose()
  })

  test("deletes runs of lines at the end of the document", async () => {
    const t = await open("a\nb", 0, 1)
    await t.region.render(layoutDiff("a\nb", "A\nB"))
    assert.strictEqual(t.document.getText(), "a\nb\nA\nB")
    assert.ok(await t.region.settle(t.editor, "reject"))
    assert.strictEqual(t.document.getText(), "a\nb")

    const u = await open("a\nb", 0, 1)
    await u.region.render(layoutDiff("a\nb", "A\nB"))
    assert.ok(await u.region.settle(u.editor, "accept"))
    assert.strictEqual(u.document.getText(), "A\nB")

    const v = await open("a\nb", 0, 1)
    await v.region.render(layoutDiff("a\nb", ""))
    assert.ok(await v.region.settle(v.editor, "accept"))
    assert.strictEqual(v.document.getText(), "")
    t.dispose()
    u.dispose()
    v.dispose()
  })

  test("settles one hunk at a time", async () => {
    const t = await open("a\nb\nc\nd\ne", 0, 4)
    await t.region.render(layoutDiff("a\nb\nc\nd\ne", "A\nb\nc\nD\ne"))
    assert.strictEqual(t.document.getText(), "a\nA\nb\nc\nd\nD\ne")
    assert.deepStrictEqual(
      t.region.hunks,
      [
        { line: 0, removed: [0], added: [1] },
        { line: 4, removed: [4], added: [5] }
      ]
    )

    assert.ok(await t.region.settle(t.editor, "accept", 0))
    assert.strictEqual(t.document.getText(), "A\nb\nc\nd\nD\ne")
    assert.ok(!t.region.done)
    assert.deepStrictEqual(t.region.hunks, [{ line: 3, removed: [3], added: [4] }])
    assert.deepStrictEqual(t.region.removedWords, [])

    assert.ok(await t.region.settle(t.editor, "reject", 0))
    assert.strictEqual(t.document.getText(), "A\nb\nc\nd\ne")
    assert.ok(t.region.done)

    await vscode.commands.executeCommand("undo")
    assert.strictEqual(t.document.getText(), "a\nb\nc\nd\ne", "still one undo step")
    t.dispose()
  })

  test("exposes both sides and can rewind to a snapshot", async () => {
    const t = await open("a\nb\nc", 0, 2)
    await t.region.render(layoutDiff("a\nb\nc", "a\nB\nc\nd"))
    assert.deepStrictEqual(t.region.sides(), {
      baseline: "a\nb\nc",
      proposed: "a\nB\nc\nd"
    })

    const snapshot = t.region.snapshot()
    assert.strictEqual(snapshot.text, "a\nb\nB\nc\nd")
    assert.deepStrictEqual(snapshot.removed, [1])
    assert.deepStrictEqual(snapshot.added, [2, 4])

    // A refinement streams over the region, then is abandoned.
    await t.region.render(layoutDiff("a\nb\nc", "a\nX", true))
    await t.region.render(snapshot)
    assert.strictEqual(t.document.getText(), "a\nb\nB\nc\nd")
    assert.deepStrictEqual(t.region.removed, [1])
    assert.deepStrictEqual(t.region.added, [2, 4])

    // After settling a hunk the range still covers whole lines.
    assert.ok(await t.region.settle(t.editor, "accept", 0))
    assert.strictEqual(t.document.getText(), "a\nB\nc\nd")
    assert.strictEqual(t.document.getText(t.region.range), "a\nB\nc\nd")
    assert.deepStrictEqual(t.region.sides(), { baseline: "a\nB\nc", proposed: "a\nB\nc\nd" })
    t.dispose()
  })

  test("inserts a snippet at a line and can take it back", async () => {
    const t = await open("a\nb", 1, 1)
    t.region.range = new vscode.Range(1, 0, 1, 0)
    await t.region.render(layoutDiff("", "x\ny\n"))
    assert.strictEqual(t.document.getText(), "a\nx\ny\nb")
    assert.deepStrictEqual(t.region.added, [1, 2])
    assert.ok(await t.region.settle(t.editor, "reject"))
    assert.strictEqual(t.document.getText(), "a\nb")
    t.dispose()
  })

  test("follows lines inserted above and edits inside the diff", async () => {
    const t = await open("a\nb\nc", 1, 1)
    await t.region.render(layoutDiff("b", "B"))
    await type(t.editor, new vscode.Position(0, 0), "x\ny\n")
    assert.deepStrictEqual(t.region.removed, [3])
    assert.deepStrictEqual(t.region.added, [4])
    assert.strictEqual(t.region.range.start.line, 3)

    await type(t.editor, new vscode.Position(4, 1), "!")
    assert.ok(!t.region.broken)
    assert.ok(await t.region.settle(t.editor, "accept"))
    assert.strictEqual(t.document.getText(), "x\ny\na\nB!\nc")
    t.dispose()
  })

  test("breaks when a tracked line is cut", async () => {
    const t = await open("a\nb\nc", 1, 1)
    await t.region.render(layoutDiff("b", "B"))
    await t.editor.edit((builder) =>
      builder.delete(new vscode.Range(1, 0, 2, 0))
    )
    assert.ok(t.region.broken)
    assert.strictEqual(await t.region.settle(t.editor, "accept"), false)
    t.dispose()
  })

  test("ignores changes after the diff", async () => {
    const t = await open("a\nb\nc", 0, 0)
    await t.region.render(layoutDiff("a", "A"))
    await type(t.editor, new vscode.Position(3, 1), "\nd")
    assert.deepStrictEqual(t.region.removed, [0])
    assert.deepStrictEqual(t.region.added, [1])
    assert.ok(await t.region.settle(t.editor, "reject"))
    assert.strictEqual(t.document.getText(), "a\nb\nc\nd")
    t.dispose()
  })
})

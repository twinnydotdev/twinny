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

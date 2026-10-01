import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import { editorEdits, editorKnowledge, terminalCommands } from "../../extension/chat/tool-sinks"
import { ChatEditMode, InlineEditService } from "../../extension/edit/service"
import { GenerationTracker } from "../../extension/generations"
import { planReplacement, Replacement } from "../../extension/tools/edit"

const fakeContext = {
  globalState: { get: () => undefined, update: async () => undefined },
  subscriptions: [] as vscode.Disposable[]
} as unknown as vscode.ExtensionContext

const ORIGINAL = "const a = 1\nfunction f() {\n  return a\n}\n"

suite("Chat edit_file", () => {
  let service: InlineEditService
  let file: string

  setup(() => {
    service = new InlineEditService(fakeContext, new GenerationTracker())
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "twinny-chat-edit-")), "a.ts")
    fs.writeFileSync(file, ORIGINAL)
  })

  teardown(async () => {
    service.dispose()
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
  })

  const edit = (find: string, replace: string, mode: ChatEditMode) => {
    const current =
      vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file)?.getText() ??
      fs.readFileSync(file, "utf8")
    const plan = planReplacement(current, find, replace) as Replacement
    return service.chatEdit({ file, ...plan }, mode)
  }

  const documentText = () =>
    vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file)?.getText()

  test("apply writes and saves each edit in turn, and undo takes one back", async () => {
    const first = await edit("  return a", "  return a + 1", "apply")
    assert.deepStrictEqual([first.ok, first.pending], [true, undefined])
    assert.match(first.message, /^Applied and saved: .*a\.ts line 3 changed/)
    const second = await edit("const a = 1", "const a = 2", "apply")
    assert.ok(second.ok)
    assert.strictEqual(fs.readFileSync(file, "utf8"), "const a = 2\nfunction f() {\n  return a + 1\n}\n")

    const document = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file)!
    await vscode.window.showTextDocument(document)
    await vscode.commands.executeCommand("undo")
    assert.strictEqual(document.getText(), "const a = 1\nfunction f() {\n  return a + 1\n}\n")
  })

  test("review shows a pending diff, writes nothing until accepted, and holds further edits", async () => {
    const said = await edit("  return a", "  return a + 1", "review")
    assert.deepStrictEqual([said.ok, said.pending], [true, true])
    assert.match(said.message, /^Proposed: the change to .*a\.ts line 3/)
    assert.strictEqual(documentText(), "const a = 1\nfunction f() {\n  return a\n  return a + 1\n}\n")
    assert.strictEqual(fs.readFileSync(file, "utf8"), ORIGINAL)

    const held = await service.chatEdit(
      { file, startLine: 0, endLine: 0, original: "const a = 1", text: "const a = 2" },
      "apply"
    )
    assert.strictEqual(held.ok, false, "an applied edit waits too while that file has a diff pending")
    assert.match(held.message, /is waiting for the user's review/)

    await service.accept()
    assert.strictEqual(documentText(), "const a = 1\nfunction f() {\n  return a + 1\n}\n")
  })

  test("refuses when the lines changed since the model read them", async () => {
    const plan = planReplacement(ORIGINAL, "const a = 1", "const a = 2") as Replacement
    const document = await vscode.workspace.openTextDocument(file)
    const editor = await vscode.window.showTextDocument(document)
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), "// hi\n"))
    for (const mode of ["apply", "review"] as const) {
      const said = await service.chatEdit({ file, ...plan }, mode)
      assert.deepStrictEqual([said.ok, said.message.startsWith("Not changed: the file changed")], [false, true])
    }
  })

  test("create_file in apply mode makes the folders and the file, and refuses an existing one", async () => {
    const target = path.join(path.dirname(file), "deep", "er", "b.ts")
    const made = await service.chatCreate(target, "export const b = 1\n", "apply")
    assert.deepStrictEqual([made.ok, made.pending], [true, undefined])
    assert.strictEqual(fs.readFileSync(target, "utf8"), "export const b = 1\n")
    const again = await service.chatCreate(target, "x", "apply")
    assert.match(again.message, /already exists/)
  })

  test("create_file in review mode opens the file unsaved until accepted", async () => {
    const target = path.join(path.dirname(file), "c.ts")
    const shown = await service.chatCreate(target, "export const c = 1", "review")
    assert.deepStrictEqual([shown.ok, shown.pending], [true, true])
    assert.ok(!fs.existsSync(target))
    const document = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "untitled" && d.uri.fsPath === target)!
    assert.strictEqual(document.getText(), "export const c = 1\n")
    assert.ok(service.pendingFor(document))
    await service.accept()
    assert.strictEqual(document.getText(), "export const c = 1\n")
    assert.strictEqual(service.pendingFor(document), undefined)
  })

  test("run_command runs in allow mode and reports output and exit code", async function () {
    this.timeout(30000)
    const commands = terminalCommands("allow", path.dirname(file))
    const ok = await commands.run("echo twinny-ran")
    assert.strictEqual(ok.ran, true)
    assert.match(ok.output, /twinny-ran/)
    assert.strictEqual(ok.exitCode, 0)
    const failed = await commands.run("sh -c 'exit 3'")
    assert.strictEqual(failed.exitCode, 3)
  })

  test("delete and move apply straight away, or wait for approval when reviewing", async () => {
    const dir = path.dirname(file)
    const asked: string[] = []
    const apply = editorEdits("apply", async () => true)
    const moved = await apply.move(file, path.join(dir, "moved", "b.ts"))
    assert.ok(moved.ok, moved.message)
    assert.ok(fs.existsSync(path.join(dir, "moved", "b.ts")) && !fs.existsSync(file))

    const review = editorEdits("review", async (detail) => (asked.push(detail), false))
    const declined = await review.remove(path.join(dir, "moved", "b.ts"))
    assert.deepStrictEqual([declined.ok, asked.length], [false, 1])
    assert.match(asked[0], /^delete .*moved\/b\.ts$/)
    assert.ok(fs.existsSync(path.join(dir, "moved", "b.ts")))

    const removed = await apply.remove(path.join(dir, "moved", "b.ts"))
    assert.ok(removed.ok, removed.message)
    assert.ok(!fs.existsSync(path.join(dir, "moved", "b.ts")))
  })

  test("the editor reports diagnostics, what is open and selected, and says when it cannot rename", async () => {
    const knowledge = editorKnowledge(path.dirname(file), "apply", async () => true)
    const collection = vscode.languages.createDiagnosticCollection("twinny-test")
    try {
      const uri = vscode.Uri.file(file)
      collection.set(uri, [
        new vscode.Diagnostic(new vscode.Range(2, 2, 2, 8), "Type 'string' is not assignable to type 'number'.", vscode.DiagnosticSeverity.Error)
      ])
      const found = await knowledge.diagnostics(file)
      assert.deepStrictEqual(
        found.map((d) => [d.line, d.severity, d.message]),
        [[3, "error", "Type 'string' is not assignable to type 'number'."]]
      )
      const everywhere = await knowledge.diagnostics()
      assert.ok(everywhere.some((d) => d.file === file))

      const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri))
      editor.selection = new vscode.Selection(1, 0, 2, 12)
      const context = await knowledge.context()
      assert.strictEqual(context.activeFile, file)
      assert.strictEqual(context.cursorLine, 3)
      assert.deepStrictEqual(context.selection, { startLine: 2, endLine: 3, text: "function f() {\n  return a" })
      assert.ok(context.openFiles.includes(file))

      // The built-in TypeScript server answers in the test host.
      const references = await knowledge.references(file, 0, 6)
      assert.deepStrictEqual(references.map((r) => [r.line, r.text?.trim()]), [
        [1, "const a = 1"],
        [3, "return a"]
      ])
      const definition = await knowledge.definition(file, 2, 9)
      assert.deepStrictEqual(definition.map((d) => [d.file, d.line]), [[file, 1]])
      const rename = await knowledge.rename(file, 0, 6, "total")
      assert.ok(rename.ok, rename.message)
      assert.strictEqual(fs.readFileSync(file, "utf8"), "const total = 1\nfunction f() {\n  return total\n}\n")
    } finally {
      collection.dispose()
    }
  })
})

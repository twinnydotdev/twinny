import * as assert from "assert"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import {
  editorEdits,
  editorHint,
  editorKnowledge,
  normalCommand,
  openDocumentText,
  terminalCommands
} from "../../extension/chat/tool-sinks"
import { ChatEditMode, InlineEditService } from "../../extension/edit/service"
import { GenerationTracker } from "../../extension/generations"
import { planReplacement, Replacement } from "../../extension/tools/edit"
import { WorkspaceView } from "../../extension/tools/view"

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

  for (const place of ["background", "terminal"] as const) {
    test(`run_command runs in allow mode (${place}) and reports output and exit code`, async function () {
      this.timeout(30000)
      const commands = terminalCommands(() => "allow", path.dirname(file), undefined, { place })
      const ok = await commands.run("echo twinny-ran")
      assert.strictEqual(ok.ran, true)
      assert.match(ok.output, /twinny-ran/)
      assert.strictEqual(ok.exitCode, 0)
      const failed = await commands.run("sh -c 'exit 3'")
      assert.strictEqual(failed.exitCode, 3)
      // A command that leaves the shell elsewhere does not move the next one.
      await commands.run("cd /")
      const where = await commands.run("pwd")
      assert.match(where.output, new RegExp(`${fs.realpathSync(path.dirname(file))}|${path.dirname(file)}`))
    })
  }

  test("a background command streams its output, and stopping the reply ends it and what it started", async function () {
    this.timeout(20000)
    const heard: string[] = []
    const commands = terminalCommands(() => "allow", path.dirname(file), undefined, {
      onOutput: (output) => heard.push(output)
    })
    const stop = new AbortController()
    const marker = path.join(path.dirname(file), "twinny-still-running")
    const running = commands.run(`echo first; sleep 1; (sleep 3; touch ${marker}) & wait`, stop.signal)
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.ok(heard.some((output) => output.includes("first")), "output arrives while it runs")
    stop.abort()
    const outcome = await running
    assert.strictEqual(outcome.timedOut, "stopped")
    assert.match(outcome.output, /first/)
    await new Promise((resolve) => setTimeout(resolve, 3500))
    assert.ok(!fs.existsSync(marker), "the child it started was ended with it")
  })

  test("a command's own stop ends it alone and says the user stopped it", async function () {
    this.timeout(20000)
    let stop: (() => void) | undefined
    const commands = terminalCommands(() => "allow", path.dirname(file), undefined, {
      onStart: (given) => (stop = given)
    })
    const running = commands.run("echo started; sleep 10")
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.ok(stop, "the stop is handed over as the command starts")
    const started = Date.now()
    stop!()
    const outcome = await running
    assert.ok(Date.now() - started < 3000)
    assert.strictEqual(outcome.stoppedByUser, true)
    assert.match(outcome.output, /started/)
    // The reply's own stop is not the user's stop on the step.
    const reply = new AbortController()
    const next = commands.run("sleep 10", reply.signal)
    await new Promise((resolve) => setTimeout(resolve, 300))
    reply.abort()
    assert.strictEqual((await next).stoppedByUser, undefined)
  })

  test("auto-run is asked for each command, so switching it mid-reply holds for the next one", async () => {
    let mode: "ask" | "allow" = "ask"
    const asked: string[] = []
    const always = new Set<string>()
    const commands = terminalCommands(
      (command) => (always.has(normalCommand(command)) ? "allow" : mode),
      path.dirname(file),
      async (command) => (asked.push(command), false)
    )
    assert.strictEqual(commands.mode, "ask")
    assert.strictEqual((await commands.run("echo one")).ran, false)
    mode = "allow"
    assert.strictEqual(commands.mode, "allow")
    assert.strictEqual((await commands.run("echo two")).ran, true)
    assert.deepStrictEqual(asked, ["echo one"])
    // Always run holds for that exact command, however it is spaced.
    mode = "ask"
    always.add(normalCommand("echo  three "))
    assert.strictEqual((await commands.run("echo three")).ran, true)
    assert.strictEqual((await commands.run("echo four")).ran, false)
    assert.deepStrictEqual(asked, ["echo one", "echo four"])
  })

  test("deleting asks only when git could not bring the file back", async function () {
    this.timeout(20000)
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-chat-del-"))
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" })
    git("init", "-q")
    git("config", "user.email", "t@example.com")
    git("config", "user.name", "T")
    for (const name of ["clean.ts", "changed.ts"]) fs.writeFileSync(path.join(repo, name), "export const a = 1\n")
    fs.mkdirSync(path.join(repo, ".vscode"))
    fs.writeFileSync(path.join(repo, ".vscode", "tasks.json"), "{}\n")
    git("add", ".")
    git("commit", "-qm", "first")
    fs.writeFileSync(path.join(repo, "changed.ts"), "export const a = 2\n")
    fs.writeFileSync(path.join(repo, "new.ts"), "export const n = 1\n")

    const asked: string[] = []
    const apply = editorEdits(new WorkspaceView(repo), "apply", async (detail) => (asked.push(detail), false))
    const clean = await apply.remove(path.join(repo, "clean.ts"))
    assert.ok(clean.ok, clean.message)
    assert.strictEqual(asked.length, 0, "committed and unchanged: git has it, so no question")
    assert.ok(!fs.existsSync(path.join(repo, "clean.ts")))

    for (const name of ["changed.ts", "new.ts"]) {
      const kept = await apply.remove(path.join(repo, name))
      assert.strictEqual(kept.ok, false, name)
      assert.ok(fs.existsSync(path.join(repo, name)), name)
    }
    const guarded = await apply.remove(path.join(repo, ".vscode", "tasks.json"))
    assert.strictEqual(guarded.ok, false)
    assert.deepStrictEqual(asked, [
      "delete changed.ts\n(git has no copy of it as it is now)",
      "delete new.ts\n(git has no copy of it as it is now)",
      "delete .vscode/tasks.json"
    ])
  })

  test("the editor hint names the active file and selection, and only for a file the tools may read", async () => {
    const dir = path.dirname(file)
    fs.writeFileSync(path.join(dir, ".gitignore"), "secret.ts\n")
    fs.writeFileSync(path.join(dir, "secret.ts"), "const key = 1\n")
    const view = new WorkspaceView(dir)
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file))
    editor.selection = new vscode.Selection(2, 0, 2, 0)
    assert.strictEqual(editorHint(view), "The user's active editor is a.ts, cursor on line 3.")
    editor.selection = new vscode.Selection(1, 0, 2, 10)
    assert.strictEqual(editorHint(view), "The user's active editor is a.ts, with lines 2-3 selected.")
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(dir, "secret.ts")))
    assert.strictEqual(editorHint(view), "")

    // An open document is read as the editor has it, unsaved changes and all.
    const shown = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file))
    await shown.edit((b) => b.insert(new vscode.Position(0, 0), "// unsaved\n"))
    assert.match((await openDocumentText(file)) ?? "", /^\/\/ unsaved\n/)
    assert.strictEqual(await openDocumentText(path.join(dir, "not-open.ts")), undefined)
  })

  test("delete and move apply straight away, or wait for approval when reviewing", async () => {
    const dir = path.dirname(file)
    const asked: string[] = []
    const view = new WorkspaceView(dir)
    const apply = editorEdits(view, "apply", async (detail) => (asked.push(detail), true))
    const moved = await apply.move(file, path.join(dir, "moved", "b.ts"))
    assert.ok(moved.ok, moved.message)
    assert.ok(fs.existsSync(path.join(dir, "moved", "b.ts")) && !fs.existsSync(file))

    assert.strictEqual(asked.length, 0, "a move loses nothing, so applying it does not ask")
    const review = editorEdits(view, "review", async (detail) => (asked.push(detail), false))
    const declined = await review.remove(path.join(dir, "moved", "b.ts"))
    assert.deepStrictEqual([declined.ok, asked.length], [false, 1])
    assert.strictEqual(asked[0], "delete moved/b.ts")
    assert.ok(fs.existsSync(path.join(dir, "moved", "b.ts")))

    // Not in a git repository: nothing could bring the file back, so even applying asks.
    const removed = await apply.remove(path.join(dir, "moved", "b.ts"))
    assert.ok(removed.ok, removed.message)
    assert.strictEqual(asked[1], "delete moved/b.ts\n(git has no copy of it as it is now)")
    assert.ok(!fs.existsSync(path.join(dir, "moved", "b.ts")))
  })

  test("the editor reports diagnostics, what is open and selected, and says when it cannot rename", async () => {
    const knowledge = editorKnowledge(new WorkspaceView(path.dirname(file)), "apply", async () => true)
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
      assert.deepStrictEqual(references.map((r) => [r.file, r.line]), [[file, 1], [file, 3]])
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

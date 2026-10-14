import * as assert from "assert"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import { ChangeStore, ReplyChanges, viewOf } from "../../extension/chat/reply-changes"
import { ReplyChangesEditor } from "../../extension/chat/reply-changes-editor"
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

  test("what a reply changed is listed, opens beside what it was, and can be undone", async function () {
    this.timeout(30000)
    const dir = path.dirname(file)
    const view = new WorkspaceView(dir)
    const changes = new ReplyChanges(dir, openDocumentText)
    const apply = editorEdits(view, "apply", async () => true, changes)
    const current = fs.readFileSync(file, "utf8")
    const edited = await apply.edit(file, planReplacement(current, "  return a", "  return a * 2") as Replacement)
    assert.ok(edited.ok, edited.message)
    const created = await apply.create(path.join(dir, "made.ts"), "export const made = 1\n")
    assert.ok(created.ok, created.message)
    fs.writeFileSync(path.join(dir, "keep.ts"), "export const keep = 1\n")
    const moved = await apply.move(path.join(dir, "keep.ts"), path.join(dir, "kept.ts"))
    assert.ok(moved.ok, moved.message)

    const record = await changes.record()
    assert.ok(record)
    assert.deepStrictEqual(
      viewOf(record).files.map(({ path: name, status, added, removed }) => [name, status, added, removed]),
      [
        ["a.ts", "modified", 1, 1],
        ["keep.ts", "deleted", 0, 1],
        ["kept.ts", "created", 1, 0],
        ["made.ts", "created", 1, 0]
      ]
    )
    const store = new ChangeStore(path.join(dir, ".changes"))
    store.save(record)
    const editor = new ReplyChangesEditor(store, openDocumentText)

    await editor.openDiff(record.id, "a.ts")
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab
    assert.ok(tab?.input instanceof vscode.TabInputTextDiff, "a diff opens")
    const before = (tab!.input as vscode.TabInputTextDiff).original
    assert.strictEqual(before.scheme, "twinny-before")
    assert.strictEqual((await vscode.workspace.openTextDocument(before)).getText(), ORIGINAL)

    const one = await editor.undo(record.id, ["made.ts"])
    assert.ok(!fs.existsSync(path.join(dir, "made.ts")), "a new file is taken away")
    assert.deepStrictEqual(one.view?.files.filter((f) => f.undone).map((f) => f.path), ["made.ts"])
    const all = await editor.undo(record.id)
    assert.strictEqual(all.error, undefined)
    assert.strictEqual(fs.readFileSync(file, "utf8"), ORIGINAL, "the edit is put back, and saved")
    assert.ok(fs.existsSync(path.join(dir, "keep.ts")) && !fs.existsSync(path.join(dir, "kept.ts")), "the move is put back")
    assert.ok(all.view?.files.every((f) => f.undone))
    assert.match((await editor.undo("no-such-reply")).error ?? "", /no longer keeps/)
  })

  test("files a command changes join the reply's changes, and undo puts them back", async function () {
    this.timeout(30000)
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-cmd-changes-"))
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" })
    git("init", "-q")
    git("config", "user.email", "t@example.com")
    git("config", "user.name", "T")
    fs.writeFileSync(path.join(repo, ".gitignore"), "build/\n")
    fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1\n")
    git("add", ".")
    git("commit", "-qm", "first")

    const changes = new ReplyChanges(repo, openDocumentText)
    const view = new WorkspaceView(repo, [], undefined, ["secret/"])
    const commands = terminalCommands(() => "allow", repo, undefined, { changes, visible: (file) => view.visible(file) })
    const outcome = await commands.run(
      "sed -i 's/= 1/= 2/' a.ts && echo made > b.ts && mkdir -p build secret && echo out > build/x.js && echo hush > secret/k.ts"
    )
    assert.strictEqual(outcome.exitCode, 0, outcome.output)
    const record = await changes.record()
    assert.deepStrictEqual(
      record && viewOf(record).files.map(({ path: name, status }) => [name, status]),
      [
        ["a.ts", "modified"],
        ["b.ts", "created"]
      ],
      "ignored and blocked files are not listed"
    )
    const store = new ChangeStore(path.join(repo, ".git", "twinny-test-changes"))
    store.save(record!)
    const undone = await new ReplyChangesEditor(store, openDocumentText).undo(record!.id)
    assert.strictEqual(undone.error, undefined)
    assert.strictEqual(fs.readFileSync(path.join(repo, "a.ts"), "utf8"), "export const a = 1\n")
    assert.ok(!fs.existsSync(path.join(repo, "b.ts")))

    // Outside a repository a command runs as ever, and nothing is listed.
    const plain = new ReplyChanges(path.dirname(file))
    const loose = terminalCommands(() => "allow", path.dirname(file), undefined, { changes: plain })
    assert.strictEqual((await loose.run("echo hi > loose.txt")).exitCode, 0)
    assert.strictEqual(await plain.record(), undefined)
  })

  test("an edit that removes lines takes their line breaks too", async () => {
    const removed = await edit("function f() {\n  return a\n}\n", "", "apply")
    assert.ok(removed.ok, removed.message)
    assert.strictEqual(fs.readFileSync(file, "utf8"), "const a = 1\n")
    // The last line, with no line break after it: the one before goes instead.
    const tail = path.join(path.dirname(file), "tail.ts")
    fs.writeFileSync(tail, "const a = 1\nconst b = 2")
    const plan = planReplacement(fs.readFileSync(tail, "utf8"), "const b = 2", "") as Replacement
    const last = await service.chatEdit({ file: tail, ...plan }, "apply")
    assert.ok(last.ok, last.message)
    assert.strictEqual(fs.readFileSync(tail, "utf8"), "const a = 1")
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

  test("a command that leaves something running in the background ends, and takes it with it", async function () {
    this.timeout(20000)
    const marker = path.join(path.dirname(file), "twinny-left-behind")
    const commands = terminalCommands(() => "allow", path.dirname(file))
    const started = Date.now()
    const outcome = await commands.run(`(sleep 2; touch ${marker}) & echo started`)
    assert.ok(Date.now() - started < 3000, "the step ends when the shell does, not when the server would")
    assert.strictEqual(outcome.exitCode, 0)
    assert.match(outcome.output, /started\n\(it left processes running in the background; they were ended with it\)/)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    assert.ok(!fs.existsSync(marker), "what it left running was ended")
  })

  test("a chat that goes ends the commands it started, and only those", async function () {
    this.timeout(20000)
    const closing = new AbortController()
    const mine = terminalCommands(() => "allow", path.dirname(file), undefined, { lifetime: closing.signal })
    const other = terminalCommands(() => "allow", path.dirname(file), undefined, { lifetime: new AbortController().signal })
    const running = mine.run("echo mine; sleep 30")
    const elsewhere = other.run("sleep 1; echo other")
    await new Promise((resolve) => setTimeout(resolve, 300))
    closing.abort()
    const outcome = await running
    assert.strictEqual(outcome.timedOut, "stopped")
    assert.strictEqual((await elsewhere).exitCode, 0, "another chat's command runs on")
  })

  test("a command that ignores SIGTERM is still ended when its time runs out", async function () {
    this.timeout(20000)
    const commands = terminalCommands(() => "allow", path.dirname(file), undefined, { timeoutMs: 800 })
    const started = Date.now()
    const outcome = await commands.run("trap '' TERM; echo ready; sleep 30")
    assert.ok(Date.now() - started < 6000, `ended in ${Date.now() - started} ms`)
    assert.strictEqual(outcome.timedOut, "stopped")
    assert.match(outcome.output, /ready/)
  })

  test("output keeps whole characters however the bytes are split", async function () {
    this.timeout(20000)
    const commands = terminalCommands(() => "allow", path.dirname(file))
    const outcome = await commands.run("for i in $(seq 1 3000); do printf '€€€€€€€€€€'; done; echo")
    assert.strictEqual(outcome.exitCode, 0)
    assert.ok(outcome.output.includes("€€€€"))
    assert.ok(!outcome.output.includes("\uFFFD"), "no replacement characters")
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
    for (const name of ["clean.ts", "changed.ts", "local.json"]) fs.writeFileSync(path.join(repo, name), "export const a = 1\n")
    fs.mkdirSync(path.join(repo, ".vscode"))
    fs.writeFileSync(path.join(repo, ".vscode", "tasks.json"), "{}\n")
    git("add", ".")
    git("commit", "-qm", "first")
    fs.writeFileSync(path.join(repo, "changed.ts"), "export const a = 2\n")
    fs.writeFileSync(path.join(repo, "new.ts"), "export const n = 1\n")
    // Local settings git is told to look away from: it reports them clean whatever they hold.
    git("update-index", "--skip-worktree", "local.json")
    fs.writeFileSync(path.join(repo, "local.json"), "{\"mine\": true}\n")

    const asked: string[] = []
    const apply = editorEdits(new WorkspaceView(repo), "apply", async (detail) => (asked.push(detail), false))
    const clean = await apply.remove(path.join(repo, "clean.ts"))
    assert.ok(clean.ok, clean.message)
    assert.strictEqual(asked.length, 0, "committed and unchanged: git has it, so no question")
    assert.ok(!fs.existsSync(path.join(repo, "clean.ts")))

    for (const name of ["changed.ts", "new.ts", "local.json"]) {
      const kept = await apply.remove(path.join(repo, name))
      assert.strictEqual(kept.ok, false, name)
      assert.ok(fs.existsSync(path.join(repo, name)), name)
    }
    const guarded = await apply.remove(path.join(repo, ".vscode", "tasks.json"))
    assert.strictEqual(guarded.ok, false)
    assert.deepStrictEqual(asked, [
      "delete changed.ts\n(git has no copy of it as it is now)",
      "delete new.ts\n(git has no copy of it as it is now)",
      "delete local.json\n(git has no copy of it as it is now)",
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

  test("an applied edit comes back with the errors it brought into the file, and only those", async function () {
    this.timeout(30000)
    const dir = path.dirname(file)
    const view = new WorkspaceView(dir)
    const apply = editorEdits(view, "apply", async () => true)
    const plan = (target: string, find: string, replace: string) =>
      planReplacement(fs.readFileSync(target, "utf8"), find, replace) as Replacement

    const broken = await apply.edit(file, plan(file, "  return a", "  return a.nope"))
    assert.ok(broken.ok, broken.message)
    assert.strictEqual(broken.newErrors, 1)
    assert.match(
      broken.message,
      /^Applied and saved: .*\nThe editor now reports an error in a\.ts on the lines you changed:\n3: Property 'nope' does not exist on type '1'\. \(ts\)\nFix it if your change caused it\.$/
    )
    const fixed = await apply.edit(file, plan(file, "  return a.nope", "  return a"))
    assert.strictEqual(fixed.newErrors, undefined, "a fix reports nothing")
    // Open and checked now: an error the edit causes away from its own lines is named too.
    const away = await apply.edit(file, plan(file, "const a = 1", "const b = 1"))
    assert.strictEqual(away.newErrors, 1, away.message)
    assert.match(away.message, /in a\.ts that was not there before:\n3: Cannot find name 'a'/)
    await apply.edit(file, plan(file, "const b = 1", "const a = 1"))

    // A file not open until the edit: the errors it already had are not put
    // down to the edit, and one on the lines the edit wrote is.
    const old = path.join(dir, "old.ts")
    fs.writeFileSync(old, "const wrong: number = \"text\"\nexport const value = 1\nexport const other = 1\n")
    const unrelated = await apply.edit(old, plan(old, "export const value = 1", "export const value = 2"))
    assert.ok(unrelated.ok, unrelated.message)
    assert.strictEqual(unrelated.newErrors, undefined, unrelated.message)
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
    const cold = path.join(dir, "cold.ts")
    fs.writeFileSync(cold, "const wrong: number = \"text\"\nexport const value = 1\n")
    const near = await apply.edit(cold, plan(cold, "export const value = 1", "export const value: string = 1"))
    assert.strictEqual(near.newErrors, 1, near.message)
    assert.match(near.message, /in cold\.ts on the lines you changed:\n2: Type 'number' is not assignable to type 'string'\./)

    const created = await apply.create(path.join(dir, "made.ts"), "export const made: string = 1\n")
    assert.strictEqual(created.newErrors, 1, created.message)

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

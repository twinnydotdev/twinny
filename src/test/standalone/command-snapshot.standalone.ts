/**
 * What a command changed in a git working tree, read from two snapshots
 * of the tree taken through a copy of the index: tracked and untracked
 * files, `.gitignore` honoured, the user's staging untouched.
 */
import * as assert from "node:assert"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { changesBetween, snapshotTree } from "../../extension/chat/command-snapshot"
import { ReplyChanges, viewOf } from "../../extension/chat/reply-changes"

const repository = (files: Record<string, string | Buffer>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-snapshot-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString()
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  git("add", ".")
  git("commit", "-qm", "first")
  return { root, git }
}

test("a command's changes are read from the tree before and after: changed, made, removed; ignored files never", async () => {
  const { root, git } = repository({ ".gitignore": "dist/\n", "src/a.ts": "const a = 1\n", "old.ts": "gone soon\n", "dist/out.js": "x" })
  // Work in progress before the command: kept as it was, not as committed.
  fs.writeFileSync(path.join(root, "src/a.ts"), "const a = 2 // unsaved idea\n")
  git("add", "src/a.ts")
  const staged = git("diff", "--cached", "--name-only")

  const before = await snapshotTree(root)
  assert.ok(before)
  fs.writeFileSync(path.join(root, "src/a.ts"), "const a = 3\n")
  fs.writeFileSync(path.join(root, "made by the command.ts"), "new\n")
  fs.rmSync(path.join(root, "old.ts"))
  fs.writeFileSync(path.join(root, "dist/out.js"), "rebuilt")
  const after = await snapshotTree(root)
  assert.ok(after)

  const changes = await changesBetween(before!, after!)
  assert.deepStrictEqual(
    changes?.map(({ file, before: was }) => [path.relative(root, file), was]).sort(),
    [
      ["made by the command.ts", null],
      ["old.ts", "gone soon\n"],
      ["src/a.ts", "const a = 2 // unsaved idea\n"]
    ]
  )
  assert.strictEqual(git("diff", "--cached", "--name-only"), staged, "the user's staging is as it was")
  assert.deepStrictEqual(await changesBetween(after!, after!), [], "nothing changed, nothing listed")
})

test("outside a repository there is no snapshot", async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-nosnapshot-"))
  assert.strictEqual(await snapshotTree(plain), undefined)
})

test("a binary file a command changed is listed but not kept", async () => {
  const { root } = repository({ "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]) })
  const before = await snapshotTree(root)
  fs.writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 3, 4]))
  const changes = await changesBetween(before!, (await snapshotTree(root))!)
  assert.deepStrictEqual(changes?.map((c) => c.before), [undefined])
})

test("a file an edit kept first keeps that copy when a command changes it later", async () => {
  const { root } = repository({ "a.ts": "original\n" })
  const file = path.join(root, "a.ts")
  const changes = new ReplyChanges(root)
  await changes.touch(file)
  fs.writeFileSync(file, "edited by the agent\n")
  const before = await snapshotTree(root)
  fs.writeFileSync(file, "then formatted by a command\n")
  for (const change of (await changesBetween(before!, (await snapshotTree(root))!)) ?? []) changes.touchWith(change.file, change.before)
  const record = await changes.record()
  assert.strictEqual(record?.files[0].before, "original\n")
  assert.deepStrictEqual(viewOf(record!).files.map((f) => f.status), ["modified"])
})

/**
 * What a reply changed and the way back: files kept as they were before
 * the reply first touched them, listed with their line counts when they
 * really changed, and put back unless something changed them since.
 */
import * as assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import {
  ChangeStore,
  MAX_KEPT_FILE_BYTES,
  planUndo,
  ReplyChanges,
  viewOf
} from "../../extension/chat/reply-changes"

const workspace = (files: Record<string, string | Buffer>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-changes-"))
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  return root
}

test("a reply's changes are listed by what really changed, with git's line counts", async () => {
  const root = workspace({
    "src/a.ts": "const a = 1\nconst b = 2\nconst c = 3\n",
    "src/same.ts": "export const same = 1\n",
    "old.ts": "one\ntwo\n",
    "from.ts": "moved\n"
  })
  const at = (file: string) => path.join(root, file)
  const changes = new ReplyChanges(root)
  for (const file of ["src/a.ts", "src/same.ts", "old.ts", "new.ts", "from.ts", "to.ts", "never.ts"]) await changes.touch(at(file))
  fs.writeFileSync(at("src/a.ts"), "const a = 1\nconst b = 20\nconst c = 3\nconst d = 4\n")
  fs.writeFileSync(at("src/same.ts"), "export const same = 2\n")
  fs.writeFileSync(at("src/same.ts"), "export const same = 1\n")
  fs.rmSync(at("old.ts"))
  fs.writeFileSync(at("new.ts"), "export const made = 1\n")
  fs.renameSync(at("from.ts"), at("to.ts"))
  // Touched twice: the copy is of the file as the reply first found it.
  await changes.touch(at("src/a.ts"))

  const record = await changes.record()
  assert.ok(record)
  assert.deepStrictEqual(viewOf(record), {
    id: changes.id,
    files: [
      { path: "from.ts", status: "deleted", added: 0, removed: 1 },
      { path: "new.ts", status: "created", added: 1, removed: 0 },
      { path: "old.ts", status: "deleted", added: 0, removed: 2 },
      { path: "src/a.ts", status: "modified", added: 2, removed: 1 },
      { path: "to.ts", status: "created", added: 1, removed: 0 }
    ]
  })
  assert.strictEqual(record.files.find((f) => f.path === "src/a.ts")?.before, "const a = 1\nconst b = 2\nconst c = 3\n")
  assert.strictEqual(record.files.find((f) => f.path === "new.ts")?.before, null)
  assert.strictEqual(await new ReplyChanges(root).record(), undefined, "a reply that touched nothing changed nothing")
})

test("a file open in the editor is kept as the editor has it, unsaved changes included", async () => {
  const root = workspace({ "a.ts": "on disk\n" })
  const file = path.join(root, "a.ts")
  let editor = "in the editor, unsaved\n"
  const changes = new ReplyChanges(root, async (f) => (f === file ? editor : undefined))
  await changes.touch(file)
  editor = "the agent's version\n"
  const record = await changes.record()
  assert.strictEqual(record?.files[0].before, "in the editor, unsaved\n")
})

test("a byte-order mark is kept apart, as the editor keeps it, so undo does not add a second", async () => {
  const root = workspace({ "bom.ts": "\uFEFFexport const a = 1\n" })
  const file = path.join(root, "bom.ts")
  const changes = new ReplyChanges(root)
  await changes.touch(file)
  fs.writeFileSync(file, "\uFEFFexport const a = 2\n")
  const record = (await changes.record())!
  assert.strictEqual(record.files[0].before, "export const a = 1\n")
  assert.deepStrictEqual([record.files[0].added, record.files[0].removed], [1, 1])
  assert.strictEqual((await planUndo(record, undefined))[0].drifted, false)
})

test("a change still landing when the reply ends is waited for and listed", async () => {
  const root = workspace({ "slow.ts": "before\n" })
  const file = path.join(root, "slow.ts")
  const changes = new ReplyChanges(root)
  void changes.hold(
    (async () => {
      await changes.touch(file)
      await new Promise((resolve) => setTimeout(resolve, 200))
      fs.writeFileSync(file, "after\n")
    })()
  )
  const record = await changes.record()
  assert.deepStrictEqual(record?.files.map((f) => [f.path, f.status]), [["slow.ts", "modified"]])
})

test("a file too large or binary to copy is listed, and not offered for undo", async () => {
  const root = workspace({ "big.txt": "x".repeat(MAX_KEPT_FILE_BYTES + 1), "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]) })
  const changes = new ReplyChanges(root)
  await changes.touch(path.join(root, "big.txt"))
  await changes.touch(path.join(root, "logo.png"))
  fs.writeFileSync(path.join(root, "big.txt"), "small now\n")
  fs.rmSync(path.join(root, "logo.png"))
  const record = await changes.record()
  assert.deepStrictEqual(
    record?.files.map(({ path: file, status, noUndo }) => ({ file, status, noUndo })),
    [
      { file: "big.txt", status: "modified", noUndo: true },
      { file: "logo.png", status: "deleted", noUndo: true }
    ]
  )
  assert.deepStrictEqual(await planUndo(record!, undefined), [], "nothing to put back without a copy")
})

test("undo puts each file back, and says which changed after the reply", async () => {
  const root = workspace({ "a.ts": "before a\n", "b.ts": "before b\n" })
  const changes = new ReplyChanges(root)
  for (const file of ["a.ts", "b.ts", "c.ts"]) await changes.touch(path.join(root, file))
  fs.writeFileSync(path.join(root, "a.ts"), "agent a\n")
  fs.writeFileSync(path.join(root, "b.ts"), "agent b\n")
  fs.writeFileSync(path.join(root, "c.ts"), "agent c\n")
  const record = (await changes.record())!
  // The user goes on to change b.ts by hand.
  fs.writeFileSync(path.join(root, "b.ts"), "agent b, then the user\n")
  const steps = await planUndo(record, undefined)
  assert.deepStrictEqual(
    steps.map(({ path: file, restore, drifted }) => ({ file, restore, drifted })),
    [
      { file: "a.ts", restore: "before a\n", drifted: false },
      { file: "b.ts", restore: "before b\n", drifted: true },
      { file: "c.ts", restore: null, drifted: false }
    ]
  )
  assert.deepStrictEqual((await planUndo(record, ["c.ts"])).map((step) => step.path), ["c.ts"], "one file, when asked for one")
})

test("the store keeps the newest replies, marks what was undone, and reads only its own ids", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-change-store-"))
  const store = new ChangeStore(dir, 2)
  const root = workspace({ "a.ts": "x\n" })
  const ids: string[] = []
  for (let i = 0; i < 3; i++) {
    const changes = new ReplyChanges(root)
    await changes.touch(path.join(root, "a.ts"))
    fs.writeFileSync(path.join(root, "a.ts"), `x${i}\n`)
    const record = (await changes.record())!
    store.save(record)
    ids.push(record.id)
    // Saved a moment apart, so the oldest is plain.
    const old = new Date(Date.now() - (3 - i) * 1000)
    fs.utimesSync(path.join(dir, `${record.id}.json`), old, old)
  }
  store.save(store.load(ids[2])!)
  assert.strictEqual(store.load(ids[0]), undefined, "the oldest went")
  assert.ok(store.load(ids[1]) && store.load(ids[2]))
  const marked = store.markUndone(ids[2], ["a.ts"])
  assert.strictEqual(marked?.files[0].undone, true)
  assert.strictEqual(viewOf(store.load(ids[2])!).files[0].undone, true)
  assert.deepStrictEqual(await planUndo(store.load(ids[2])!, undefined), [], "undone once, not twice")
  assert.strictEqual(store.load("../../etc/passwd"), undefined, "an id that is not one reads nothing")
  assert.strictEqual(store.markUndone("missing", ["a.ts"]), undefined)
})

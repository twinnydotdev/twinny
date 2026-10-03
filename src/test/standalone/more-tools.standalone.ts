/**
 * The tools beyond reading and editing: globs, symbol positions, the
 * read-only git tool (against a real repository) and finding files.
 */
import * as assert from "node:assert"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { globToRegExp, locateSymbol, readOnlyGitArgs, splitArgs } from "../../extension/tools/helpers"
import { workspaceTools } from "../../extension/tools/workspace"

test("globs match relative paths; a bare pattern matches the name anywhere", () => {
  const match = (glob: string, file: string) => globToRegExp(glob).test(file)
  assert.ok(match("*.test.ts", "src/a/b.test.ts"))
  assert.ok(match("**/*.test.ts", "b.test.ts"))
  assert.ok(match("src/**/index.*", "src/a/b/index.tsx"))
  assert.ok(match("src/*.{ts,tsx}", "src/a.tsx"))
  assert.ok(!match("src/*.ts", "src/a/b.ts"))
  assert.ok(!match("*.ts", "src/a.tsx"))
  assert.ok(match("package.json", "package.json"))
})

test("a symbol is found on the line asked for, nearby, or where it is declared", () => {
  const text = "import { warm } from './w'\n\nexport function warmUp() {\n  return warm()\n}\nconst warm = 1"
  assert.deepStrictEqual(locateSymbol(text, "warm", 4), { line: 3, character: 9 })
  assert.deepStrictEqual(locateSymbol(text, "warm", 2), { line: 0, character: 9 }, "nearest line when not on the one asked")
  assert.deepStrictEqual(locateSymbol(text, "warm"), { line: 5, character: 6 }, "the declaration without a line")
  assert.deepStrictEqual(locateSymbol(text, "warmUp"), { line: 2, character: 16 })
  assert.strictEqual(locateSymbol(text, "cold"), undefined)
})

test("git arguments: read-only subcommands only, and settings cannot run programs", () => {
  assert.deepStrictEqual(splitArgs("log -3 --format=\"%h %s\" -- 'a b.ts'"), ["log", "-3", "--format=%h %s", "--", "a b.ts"])
  assert.deepStrictEqual(readOnlyGitArgs("git diff --stat"), ["diff", "--no-ext-diff", "--no-textconv", "--stat"])
  assert.deepStrictEqual(readOnlyGitArgs("status -u"), ["status", "-u"])
  assert.deepStrictEqual(readOnlyGitArgs("branch -a"), ["branch", "-a"])
  assert.deepStrictEqual(readOnlyGitArgs("log -C -n 2"), ["log", "--no-ext-diff", "--no-textconv", "-C", "-n", "2"], "copy detection is a plain diff option")
  assert.deepStrictEqual(readOnlyGitArgs("shortlog -sn"), ["shortlog", "-sn", "HEAD"], "without a revision shortlog would wait on standard input")
  for (const bad of [
    "push",
    "commit -m x",
    "checkout main",
    "diff --output=/tmp/x",
    "-c core.pager=evil log",
    "branch new-thing",
    "branch -D main",
    "diff --ext-diff",
    "diff --no-index /etc/passwd /dev/null",
    "blame --contents /etc/passwd README.md",
    "log -p --no-prefix",
    "log --oneline | head -5",
    "status > out.txt"
  ]) {
    assert.strictEqual(typeof readOnlyGitArgs(bad), "string", bad)
  }
})

const repo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-git-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  fs.mkdirSync(path.join(root, "src"))
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1\n")
  fs.writeFileSync(path.join(root, "src", "a.test.ts"), "test\n")
  fs.writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]))
  git("add", ".")
  git("commit", "-qm", "first")
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 2\n")
  return root
}

test("the git tool reads a real repository and refuses to change it", async () => {
  const tools = workspaceTools(repo())
  const diff = await tools.run({ name: "git", args: { args: "diff" } })
  assert.match(diff.output, /^\$ git diff\n\(exit code 0\)\ndiff --git a\/src\/a.ts b\/src\/a.ts[\s\S]*-export const a = 1\n\+export const a = 2/)
  assert.strictEqual(diff.summary, "git `diff`")
  const log = await tools.run({ name: "git", args: { args: "log --oneline" } })
  assert.match(log.output, /first/)
  const refused = await tools.run({ name: "git", args: { args: "commit -am sneaky" } })
  assert.match(refused.output, /not allowed here/)
  assert.ok(refused.failed)
})

test("find_files finds every file by glob, binaries included", async () => {
  const tools = workspaceTools(repo())
  assert.strictEqual((await tools.run({ name: "find_files", args: { pattern: "*.test.ts" } })).output, "src/a.test.ts")
  assert.strictEqual((await tools.run({ name: "find_files", args: { pattern: "*.png" } })).output, "logo.png")
  assert.strictEqual((await tools.run({ name: "find_files", args: { pattern: "src/**" } })).output, "src/a.test.ts\nsrc/a.ts")
  assert.strictEqual((await tools.run({ name: "find_files", args: { pattern: "*.rs" } })).output, "No files match.")
})

test("editor tools, rename, delete and move are offered only when there is an editor and somewhere for edits to go", () => {
  const names = (tools: ReturnType<typeof workspaceTools>) => tools.tools.map((t) => t.name)
  const root = repo()
  assert.deepStrictEqual(names(workspaceTools(root)), ["list_dir", "find_files", "read_file", "grep", "find_symbol", "git"])
  const noop = async () => ({ ok: true, message: "" })
  const editor = {
    diagnostics: async () => [],
    references: async () => [],
    definition: async () => [],
    rename: noop,
    context: async () => ({ openFiles: [] })
  }
  const edits = { mode: "apply" as const, edit: noop, create: noop, remove: noop, move: noop }
  assert.deepStrictEqual(names(workspaceTools(root, [], { edits, editor })), [
    "editor_context", "list_dir", "find_files", "read_file", "grep", "find_symbol",
    "go_to_definition", "find_references", "diagnostics", "git",
    "edit_file", "create_file", "rename_symbol", "move_file", "delete_file"
  ])
})

test("grep tries the pattern as plain text when it matches nothing as a regex", async () => {
  const root = repo()
  fs.writeFileSync(path.join(root, "keys.json"), "{ \"key\": \"ctrl+i\", \"call\": \"f(x)\" }\n")
  const tools = workspaceTools(root)
  const found = await tools.run({ name: "grep", args: { pattern: "\"key\": \"ctrl+i\"" } })
  assert.match(found.output, /^\(Nothing matched as a regular expression; these match the text as written\.\)\nkeys.json\n1: /)
  assert.strictEqual((await tools.run({ name: "grep", args: { pattern: "f(x)" } })).output.split("\n").length, 3)
  assert.strictEqual((await tools.run({ name: "grep", args: { pattern: "nothing+here" } })).output, "No matches.")
})

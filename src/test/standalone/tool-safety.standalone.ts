/**
 * What the chat's tools must never do, checked against real files and a
 * real git repository: read what a `.gitignore` hides (through a file
 * read, a search, or git's history), reach outside the workspace, or let
 * one tool's failure end a reply. And what the secret shield owes a tool
 * call: the real value going in, the placeholder going back out.
 */
import * as assert from "node:assert"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { TwinnyProvider } from "../../common/types"
import { ChatChunk, ChatRequest, InferenceClient } from "../../extension/inference"
import { mapJsonStrings, shieldClient } from "../../extension/inference/shield"
import { gitNamedPaths, isProtectedPath, withoutHiddenDiffs } from "../../extension/tools/helpers"
import { WorkspaceView } from "../../extension/tools/view"
import { workspaceTools } from "../../extension/tools/workspace"

const write = (root: string, file: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), content)
}

const monorepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-safety-"))
  write(root, ".gitignore", "*.log\n")
  write(root, "app.log", "TOPSECRET in a log\n")
  write(root, "packages/api/.gitignore", ".env\nsecrets/\n")
  write(root, "packages/api/.env", "API_KEY=TOPSECRET\n")
  write(root, "packages/api/secrets/key.txt", "TOPSECRET\n")
  write(root, "packages/api/src/index.ts", "export const api = 1\n")
  write(root, "packages/web/src/index.ts", "export const web = 1 // TOPSECRET is only a word here\n")
  return root
}

test("a .gitignore in a folder below the root hides its files from every tool", async () => {
  const root = monorepo()
  const tools = workspaceTools(root)
  for (const hidden of ["packages/api/.env", "packages/api/secrets/key.txt", "app.log"]) {
    const read = await tools.run({ name: "read_file", args: { path: hidden } })
    assert.match(read.output, /ignored by \.gitignore/, hidden)
  }
  const grep = await tools.run({ name: "grep", args: { pattern: "TOPSECRET" } })
  assert.strictEqual(grep.output, "packages/web/src/index.ts\n1: export const web = 1 // TOPSECRET is only a word here")
  const listed = await tools.run({ name: "list_dir", args: { path: "packages/api" } })
  assert.strictEqual(listed.output, "src/\n.gitignore")
  const found = await tools.run({ name: "find_files", args: { pattern: "**/*" } })
  assert.deepStrictEqual(
    found.output.split("\n"),
    [
      ".gitignore",
      "packages/",
      "packages/api/",
      "packages/api/.gitignore",
      "packages/api/src/",
      "packages/api/src/index.ts",
      "packages/web/",
      "packages/web/src/",
      "packages/web/src/index.ts"
    ],
    "neither the hidden files nor the hidden folder are named"
  )

  const view = new WorkspaceView(root)
  assert.throws(() => view.resolveNew("packages/api/secrets/new.txt"), /ignored by \.gitignore; twinny does not write there/)
  assert.strictEqual(view.resolveNew("packages/api/src/new.ts"), path.join(root, "packages/api/src/new.ts"))
  assert.deepStrictEqual(
    ["packages/api/.env", "packages/web/.env", "packages/api/src/index.ts", "../outside.ts"].map((file) =>
      view.visible(path.join(root, file))
    ),
    [false, true, true, false],
    "the rule belongs to the folder its .gitignore is in"
  )
})

test("paths resolve inside the workspace only, with a root-relative /path read as the model meant it", async () => {
  const root = monorepo()
  const view = new WorkspaceView(root)
  assert.strictEqual(view.resolve("/packages/web/src/index.ts", "file"), path.join(root, "packages/web/src/index.ts"))
  assert.throws(() => view.resolve("/etc/passwd", "file"), /outside the workspace/)
  assert.throws(() => view.resolve("../", "any"), /outside the workspace/)
  assert.throws(() => view.resolveNew("../escape.ts"), /outside the workspace/)
  assert.throws(() => view.resolveNew("packages/api/"), /file path is needed/)
})

test("read_file counts lines as an editor does and never shows a byte-order mark", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-read-"))
  write(root, "three.ts", "a\nb\nc\n")
  write(root, "crlf.ts", "a\r\nb\r\n")
  write(root, "bom.ts", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("const a = 1\n")]))
  write(root, "empty.ts", "")
  const tools = workspaceTools(root)
  const read = (args: Record<string, string>) => tools.run({ name: "read_file", args })
  assert.strictEqual((await read({ path: "three.ts" })).output, "three.ts (lines 1–3 of 3)\n1: a\n2: b\n3: c")
  assert.strictEqual((await read({ path: "crlf.ts" })).output, "crlf.ts (lines 1–2 of 2)\n1: a\n2: b")
  assert.strictEqual((await read({ path: "bom.ts" })).output, "bom.ts (lines 1–1 of 1)\n1: const a = 1")
  assert.strictEqual((await read({ path: "empty.ts" })).output, "empty.ts is empty.")
  assert.strictEqual(
    (await read({ path: "three.ts", start_line: "2", end_line: "1" })).output,
    "three.ts (lines 2–2 of 3)\n2: b",
    "an end before the start reads the start line"
  )
  assert.match((await read({ path: "three.ts", start_line: "9" })).output, /has only 3 lines/)
  // The edit planner sees the same text: line 1 of a file with a mark is still found.
  const edited: string[] = []
  const editing = workspaceTools(root, [], {
    edits: {
      mode: "apply",
      edit: async (_file, replacement) => (edited.push(replacement.text), { ok: true, message: "ok" }),
      create: async () => ({ ok: true, message: "ok" })
    }
  })
  await editing.run({ name: "edit_file", args: { path: "bom.ts", find: "const a = 1", replace: "const a = 2" } })
  assert.deepStrictEqual(edited, ["const a = 2"])
})

test("find_files finds folders too, and a miss points at folders with the word in their name", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-find-"))
  write(root, "src/extension/inference/adapters/http.ts", "x\n")
  write(root, "src/gateway/plugins/inference.ts", "x\n")
  const tools = workspaceTools(root)
  const find = (pattern: string) => tools.run({ name: "find_files", args: { pattern } })
  const both = await find("**/*inference*")
  assert.strictEqual(both.output, "src/extension/inference/\nsrc/gateway/plugins/inference.ts")
  assert.strictEqual(both.summary, "found files `**/*inference*` · 1 file, 1 folder")
  const miss = await find("src/**/*adapter*.ts")
  assert.strictEqual(miss.output, "No files match. Folders with a similar name: src/extension/inference/adapters/")
  assert.strictEqual((await find("*.rs")).output, "No files match.")
})

test("grep tries a pattern the way the model meant it: as text, or with its backslashes un-doubled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-grepfix-"))
  write(root, "package.json", "{ \"key\": \"ctrl+i\", \"command\": \"twinny.edit\" }\n")
  const tools = workspaceTools(root)
  const grep = (pattern: string) => tools.run({ name: "grep", args: { pattern } })
  // `\+` written for the regex, then escaped once more for the JSON it travelled in.
  const doubled = await grep("ctrl\\\\+i")
  assert.strictEqual(
    doubled.output,
    "(Nothing matched as written; these match with each doubled backslash read as one.)\npackage.json\n1: { \"key\": \"ctrl+i\", \"command\": \"twinny.edit\" }"
  )
  assert.match((await grep("ctrl+i")).output, /^\(Nothing matched as a regular expression; these match the text as written\.\)\npackage\.json\n1: /)
  assert.match((await grep("ctrl\\+i")).output, /^package\.json\n1: /, "a pattern that works as written has no note")
  assert.strictEqual((await grep("alt\\\\+q")).output, "No matches.")
})

test("grep shows a few matches per file so one noisy file does not hide the rest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-grep-"))
  write(root, "a/noisy.ts", Array.from({ length: 30 }, (_, i) => `const hit${i} = 1`).join("\n"))
  write(root, "b/quiet.ts", "const hit = 2\n")
  write(root, "c/min.js", `${"x".repeat(3000)} hit at the far end of a minified line\n`)
  const grep = await workspaceTools(root).run({ name: "grep", args: { pattern: "hit" } })
  const lines = grep.output.split("\n")
  assert.strictEqual(lines[0], "a/noisy.ts")
  assert.strictEqual(lines[11], "… 20 more in this file")
  assert.deepStrictEqual(lines.slice(12), ["b/quiet.ts", "1: const hit = 2"])
  assert.strictEqual(grep.summary, "searched for `hit` · 31 matches in 2 files", "a match past a line's first 2000 characters is not looked for")

  // More files match than there is room to show: the rest are named with their counts, busiest first.
  const wide = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-grepwide-"))
  for (let i = 0; i < 8; i++) write(wide, `f${i}.ts`, Array.from({ length: i === 7 ? 3 : 9 }, () => "needle").join("\n"))
  const many = (await workspaceTools(wide).run({ name: "grep", args: { pattern: "needle" } })).output.split("\n")
  // 40 lines go to the first files in order; the fifth is cut short and the rest only named.
  assert.deepStrictEqual(many.slice(-3), [
    "4: needle",
    "… 5 more in this file",
    "… also in f5.ts (9), f6.ts (9), f7.ts (3); narrow the pattern or the path"
  ])
})

const repoWithHistory = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-githist-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  // The user's own settings must not be able to change what the filter reads.
  git("config", "diff.noprefix", "true")
  git("config", "color.ui", "always")
  write(root, ".env", "API_KEY=sk-live-oldsecret\n")
  write(root, "src/a.ts", "export const a = 1\n")
  git("add", ".")
  git("commit", "-qm", "first, with the env file by mistake")
  git("rm", "-q", "--cached", ".env")
  write(root, ".gitignore", ".env\n")
  write(root, "src/a.ts", "export const a = 2\n")
  git("add", ".")
  git("commit", "-qm", "stop tracking .env")
  return root
}

test("git does not hand over what .gitignore hides: not from history, not by name", async () => {
  const tools = workspaceTools(repoWithHistory())
  const log = await tools.run({ name: "git", args: { args: "log -p" } })
  assert.ok(!log.output.includes(String.fromCharCode(27)), "no colour codes, whatever the user's configuration says")
  assert.match(log.output, /diff --git a\/\.env b\/\.env\n\(not shown: the file is outside the workspace or ignored by \.gitignore\)/)
  assert.match(log.output, /-export const a = 1\n\+export const a = 2/, "the rest of the history is all there")
  assert.match(log.summary, /files? left out/)

  for (const args of ["show HEAD~1:.env", "show HEAD~1:./.env", "log -p -- .env", "blame HEAD~1 -- .env"]) {
    const refused = await tools.run({ name: "git", args: { args } })
    assert.match(refused.output, /\.env is outside the workspace or ignored by \.gitignore/, args)
    assert.ok(refused.failed)
  }
  for (const args of ["diff --no-index /etc/passwd /dev/null", "blame --contents /etc/passwd src/a.ts", "log -p --no-prefix"]) {
    const refused = await tools.run({ name: "git", args: { args } })
    assert.match(refused.output, /is not allowed in git here/, args)
  }
  assert.match((await tools.run({ name: "git", args: { args: "shortlog -sn" } })).output, /2\tT/, "shortlog does not hang on standard input")
})

test("with one package of a repository open, git keeps to that package", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-gitsub-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  write(root, "packages/app/src/a.ts", "export const a = 1\n")
  write(root, "packages/other/secret.ts", "export const key = \"sibling-only\"\n")
  git("add", ".")
  git("commit", "-qm", "first")
  const tools = workspaceTools(path.join(root, "packages", "app"))
  const log = await tools.run({ name: "git", args: { args: "log -p" } })
  assert.doesNotMatch(log.output, /sibling-only/)
  assert.match(log.output, /\+export const a = 1/)
  for (const args of ["show HEAD:packages/other/secret.ts", "log -p -- ../other/secret.ts", "log -p -- :/packages/other/secret.ts", "ls-files -- :(top)packages/other", "show HEAD:../other/secret.ts", "blame ../other/secret.ts"]) {
    const refused = await tools.run({ name: "git", args: { args } })
    assert.match(refused.output, /outside the workspace/, args)
  }
  assert.match((await tools.run({ name: "git", args: { args: "show HEAD:packages/app/src/a.ts" } })).output, /export const a = 1/)
  assert.match((await tools.run({ name: "git", args: { args: "log --oneline -- src/a.ts" } })).output, /first/)
})

test("the pieces git's filter is made of", () => {
  assert.deepStrictEqual(gitNamedPaths(["show", "HEAD~1:.env", "v1:./src/a.ts"]), [
    { path: ".env", inRepo: true },
    { path: "src/a.ts", inRepo: false }
  ])
  assert.deepStrictEqual(gitNamedPaths(["log", "-p", "--", "a.ts", "b.ts"]).map((p) => p.path), ["a.ts", "b.ts"])
  assert.deepStrictEqual(gitNamedPaths(["blame", "-L", "1,2", "src/a.ts"]).map((p) => p.path), ["1,2", "src/a.ts"])
  assert.deepStrictEqual(gitNamedPaths(["diff", "main..feature"]), [])
  const merged = "diff --cc secret.env\nindex 1,2..3\n@@@ -1 -1 +1 @@@\n- a\n -b\n++c\ndiff --git a/ok.ts b/ok.ts\n+fine\n"
  assert.deepStrictEqual(withoutHiddenDiffs(merged, (file) => file.endsWith(".env")), {
    text: "diff --cc secret.env\n(not shown: the file is outside the workspace or ignored by .gitignore)\ndiff --git a/ok.ts b/ok.ts\n+fine\n",
    dropped: 1
  })
  assert.deepStrictEqual(withoutHiddenDiffs("M src/a.ts\n", () => true), { text: "M src/a.ts\n", dropped: 0 })
})

test("git is offered only inside a repository", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-nogit-"))
  assert.ok(!workspaceTools(plain).tools.some((tool) => tool.name === "git"))
  assert.ok(workspaceTools(repoWithHistory()).tools.some((tool) => tool.name === "git"))
})

test("the files an edit must not change unreviewed", () => {
  assert.deepStrictEqual(
    [".vscode/settings.json", "packages/a/.vscode/tasks.json", ".gitignore", "packages/a/.gitignore", "src/.vscode.ts", "docs/gitignore.md", ".vscodeignore"].map(
      isProtectedPath
    ),
    [true, true, true, true, false, false, false]
  )
})

test("a tool that throws gives the model an error to read; it does not end the reply", async () => {
  const root = monorepo()
  const tools = workspaceTools(root, [], {
    edits: {
      mode: "apply",
      edit: async () => {
        throw new Error("the editor fell over\nat line 2 of a stack")
      },
      create: async () => ({ ok: true, message: "ok" })
    }
  })
  const result = await tools.run({
    name: "edit_file",
    args: { path: "packages/api/src/index.ts", find: "api = 1", replace: "api = 2" }
  })
  assert.deepStrictEqual(result, {
    output: "edit_file could not run: the editor fell over",
    summary: "edit_file failed · the editor fell over",
    failed: true
  })
})

const PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\"IBAAKCAQEA\\x\n-----END RSA PRIVATE KEY-----"
const TOKEN = `ghp_${"a1B2".repeat(9)}`

test("the shield gives a tool the real value and sends the model's own calls back redacted", async () => {
  const seen: ChatRequest[] = []
  const inner = {
    id: "hosted",
    chat(request: ChatRequest) {
      seen.push(structuredClone(request))
      return (async function* (): AsyncGenerator<ChatChunk> {
        // The model edits the line it was shown, placeholders and all.
        yield {
          content: "",
          finishReason: "stop",
          toolCalls: [
            {
              id: "c1",
              name: "edit_file",
              arguments: JSON.stringify({
                path: "config.ts",
                find: "token = \"REDACTED_GITHUB_TOKEN_1\"",
                replace: "token = process.env.TOKEN // was REDACTED_GITHUB_TOKEN_1\nkey: REDACTED_PRIVATE_KEY_1"
              })
            }
          ]
        }
      })()
    }
  } as unknown as InferenceClient
  const shielded = shieldClient(inner, { provider: "anthropic", label: "A" } as TwinnyProvider)
  const messages = [
    { role: "user", content: "Move the token to the environment." },
    { role: "tool", tool_call_id: "c0", content: `1: const token = "${TOKEN}"\n2: const key = \`${PRIVATE_KEY}\`` }
  ] as unknown as ChatRequest["messages"]

  const chunks: ChatChunk[] = []
  for await (const chunk of shielded.chat({ model: "m", messages })) chunks.push(chunk)
  assert.doesNotMatch(JSON.stringify(seen[0]), /ghp_|MIIEow/, "the provider never sees the values")
  const args = JSON.parse(chunks[0].toolCalls?.[0].arguments ?? "{}")
  assert.strictEqual(args.find, `token = "${TOKEN}"`, "the edit can find the real line in the file")
  assert.ok(args.replace.endsWith(`key: ${PRIVATE_KEY}`), "a value with line breaks and quotes comes back as valid JSON")

  // The loop sends the call back as part of the conversation: redacted again.
  const next = [
    ...messages,
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "edit_file", arguments: chunks[0].toolCalls?.[0].arguments } }]
    }
  ] as unknown as ChatRequest["messages"]
  for await (const chunk of shielded.chat({ model: "m", messages: next })) void chunk
  const sentBack = JSON.stringify(seen[1].messages)
  assert.doesNotMatch(sentBack, /ghp_|MIIEow/)
  assert.match(sentBack, /REDACTED_GITHUB_TOKEN_1/)
})

test("JSON strings are changed one by one; text that is not JSON is changed whole", () => {
  const upper = (text: string) => text.toUpperCase()
  assert.strictEqual(mapJsonStrings("{\"a\":\"x\",\"b\":[\"y\",1,{\"c\":\"z\"}],\"n\":null}", upper), "{\"a\":\"X\",\"b\":[\"Y\",1,{\"c\":\"Z\"}],\"n\":null}")
  assert.strictEqual(mapJsonStrings("not json {", upper), "NOT JSON {")
})

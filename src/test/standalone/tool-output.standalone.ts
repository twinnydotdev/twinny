/**
 * Tool step output read back into code, diffs and locations for the chat
 * to highlight, using what the real tools print.
 */
import * as assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import {
  classifyDiff,
  languageForPath,
  parseCommandRun,
  parseLocatedLines,
  parseReadFile,
  parseSearchHits,
  replacementDiff
} from "../../common/tool-output"
import { workspaceTools } from "../../extension/tools/workspace"

test("read_file output comes back as the file slice, with a real tool's output", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-out-"))
  fs.writeFileSync(path.join(root, "a.ts"), Array.from({ length: 200 }, (_, i) => `const x${i + 1} = ${i + 1}`).join("\n"))
  const { output } = await workspaceTools(root).run({ name: "read_file", args: { path: "a.ts", start_line: "10" } })
  const slice = parseReadFile(output)!
  assert.strictEqual(slice.path, "a.ts")
  assert.strictEqual(slice.startLine, 10)
  assert.strictEqual(slice.code.split("\n")[0], "const x10 = 10")
  assert.strictEqual(slice.code.split("\n").length, 150)
  assert.match(slice.note ?? "", /read on with start_line 160/)
  assert.strictEqual(parseReadFile("a.ts does not exist."), undefined)
  assert.strictEqual(parseReadFile("b.ts (lines 1–3 of 3)\n1: x\n2: y\n3: ")?.code, "x\ny")
})

test("a command's diff is recognised and classified line by line", () => {
  const run = parseCommandRun("$ git diff\n(exit code 0)\ndiff --git a/x.ts b/x.ts\nindex 1..2 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n")!
  assert.deepStrictEqual([run.command, run.status, run.isDiff], ["git diff", "exit code 0", true])
  assert.deepStrictEqual(classifyDiff(run.output).map((l) => l.kind), ["meta", "meta", "meta", "meta", "hunk", "context", "del", "add"])
  const plain = parseCommandRun("$ npm test\n(exit code 1)\n3 failing")!
  assert.deepStrictEqual([plain.isDiff, plain.output], [false, "3 failing"])
})

test("edit_file shows find as removed lines and replace as added", () => {
  assert.deepStrictEqual(replacementDiff("a\nb", "c\n"), [
    { kind: "del", text: "-a" },
    { kind: "del", text: "-b" },
    { kind: "add", text: "+c" }
  ])
})

test("search hits and located lines keep their paths and lines", () => {
  const hits = parseSearchHits("src/a.ts:3-5 (relevance 0.91)\nconst a = 1\nconst b = 2\n\nsrc/b.ts:1-1 (relevance 0.30)\n… (not shown; read_file it)")
  assert.deepStrictEqual(hits, [
    { path: "src/a.ts", startLine: 3, endLine: 5, relevance: "0.91", code: "const a = 1\nconst b = 2" },
    { path: "src/b.ts", startLine: 1, endLine: 1, relevance: "0.30", code: undefined }
  ])
  assert.deepStrictEqual(parseLocatedLines("src/a.ts:12: export class A {\n… 3 more"), [
    { path: "src/a.ts", line: 12, text: "export class A {" }
  ])
  assert.strictEqual(parseLocatedLines("No matches."), undefined)
})

test("languages come from file names", () => {
  assert.deepStrictEqual(
    ["a.ts", "b.tsx", "c.py", "Dockerfile", "d.yml", "e.md", "f.unknown", "g"].map(languageForPath),
    ["typescript", "tsx", "python", "docker", "yaml", "markdown", "text", "text"]
  )
})

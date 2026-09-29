import * as assert from "assert"

import {
  dedupeContextEntries,
  formatContextEntries,
  languageForPath,
  normalizeWorkspacePath,
  workspacePathCandidates
} from "../../extension/chat/context-files"

suite("Attached context", () => {
  test("treats @mention and pinned paths as the same workspace file", () => {
    assert.strictEqual(normalizeWorkspacePath("/package.json"), "package.json")
    assert.strictEqual(normalizeWorkspacePath("/src/a.ts"), "src/a.ts")
    assert.strictEqual(normalizeWorkspacePath("src/a.ts"), "src/a.ts")
    assert.strictEqual(normalizeWorkspacePath("\\src\\a.ts"), "src\\a.ts")
    assert.strictEqual(normalizeWorkspacePath("C:\\repo\\a.ts"), "C:\\repo\\a.ts")
    assert.strictEqual(normalizeWorkspacePath(""), "")
  })

  test("resolves multi-root paths that carry the folder name", () => {
    const roots = [
      { name: "Agent-Test", fsPath: "/Docker/Project/MCP-Server/Agent-Test" },
      { name: "Web server 3", fsPath: "/Docker/Project/Web server 3" }
    ]
    assert.strictEqual(
      workspacePathCandidates("Agent-Test/test.php", roots)[0],
      "/Docker/Project/MCP-Server/Agent-Test/test.php"
    )
    assert.strictEqual(
      workspacePathCandidates("Web server 3/Model.ini", roots)[0],
      "/Docker/Project/Web server 3/Model.ini"
    )
    assert.deepStrictEqual(
      workspacePathCandidates("/src/a.ts", [{ name: "repo", fsPath: "/repo" }]),
      ["/repo/src/a.ts", "/src/a.ts"]
    )
    // Single root: a directory that happens to share the folder's name
    assert.ok(
      workspacePathCandidates("repo/a.ts", [
        { name: "repo", fsPath: "/repo" }
      ]).includes("/repo/repo/a.ts")
    )
    assert.deepStrictEqual(workspacePathCandidates("", roots), [])
  })

  test("maps file extensions to fence languages", () => {
    assert.strictEqual(languageForPath("src/a.ts"), "typescript")
    assert.strictEqual(languageForPath("src/A.PY"), "python")
    assert.strictEqual(languageForPath("Makefile"), "")
    assert.strictEqual(languageForPath("weird.zzz"), "")
  })

  test("drops duplicate files and selections covered by a whole file", () => {
    const entries = dedupeContextEntries([
      { path: "a.ts", content: "1" },
      { path: "a.ts", content: "1" },
      { path: "a.ts", content: "x", range: { startLine: 0, endLine: 0 } },
      { path: "b.ts", content: "y", range: { startLine: 2, endLine: 4 } },
      { path: "b.ts", content: "y", range: { startLine: 2, endLine: 4 } },
      { path: "b.ts", content: "z", range: { startLine: 6, endLine: 6 } }
    ])
    assert.deepStrictEqual(
      entries.map((e) => (e.range ? `${e.path}@${e.range.startLine}` : e.path)),
      ["a.ts", "b.ts@2", "b.ts@6"]
    )
  })

  test("renders headings, fences and one-based line ranges", () => {
    const text = formatContextEntries([
      { path: "src/a.ts", content: "const a = 1" },
      {
        path: "src/b.py",
        content: "print(1)",
        range: { startLine: 4, endLine: 5 }
      }
    ])
    assert.strictEqual(
      text,
      [
        "File: src/a.ts",
        "```typescript",
        "const a = 1",
        "```",
        "",
        "src/b.py (lines 5-6)",
        "```python",
        "print(1)",
        "```"
      ].join("\n")
    )
  })

  test("uses a longer fence when the content contains backticks", () => {
    const text = formatContextEntries([
      { path: "README.md", content: "```js\nx\n```" }
    ])
    assert.ok(text.startsWith("File: README.md\n````\n"))
    assert.ok(text.endsWith("\n````"))
  })

  test("truncates big entries and drops the rest past the total budget", () => {
    const text = formatContextEntries(
      [
        { path: "a.ts", content: "a".repeat(100) },
        { path: "b.ts", content: "b".repeat(100) },
        { path: "c.ts", content: "c".repeat(100) }
      ],
      { maxEntryChars: 50, maxTotalChars: 80 }
    )
    assert.ok(text.includes("a".repeat(50) + "\n[truncated: 50 more characters not shown]"))
    assert.ok(text.includes("File: b.ts"))
    assert.ok(text.includes("b".repeat(30) + "\n[truncated: 70 more"))
    assert.ok(!text.includes("File: c.ts"))
    assert.ok(text.includes("[1 more attached file was left out"))
  })

  test("skips empty entries", () => {
    assert.strictEqual(
      formatContextEntries([{ path: "empty.ts", content: "  \n" }]),
      ""
    )
  })
})

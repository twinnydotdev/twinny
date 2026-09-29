import * as assert from "assert"

import {
  DiffFile,
  noiseReason,
  parseUnifiedDiff,
  partHeading,
  planReview,
  summarizeReview,
  truncateFileDiff
} from "../../extension/review/diff"

const file = (path: string, hunks: string[]): string =>
  [
    `diff --git a/${path} b/${path}`,
    "index 0000000..1111111 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunks
  ].join("\n")

const hunk = (adds: number, dels: number, line = 1) =>
  [
    `@@ -${line},${dels + 1} +${line},${adds + 1} @@`,
    " context",
    ...Array.from({ length: dels }, (_, i) => `-old ${i}`),
    ...Array.from({ length: adds }, (_, i) => `+new ${i}`)
  ].join("\n")

suite("Review diff", () => {
  suite("parseUnifiedDiff", () => {
    test("splits files and counts changes", () => {
      const diff = [file("src/a.ts", [hunk(3, 1)]), file("src/b.ts", [hunk(0, 2)])].join("\n")
      const files = parseUnifiedDiff(diff)
      assert.deepStrictEqual(
        files.map((f) => [f.path, f.status, f.additions, f.deletions]),
        [
          ["src/a.ts", "modified", 3, 1],
          ["src/b.ts", "modified", 0, 2]
        ]
      )
      assert.ok(files[0].text.startsWith("diff --git a/src/a.ts"))
      assert.ok(!files[0].text.includes("src/b.ts"))
    })

    test("recognises added, deleted, renamed and binary files", () => {
      const diff = [
        "diff --git a/new.ts b/new.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/new.ts",
        "@@ -0,0 +1 @@",
        "+hello",
        "diff --git a/gone.ts b/gone.ts",
        "deleted file mode 100644",
        "--- a/gone.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-bye",
        "diff --git a/old.ts b/moved.ts",
        "similarity index 90%",
        "rename from old.ts",
        "rename to moved.ts",
        "--- a/old.ts",
        "+++ b/moved.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "diff --git a/logo.png b/logo.png",
        "Binary files a/logo.png and b/logo.png differ"
      ].join("\n")
      const files = parseUnifiedDiff(diff)
      assert.deepStrictEqual(
        files.map((f) => [f.path, f.status, f.oldPath, f.binary]),
        [
          ["new.ts", "added", undefined, false],
          ["gone.ts", "deleted", undefined, false],
          ["moved.ts", "renamed", "old.ts", false],
          ["logo.png", "modified", undefined, true]
        ]
      )
    })

    test("returns nothing for empty input", () => {
      assert.deepStrictEqual(parseUnifiedDiff(""), [])
    })
  })

  suite("noiseReason", () => {
    const stub = (path: string, binary = false): DiffFile => ({
      path,
      status: "modified",
      binary,
      additions: 1,
      deletions: 0,
      text: `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n+x`
    })

    test("flags lockfiles, minified bundles, assets and binaries", () => {
      assert.strictEqual(noiseReason(stub("package-lock.json")), "lockfile")
      assert.strictEqual(noiseReason(stub("web/yarn.lock")), "lockfile")
      assert.strictEqual(noiseReason(stub("dist/app.min.js")), "minified")
      assert.strictEqual(noiseReason(stub("assets/logo.svg")), "asset")
      assert.strictEqual(noiseReason(stub("photo.jpg", true)), "binary")
      assert.strictEqual(noiseReason(stub("src/app.ts")), undefined)
    })

    test("flags files whose diff has no hunks", () => {
      const modeOnly = { ...stub("script.sh"), text: "diff --git a/script.sh b/script.sh\nold mode 100644\nnew mode 100755" }
      assert.strictEqual(noiseReason(modeOnly), "no content changes")
    })
  })

  suite("truncateFileDiff", () => {
    test("keeps whole hunks and reports what was dropped", () => {
      const parsed = parseUnifiedDiff(
        file("big.ts", [hunk(5, 0, 1), hunk(5, 0, 50), hunk(5, 0, 100)])
      )[0]
      const cut = truncateFileDiff(parsed, 150)
      assert.strictEqual(cut.truncated, true)
      assert.ok(cut.text.includes("@@ -1,1 +1,6 @@"))
      assert.ok(!cut.text.includes("@@ -100,1"))
      assert.ok(/\[\.\.\. \d+ more lines of this file's diff omitted\]$/.test(cut.text))
    })

    test("always keeps the first hunk", () => {
      const parsed = parseUnifiedDiff(file("big.ts", [hunk(40, 0)]))[0]
      const cut = truncateFileDiff(parsed, 60)
      assert.ok(cut.text.includes("+new 39"))
    })
  })

  suite("planReview", () => {
    const files = parseUnifiedDiff(
      [
        file("src/a.ts", [hunk(10, 0)]),
        file("package-lock.json", [hunk(200, 200)]),
        file("src/b.ts", [hunk(10, 0)]),
        file("src/c.ts", [hunk(10, 0)]),
        file("src/d.ts", [hunk(10, 0)])
      ].join("\n")
    )

    test("skips noise and splits the rest into request-sized parts", () => {
      const perFile = files[0].text.length + 1
      const plan = planReview(files, {
        maxCharsPerRequest: perFile * 2,
        maxFileChars: 100000,
        maxParts: 8
      })
      assert.deepStrictEqual(
        plan.parts.map((part) => part.map((f) => f.path)),
        [
          ["src/a.ts", "src/b.ts"],
          ["src/c.ts", "src/d.ts"]
        ]
      )
      assert.deepStrictEqual(
        plan.skipped.map((s) => [s.file.path, s.reason]),
        [["package-lock.json", "lockfile"]]
      )
      assert.strictEqual(plan.unreviewed.length, 0)
      assert.strictEqual(plan.totalAdditions, 240)
    })

    test("leaves files unreviewed past the part limit", () => {
      const perFile = files[0].text.length + 1
      const plan = planReview(files, {
        maxCharsPerRequest: perFile,
        maxFileChars: 100000,
        maxParts: 2
      })
      assert.strictEqual(plan.parts.length, 2)
      assert.deepStrictEqual(
        plan.unreviewed.map((f) => f.path),
        ["src/c.ts", "src/d.ts"]
      )
    })

    test("a single oversized file still gets its own part", () => {
      const plan = planReview(files.slice(0, 1), {
        maxCharsPerRequest: 10,
        maxFileChars: 100000,
        maxParts: 8
      })
      assert.strictEqual(plan.parts.length, 1)
    })
  })

  suite("summarizeReview", () => {
    test("describes the change without including the diff", () => {
      const files = parseUnifiedDiff(
        [file("src/a.ts", [hunk(3, 1)]), file("yarn.lock", [hunk(9, 9)])].join("\n")
      )
      const plan = planReview(files)
      const summary = summarizeReview("PR #7 Add thing", files, plan)
      assert.ok(summary.startsWith("**Code review: PR #7 Add thing**"))
      assert.ok(summary.includes("2 files changed, +12 −10"))
      assert.ok(summary.includes("| `src/a.ts` | modified | +3 −1 |"))
      assert.ok(summary.includes("_Skipped: `yarn.lock` (lockfile)_"))
      assert.ok(!summary.includes("+new 0"), "diff lines leak into summary")
    })
  })

  test("partHeading names the files in a part", () => {
    const part = parseUnifiedDiff(file("src/a.ts", [hunk(1, 0)]))
    assert.strictEqual(partHeading(0, 1, part), "")
    assert.strictEqual(partHeading(1, 3, part), "**Part 2 of 3** · `src/a.ts`\n\n")
  })
})

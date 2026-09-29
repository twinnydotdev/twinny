import * as assert from "assert"

import { buildShellCommandPrompt } from "../../extension/terminal/command"
import { summariseError } from "../../extension/terminal/fix"
import {
  extractFileLocations,
  extractShellCommand,
  formatTerminalRun,
  runFailed,
  stripAnsi,
  tailOutput,
  TerminalRun
} from "../../extension/terminal/output"

const run = (overrides: Partial<TerminalRun> = {}): TerminalRun => ({
  commandLine: "npm test",
  output: "ok",
  exitCode: 0,
  terminal: "bash",
  finishedAt: 1,
  ...overrides
})

suite("Terminal output", () => {
  test("strips colour codes, OSC sequences and carriage returns", () => {
    assert.strictEqual(stripAnsi("\x1b[31mred\x1b[0m"), "red")
    assert.strictEqual(stripAnsi("\x1b]0;title\x07text"), "text")
    assert.strictEqual(stripAnsi("50%\r100%"), "50%100%")
  })

  test("keeps the tail of a long output and says what was cut", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`)
    const tail = tailOutput(lines.join("\n"), { maxLines: 10 })
    assert.ok(tail.startsWith("[290 earlier lines not shown]\n"))
    assert.ok(tail.endsWith("line 300"))
    assert.ok(!tail.includes("line 289\n"))
  })

  test("finds file locations in tsc, node, jest and python output", () => {
    const output = [
      "src/a.ts(12,5): error TS2322: Type 'x' is not assignable",
      "    at run (/home/me/repo/src/b.ts:40:11)",
      "    at Object.<anonymous> (/home/me/repo/node_modules/jest/index.js:1:1)",
      "  ● test › fails",
      "    src/c.test.ts:7:3",
      "  File \"app/main.py\", line 88, in <module>",
      "see https://example.com/docs:80 for more"
    ].join("\n")
    assert.deepStrictEqual(extractFileLocations(output), [
      { path: "/home/me/repo/src/b.ts", line: 40, column: 11 },
      { path: "src/c.test.ts", line: 7, column: 3 },
      { path: "src/a.ts", line: 12, column: 5 },
      { path: "app/main.py", line: 88, column: undefined }
    ])
  })

  test("judges failure by exit code, else by the words in the output", () => {
    assert.ok(runFailed(run({ exitCode: 1 })))
    assert.ok(!runFailed(run({ exitCode: 0, output: "error: none" })))
    assert.ok(runFailed(run({ exitCode: undefined, output: "Error: boom" })))
    assert.ok(!runFailed(run({ exitCode: undefined, output: "all good" })))
  })

  test("formats a run for the prompt", () => {
    const text = formatTerminalRun(
      run({ exitCode: 2, cwd: "/repo", output: "\x1b[31mfail\x1b[0m" })
    )
    assert.ok(text.startsWith("Terminal command (failed with exit code 2) in /repo:"))
    assert.ok(text.includes("```\nnpm test\n```"))
    assert.ok(text.includes("Output:\n```\nfail\n```"))
  })

  test("summarises the error lines of an output", () => {
    const output = "compiling\nsrc/a.ts:1:1 - error TS1005: ';' expected\nFound 1 error."
    assert.strictEqual(
      summariseError(output),
      "src/a.ts:1:1 - error TS1005: ';' expected Found 1 error."
    )
    assert.strictEqual(summariseError("just\nsome\nlines\nhere"), "some lines here")
    assert.ok(summariseError("error ".repeat(200), 50).endsWith("…"))
  })
})

suite("Terminal command generation", () => {
  test("takes the command out of a chatty reply", () => {
    assert.strictEqual(extractShellCommand("ls -la"), "ls -la")
    assert.strictEqual(extractShellCommand("$ ls -la\n"), "ls -la")
    assert.strictEqual(extractShellCommand("`ls -la`"), "ls -la")
    assert.strictEqual(
      extractShellCommand("Here you go:\n```bash\n# list files\nfind . -name '*.ts' | head\n```\nThis lists files."),
      "find . -name '*.ts' | head"
    )
    assert.strictEqual(extractShellCommand("You can use this:\ngit log --oneline"), "git log --oneline")
    assert.strictEqual(extractShellCommand(""), "")
  })

  test("the prompt carries the request, platform, cwd and last command", () => {
    const prompt = buildShellCommandPrompt({
      request: "count lines of typescript",
      platform: "linux",
      shell: "bash",
      cwd: "/repo",
      previous: { commandLine: "ls", output: "a.ts\nb.ts" }
    })
    assert.ok(prompt.includes("single bash command line for linux"))
    assert.ok(prompt.includes("count lines of typescript"))
    assert.ok(prompt.includes("working directory is /repo"))
    assert.ok(prompt.includes("previous command in this terminal was:\nls"))
    assert.ok(prompt.includes("a.ts\nb.ts"))
    assert.ok(prompt.includes("No explanation"))
  })
})

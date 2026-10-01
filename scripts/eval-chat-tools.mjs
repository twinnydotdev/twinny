#!/usr/bin/env node
/**
 * How well a chat model answers questions about this repository with the
 * read-only tools, against the same model answering without them; with
 * `--edits`, how well it changes code with `propose_edit` instead.
 *
 *   npx tsc -p . --outDir out
 *   node scripts/eval-chat-tools.mjs [model] [--base http://localhost:11434/v1] [--runs 1] [--only plain,native,text] [--limit 3]
 *   node scripts/eval-chat-tools.mjs [model] --edits [--only native,text] [--runs 1]
 *
 * Edit tasks run in a throwaway git worktree of HEAD with edits applied
 * as they come (the default \`apply\` mode), then the file is checked and
 * the project type-checked.
 *
 * Goes through the extension's own inference layer (the OpenAI-compatible
 * route, as the chat uses it), so what works here works in the editor.
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const { resolveInferenceProvider } = require(path.join(root, "out/extension/inference"))
const { withTools } = require(path.join(root, "out/extension/tools/loop"))
const { workspaceTools } = require(path.join(root, "out/extension/tools/workspace"))

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}
const model = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "qwen3-coder:30b"
const base = new URL(flag("base", "http://localhost:11434/v1"))
const runs = Number(flag("runs", "1"))
const editing = args.includes("--edits")
const modes = flag("only", editing ? "native,text" : "plain,native,text").split(",")

const provider = {
  id: "eval",
  label: "eval",
  provider: flag("provider", "ollama"),
  type: "chat",
  modelName: model,
  apiProtocol: base.protocol.replace(":", ""),
  apiHostname: base.hostname,
  apiPort: Number(base.port) || (base.protocol === "https:" ? 443 : 80),
  apiPath: base.pathname
}

const ALL_QUESTIONS = [
  ["Which file defines the ModelWarmer class?", /completion\/warm-up\.ts/],
  ["What is the default value of the twinny.reviewMaxDiffChars setting?", /16[,.]?000/],
  ["Which function applies the secret shield to an inference client?", /shieldClient/],
  ["How long does a streamed JSON request in the inference adapters wait for the server before timing out?", /\b60\s*(s\b|sec|seconds)|60[,_]?000/],
  ["Which command is bound to ctrl+i?", /twinny\.edit\b/],
  ["What do gateway invite codes start with?", /twi_/],
  ["How often does ModelWarmer re-warm the model?", /\b4\s*min|240\s*(s\b|sec)|240[,_]?000|4 \* 60/],
  ["Which function turns anything a provider throws into an InferenceError?", /toInferenceError/],
  ["What capabilities does the inference layer define? List them all.", /(?=[\s\S]*\bfim\b)(?=[\s\S]*\bchat\b)(?=[\s\S]*\bembeddings\b)/i],
  ["Which function makes text-only message content a plain string before sending to fluency.js?", /flattenTextContent/]
]

const limit = Number(flag("limit", String(ALL_QUESTIONS.length)))
const QUESTIONS = ALL_QUESTIONS.slice(0, limit)

const SYSTEM =
  "You are twinny, a coding assistant in the user's editor. The user's workspace is the twinny VS Code extension. Answer briefly and precisely."

const ask = async (question, mode, workspace = root, edits = undefined, commands = undefined) => {
  const steps = []
  const fallbacks = []
  let requests = 0
  let maxChars = 0
  const client = resolveInferenceProvider(provider)
  const chat =
    mode !== "plain"
      ? withTools(client, workspaceTools(workspace, [], { edits, commands }), {
          mode,
          onFallback: (reason) => fallbacks.push(reason),
          onStep: (step) => steps.push(step),
          onRequest: (chars) => {
            requests++
            maxChars = Math.max(maxChars, chars)
          }
        })
      : client
  const started = Date.now()
  let text = ""
  try {
    for await (const chunk of chat.chat({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: question }
      ]
    })) {
      text += chunk.content
    }
  } catch (error) {
    text += `\n[error: ${error.message}]`
  }
  return {
    text,
    steps,
    requests,
    fallbacks,
    maxChars,
    seconds: (Date.now() - started) / 1000
  }
}

const results = []
for (const mode of editing ? [] : modes) {
  for (const [question, expected] of QUESTIONS) {
    for (let run = 0; run < runs; run++) {
      const r = await ask(question, mode)
      const answer = r.text.split("\n").filter((l) => !l.startsWith("> ")).join("\n")
      const row = {
        mode,
        question,
        correct: expected.test(answer),
        steps: r.steps.length,
        parseErrors: r.steps.filter((s) => s.parseError).length,
        hitCap: r.requests > 12,
        fellBack: r.fallbacks.length > 0,
        maxChars: r.maxChars,
        seconds: r.seconds
      }
      results.push(row)
      console.log(
        `${row.correct ? "✓" : "✗"} [${mode}] ${question}\n` +
          `    ${r.steps.map((s) => s.summary).join(" | ") || "(no tools)"}\n` +
          `    ${answer.trim().replace(/\s+/g, " ").slice(0, 220)}\n` +
          `    ${row.seconds.toFixed(1)}s${mode !== "plain" ? ` · ${row.steps} steps · ${row.parseErrors} unreadable · max ${row.maxChars} chars${row.fellBack ? " · fell back to text" : ""}` : ""}`
      )
    }
  }
}

const EDIT_TASKS = [
  {
    ask: "Change the warm-up interval in the ModelWarmer code to 5 minutes.",
    file: "src/extension/completion/warm-up.ts",
    expect: /WARM_INTERVAL_MS = (5 \* 60 \* 1000|300_?000)/
  },
  {
    ask: "Raise the connect timeout for streamed JSON requests in the inference adapters to 90 seconds.",
    file: "src/extension/inference/adapters/json-stream.ts",
    expect: /CONNECT_TIMEOUT_MS = (90_?000|90 \* 1000)/
  },
  {
    ask: "Add an exported function isBlank(text: string): boolean to src/common/text.ts that is true for empty or whitespace-only strings.",
    file: "src/common/text.ts",
    expect: /export (const isBlank\b|function isBlank\b)/,
    run: (tree) => {
      const out = path.join(tree, "out-eval")
      execFileSync("npx", ["tsc", "src/common/text.ts", "--outDir", out, "--module", "commonjs"], { cwd: tree, stdio: "ignore" })
      const { isBlank } = require(path.join(out, "text.js"))
      return isBlank("") && isBlank(" \n\t") && !isBlank(" a ")
    }
  },
  {
    ask: "Change the default of the twinny.reviewMaxDiffChars setting to 20000.",
    file: "package.json",
    expect: /"twinny\.reviewMaxDiffChars": \{[^}]*"default": 20000/,
    json: true
  },
  {
    ask: "Rename WARM_INTERVAL_MS to REWARM_INTERVAL_MS everywhere it is used.",
    files: ["src/extension/completion/warm-up.ts", "src/test/suite/warm-up.test.ts"],
    file: "src/extension/completion/warm-up.ts",
    expect: /export const REWARM_INTERVAL_MS\b/,
    run: (tree) => {
      try {
        execFileSync("git", ["grep", "-qw", "WARM_INTERVAL_MS", "--", "src"], { cwd: tree })
        return false
      } catch (error) {
        if (error.status === 1) return true // no uses left
        throw error
      }
    }
  },
  {
    ask: "Create src/common/clamp.ts exporting a function clamp(value: number, min: number, max: number): number.",
    file: "src/common/clamp.ts",
    expect: /export (const|function) clamp\b/,
    run: (tree) => {
      const out = path.join(tree, "out-eval")
      execFileSync("npx", ["tsc", "src/common/clamp.ts", "--outDir", out, "--module", "commonjs"], { cwd: tree, stdio: "ignore" })
      const { clamp } = require(path.join(out, "clamp.js"))
      return clamp(5, 0, 3) === 3 && clamp(-1, 0, 3) === 0 && clamp(2, 0, 3) === 2
    }
  },
  {
    ask: "In the gateway invite code pattern, allow the id part to be 8 to 12 hex characters instead of exactly 8.",
    file: "src/gateway/invites.ts",
    expect: /CODE_PATTERN = \/\^twi_\(\[0-9a-f\]\{8,12\}\)_/
  }
]

/** A worktree of HEAD to edit, with the real node_modules for type-checking. */
const makeTree = () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-edit-eval-"))
  fs.rmSync(tree, { recursive: true })
  execFileSync("git", ["worktree", "add", "--detach", "-q", tree, "HEAD"], { cwd: root })
  fs.symlinkSync(path.join(root, "node_modules"), path.join(tree, "node_modules"))
  return tree
}

const resetTree = (tree) => {
  execFileSync("git", ["checkout", "-q", "--", "."], { cwd: tree })
  execFileSync("git", ["clean", "-fdq", "-e", "node_modules"], { cwd: tree })
}

/** Edits as the editor takes them with `twinny.chatToolsEdits` set to `apply`: written straight away. */
const applyingSink = (log) => ({
  mode: "apply",
  async edit(file, replacement) {
    const lines = fs.readFileSync(file, "utf8").split("\n")
    lines.splice(replacement.startLine, replacement.endLine - replacement.startLine + 1, ...replacement.text.split("\n"))
    fs.writeFileSync(file, lines.join("\n"))
    log.push({ file })
    return { ok: true, message: "Applied and saved. The user can undo it." }
  },
  async create(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    log.push({ file })
    return { ok: true, message: "Created and saved." }
  }
})

/** Commands as `allow` mode runs them: straight away, in the worktree. */
const commandRunner = (tree, ran) => ({
  mode: "allow",
  async run(command) {
    ran.push(command)
    try {
      const output = execFileSync("sh", ["-c", command], { cwd: tree, stdio: "pipe", timeout: 120_000 }).toString()
      return { ran: true, output: output.slice(-4000), exitCode: 0 }
    } catch (error) {
      return { ran: true, output: `${error.stdout ?? ""}${error.stderr ?? ""}`.slice(-4000), exitCode: error.status ?? 1 }
    }
  }
})

const typeChecks = (tree) => {
  try {
    execFileSync("npx", ["tsc", "-p", ".", "--noEmit"], { cwd: tree, stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

if (editing) {
  const tree = makeTree()
  try {
    for (const mode of modes) {
      for (const task of EDIT_TASKS) {
        for (let run = 0; run < runs; run++) {
          resetTree(tree)
          const log = []
          const ran = []
          const r = await ask(task.ask, mode, tree, applyingSink(log), commandRunner(tree, ran))
          const accepted = log[0]
          const target = path.join(tree, task.file)
          const content = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : ""
          const why = []
          if (!accepted) why.push("no edit made")
          const allowed = task.files ?? [task.file]
          const stray = [...new Set(log.map((entry) => path.relative(tree, entry.file)))].filter((f) => !allowed.includes(f))
          if (stray.length) why.push(`also edited ${stray.join(", ")}`)
          if (!task.expect.test(content)) why.push("change not made")
          if (task.json) {
            try {
              JSON.parse(content)
            } catch {
              why.push("invalid JSON")
            }
          } else if (!typeChecks(tree)) why.push("does not type-check")
          if (!why.length && task.run) {
            try {
              if (!task.run(tree)) why.push("wrong behaviour")
            } catch (error) {
              why.push(`failed to run: ${error.message.split("\n")[0]}`)
            }
          }
          const row = {
            mode,
            question: task.ask,
            correct: !why.length,
            steps: r.steps.length,
            parseErrors: r.steps.filter((s) => s.parseError).length,
            failedTools: r.steps.filter((s) => / failed · /.test(s.summary)).length,
            hitCap: r.requests > 12,
            fellBack: r.fallbacks.length > 0,
            maxChars: r.maxChars,
            seconds: r.seconds
          }
          results.push(row)
          console.log(
            `${row.correct ? "✓" : "✗"} [${mode}] ${task.ask}\n` +
              `    ${r.steps.map((s) => s.summary).join(" | ") || "(no tools)"}\n` +
              `    ${why.length ? `✗ ${why.join(", ")} · ` : ""}${r.text.split("\n").filter((l) => !l.startsWith("> ")).join(" ").trim().slice(0, 160)}\n` +
              `    ${row.seconds.toFixed(1)}s · ${row.steps} steps · ${row.failedTools} failed tool calls${ran.length ? ` · ran ${ran.map((c) => `\`${c}\``).join(", ")}` : ""}`
          )
          if (!row.correct && accepted) {
            console.log(execFileSync("git", ["diff", "--", "."], { cwd: tree }).toString().split("\n").slice(0, 20).map((l) => `      ${l}`).join("\n"))
          }
        }
      }
    }
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", tree], { cwd: root })
  }
}

console.log(`\n${model}${editing ? " · edits" : ""}`)
for (const mode of modes) {
  const rows = results.filter((r) => r.mode === mode)
  const correct = rows.filter((r) => r.correct).length
  const avg = (key) => (rows.reduce((s, r) => s + r[key], 0) / rows.length).toFixed(1)
  console.log(
    `${mode.padEnd(6)} ${correct}/${rows.length} correct · avg ${avg("seconds")}s` +
      (mode !== "plain"
        ? ` · avg ${avg("steps")} steps · ${rows.reduce((s, r) => s + r.parseErrors, 0)} unreadable calls · ${rows.filter((r) => r.hitCap).length} hit the cap · largest prompt ${Math.max(...rows.map((r) => r.maxChars))} chars · ${rows.filter((r) => r.fellBack).length} fell back`
        : "")
  )
}

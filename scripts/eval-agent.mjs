#!/usr/bin/env node
/**
 * How well a local model does agent work with twinny's tools, on a small
 * project made for the purpose: nothing in it is in any model's training
 * data or names its own answers. Each task is checked by running code, and
 * the report says what it cost: steps, requests, tokens sent and seconds.
 *
 *   npx tsc -p . --outDir out
 *   node scripts/eval-agent.mjs [model] [--runs 3] [--only native,text] [--tasks fix-bug,rename]
 *   node scripts/eval-agent.mjs [model] --context 8192      (plan for a context this small)
 *   node scripts/eval-agent.mjs [model] --out .claude/eval/out-base   (another build, to compare)
 *   node scripts/eval-agent.mjs [model] --json results.json
 *   node scripts/eval-agent.mjs [model] --keep failures/   (each failed attempt's calls and diff, to read)
 *
 * Compare two builds on the same model with the same --runs; one run of a
 * task swings too much to read anything into.
 */
import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}
const out = path.resolve(root, flag("out", "out"))
const { resolveInferenceProvider } = require(path.join(out, "extension/inference"))
const { withTools, DEFAULT_MAX_STEPS } = require(path.join(out, "extension/tools/loop"))
const { workspaceTools } = require(path.join(out, "extension/tools/workspace"))

const model = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "qwen3-coder:30b"
const base = new URL(flag("base", "http://localhost:11434/v1"))
const runs = Number(flag("runs", "1"))
const modes = flag("only", "native,text").split(",")
const wanted = flag("tasks", "")
const jsonFile = flag("json", "")
/** Where failed attempts are written out in full, when given. */
const keepDir = flag("keep", "") && path.resolve(flag("keep", ""))

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

/** The context the model is loaded with, as Ollama says once it has answered a request. */
const loadedContext = async () => {
  try {
    const client = resolveInferenceProvider(provider)
    for await (const chunk of client.chat({ model, messages: [{ role: "user", content: "Say ok." }], maxTokens: 4 })) void chunk
    const ps = await (await fetch(`${base.origin}/api/ps`)).json()
    return ps.models?.find((m) => m.name === model || m.model === model)?.context_length
  } catch {
    return undefined
  }
}
const contextTokens = Number(flag("context", "0")) || (await loadedContext()) || 32768

// --- The project -----------------------------------------------------------

/** A long module: sixty small functions, with the one the task is about four fifths of the way down. */
const ordersSource = () => {
  const parts = [
    "\"use strict\"",
    "const { formatPrice } = require(\"./format\")",
    "",
    "/** Orders are plain objects: { id, customer, lines: [{ sku, quantity, unitPrice }], status }. */",
    ""
  ]
  const fields = ["customer", "status", "region", "channel", "currency", "warehouse", "carrier", "priority", "source", "segment"]
  for (let i = 0; i < 48; i++) {
    const field = fields[i % fields.length]
    const kind = ["by", "without", "count", "first"][i % 4]
    const name = `${kind}${field[0].toUpperCase()}${field.slice(1)}${Math.floor(i / fields.length) || ""}`
    parts.push(
      "/**",
      ` * ${kind === "by" ? "Orders whose" : kind === "without" ? "Orders except those whose" : kind === "count" ? "How many orders have a" : "The first order whose"} ${field} ${kind === "count" ? "equal to" : "is"} the given value.`,
      " */",
      `function ${name}(orders, value) {`,
      ...(kind === "by"
        ? [`  return orders.filter((order) => order.${field} === value)`]
        : kind === "without"
          ? [`  return orders.filter((order) => order.${field} !== value)`]
          : kind === "count"
            ? ["  let found = 0", "  for (const order of orders) {", `    if (order.${field} === value) found++`, "  }", "  return found"]
            : ["  for (const order of orders) {", `    if (order.${field} === value) return order`, "  }", "  return undefined"]),
      "}",
      ""
    )
    if (i === 38) {
      parts.push(
        "/** One order in brief: how many items it holds and what they come to. */",
        "function summarise(order) {",
        "  let total = 0",
        "  for (const line of order.lines) {",
        "    total += line.quantity * line.unitPrice",
        "  }",
        "  return {",
        "    id: order.id,",
        "    itemCount: order.lines.length,",
        "    total,",
        "    label: `${order.id}: ${formatPrice(total)}`",
        "  }",
        "}",
        ""
      )
    }
  }
  const names = [...parts.join("\n").matchAll(/^function (\w+)/gm)].map((m) => m[1])
  parts.push("module.exports = {", ...names.map((name) => `  ${name},`), "}", "")
  return parts.join("\n")
}

const FILES = {
  "package.json": JSON.stringify({ name: "shopkit", version: "1.0.0", private: true, scripts: { test: "node --test" } }, null, 2) + "\n",
  "README.md": [
    "# shopkit",
    "",
    "A small cart and order library.",
    "",
    "## API",
    "",
    "- `new Cart()`: an empty cart.",
    "- `cart.addItem(id, unitPrice, quantity)`: add a line.",
    "- `cart.total(coupon)`: the total in pence, after an optional coupon.",
    "",
    "## Tests",
    "",
    "Run `npm test`.",
    ""
  ].join("\n"),
  "src/format.js": [
    "\"use strict\"",
    "",
    "/** Pence as pounds: 1250 is \"£12.50\". */",
    "function formatPrice(pence) {",
    "  return `£${(pence / 100).toFixed(2)}`",
    "}",
    "",
    "module.exports = { formatPrice }",
    ""
  ].join("\n"),
  "src/coupons.js": [
    "\"use strict\"",
    "",
    "const KNOWN = { SPRING: 15, VIP: 60, WELCOME: 10 }",
    "",
    "/** No coupon takes off more than this share of a cart, whatever it says. */",
    "function clampPercent(percent) {",
    "  const ceiling = 40",
    "  return Math.max(0, Math.min(ceiling, percent))",
    "}",
    "",
    "/** The percentage a coupon code takes off, or 0 for a code nobody issued. */",
    "function validateCoupon(code) {",
    "  if (typeof code !== \"string\") return 0",
    "  const percent = KNOWN[code.trim().toUpperCase()]",
    "  return percent === undefined ? 0 : clampPercent(percent)",
    "}",
    "",
    "module.exports = { validateCoupon, clampPercent }",
    ""
  ].join("\n"),
  "src/cart.js": [
    "\"use strict\"",
    "const { validateCoupon } = require(\"./coupons\")",
    "const { formatPrice } = require(\"./format\")",
    "",
    "class Cart {",
    "  constructor() {",
    "    this.lines = []",
    "  }",
    "",
    "  addItem(id, unitPrice, quantity = 1) {",
    "    const existing = this.lines.find((line) => line.id === id)",
    "    if (existing) existing.quantity += quantity",
    "    else this.lines.push({ id, unitPrice, quantity })",
    "    return this",
    "  }",
    "",
    "  subtotal() {",
    "    return this.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0)",
    "  }",
    "",
    "  /** The total in pence after the coupon's percentage comes off. */",
    "  total(coupon) {",
    "    const percent = validateCoupon(coupon)",
    "    const subtotal = this.subtotal()",
    "    return Math.round(subtotal - subtotal * percent)",
    "  }",
    "",
    "  describe() {",
    "    return `${this.lines.length} lines, ${formatPrice(this.subtotal())}`",
    "  }",
    "}",
    "",
    "module.exports = { Cart }",
    ""
  ].join("\n"),
  "src/receipt.js": [
    "\"use strict\"",
    "const { formatPrice } = require(\"./format\")",
    "",
    "/** A cart as the lines of a printed receipt. */",
    "function receiptLines(cart, coupon) {",
    "  const rows = cart.lines.map((line) => `${line.quantity} x ${line.id} @ ${formatPrice(line.unitPrice)}`)",
    "  rows.push(`Subtotal ${formatPrice(cart.subtotal())}`)",
    "  rows.push(`Total ${formatPrice(cart.total(coupon))}`)",
    "  return rows",
    "}",
    "",
    "module.exports = { receiptLines }",
    ""
  ].join("\n"),
  "src/config.js": [
    "\"use strict\"",
    "",
    "module.exports = {",
    "  api: {",
    "    baseUrl: \"https://api.shopkit.test\",",
    "    retries: 3",
    "  },",
    "  timeouts: {",
    "    // Opening the connection.",
    "    connectMs: 5000,",
    "    // Waiting for the first byte.",
    "    readMs: 10000,",
    "    // Sending the request body.",
    "    writeMs: 10000",
    "  },",
    "  cache: {",
    "    ttlMs: 60000",
    "  }",
    "}",
    ""
  ].join("\n"),
  "src/orders.js": ordersSource(),
  "test/cart.test.js": [
    "\"use strict\"",
    "const assert = require(\"node:assert\")",
    "const { test } = require(\"node:test\")",
    "const { Cart } = require(\"../src/cart\")",
    "",
    "test(\"subtotal adds the lines\", () => {",
    "  const cart = new Cart().addItem(\"mug\", 800, 2).addItem(\"pen\", 150)",
    "  assert.strictEqual(cart.subtotal(), 1750)",
    "})",
    "",
    "test(\"a coupon takes its percentage off\", () => {",
    "  const cart = new Cart().addItem(\"mug\", 1000)",
    "  assert.strictEqual(cart.total(\"WELCOME\"), 900)",
    "})",
    "",
    "test(\"no coupon, no discount\", () => {",
    "  const cart = new Cart().addItem(\"mug\", 1000)",
    "  assert.strictEqual(cart.total(), 1000)",
    "})",
    ""
  ].join("\n"),
  "test/format.test.js": [
    "\"use strict\"",
    "const assert = require(\"node:assert\")",
    "const { test } = require(\"node:test\")",
    "const { formatPrice } = require(\"../src/format\")",
    "",
    "test(\"formatPrice writes pounds and pence\", () => {",
    "  assert.strictEqual(formatPrice(1250), \"£12.50\")",
    "})",
    ""
  ].join("\n")
}

const makeProject = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-agent-eval-"))
  for (const [file, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), content)
  }
  execFileSync("git", ["init", "-q"], { cwd: dir })
  execFileSync("git", ["add", "-A"], { cwd: dir })
  execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.com", "commit", "-qm", "start"], { cwd: dir })
  return dir
}

// --- Checks ----------------------------------------------------------------

const read = (dir, file) => (fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), "utf8") : "")
const hash = (text) => crypto.createHash("sha1").update(text).digest("hex")

/** Runs a snippet in the project; true when it exits cleanly. */
const passes = (dir, script) => {
  try {
    execFileSync("node", ["-e", script], { cwd: dir, stdio: "pipe", timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

const testsPass = (dir) => {
  try {
    execFileSync("node", ["--test"], { cwd: dir, stdio: "pipe", timeout: 60_000 })
    return true
  } catch {
    return false
  }
}

/** How many tests fail, or 99 when the run itself breaks. */
const failingTests = (dir) => {
  let output = ""
  try {
    output = execFileSync("node", ["--test"], { cwd: dir, stdio: "pipe", timeout: 60_000 }).toString()
  } catch (error) {
    output = String(error.stdout ?? "")
  }
  const failed = /# fail (\d+)/.exec(output)
  return failed ? Number(failed[1]) : 99
}

const unchanged = (dir, file) => hash(read(dir, file)) === hash(FILES[file])

/** Each task: what is asked, and what is wrong with the result (nothing, when it is right). */
const TASKS = [
  {
    id: "fix-bug",
    ask: "npm test fails. Find the bug and fix it. Do not change the tests.",
    check: (dir) => [
      ...(unchanged(dir, "test/cart.test.js") ? [] : ["changed the test"]),
      ...(testsPass(dir) ? [] : ["tests still fail"]),
      ...(passes(dir, "const {Cart}=require('./src/cart');const c=new Cart().addItem('a',2000);if(c.total('SPRING')!==1700||c.total('VIP')!==1200)process.exit(1)")
        ? []
        : ["wrong totals"])
    ]
  },
  {
    id: "long-file",
    ask: "summarise() in src/orders.js reports the wrong itemCount when a line has a quantity above 1: it should be the number of items, not the number of lines. Fix it.",
    check: (dir) =>
      passes(
        dir,
        "const o=require('./src/orders');const s=o.summarise({id:'A1',lines:[{sku:'x',quantity:3,unitPrice:100},{sku:'y',quantity:1,unitPrice:50}]});" +
          "if(s.itemCount!==4||s.total!==350||Object.keys(o).length<49)process.exit(1)"
      )
        ? []
        : ["wrong itemCount, or the module broke"]
  },
  {
    id: "rename",
    ask: "Rename the function formatPrice to formatMoney everywhere: its definition, every use and the tests.",
    check: (dir) => {
      const left = Object.keys(FILES).filter((file) => /\.js$/.test(file) && /formatPrice/.test(read(dir, file)))
      return [
        ...(left.length ? [`formatPrice still in ${left.join(", ")}`] : []),
        ...(/formatMoney/.test(read(dir, "src/format.js")) ? [] : ["no formatMoney defined"]),
        ...(passes(dir, "const o=require('./src/orders');const r=require('./src/receipt');const {Cart}=require('./src/cart');if(o.summarise({id:'A',lines:[]}).label!=='A: £0.00')process.exit(1);r.receiptLines(new Cart().addItem('a',100))")
          ? []
          : ["a module broke"]),
        // The coupon bug is still in the project and fails its one test; nothing else may.
        ...(failingTests(dir) <= 1 ? [] : ["tests fail"])
      ]
    }
  },
  {
    id: "feature",
    ask: "Add a removeItem(id) method to Cart in src/cart.js: it removes the line with that id and returns true when one was removed, false otherwise. Add a test for it to test/cart.test.js, and add a line for it to the API section of README.md.",
    check: (dir) => [
      ...(passes(dir, "const {Cart}=require('./src/cart');const c=new Cart().addItem('a',100).addItem('b',200);if(c.removeItem('a')!==true||c.removeItem('zz')!==false||c.lines.length!==1||c.lines[0].id!=='b')process.exit(1)")
        ? []
        : ["removeItem is wrong or missing"]),
      ...(/removeItem/.test(read(dir, "test/cart.test.js")) ? [] : ["no test added"]),
      ...((read(dir, "test/cart.test.js").match(/\btest\(/g) ?? []).length >= 4 ? [] : ["a test was lost"]),
      ...(/removeItem/.test(read(dir, "README.md")) ? [] : ["README not updated"]),
      // The coupon bug is still in the project, so its test fails either way; the new one must not.
      ...(passes(dir, "const {execFileSync}=require('child_process');let o='';try{o=execFileSync('node',['--test'],{stdio:'pipe'}).toString()}catch(e){o=String(e.stdout)}if(!/# pass [3-9]/.test(o)||!/# fail [01]\\b/.test(o))process.exit(1)")
        ? []
        : ["the new test fails"])
    ]
  },
  {
    id: "multi-edit",
    ask: "Set all three timeouts in src/config.js (connect, read and write) to 30000. Leave everything else as it is.",
    check: (dir) =>
      passes(
        dir,
        "const c=require('./src/config');const t=c.timeouts;if(t.connectMs!==30000||t.readMs!==30000||t.writeMs!==30000||c.api.retries!==3||c.cache.ttlMs!==60000)process.exit(1)"
      )
        ? []
        : ["timeouts not all 30000, or something else changed"]
  },
  {
    id: "question",
    ask: "What is the largest percentage a coupon can take off a cart, and which function enforces that?",
    answer: /(?=[\s\S]*\b40\b)(?=[\s\S]*clampPercent)/
  },
  {
    id: "long-chat",
    // The same small change, asked at the end of a conversation longer than the model's context.
    ask: "Now set all three timeouts in src/config.js (connect, read and write) to 30000. Leave everything else as it is.",
    history: true,
    check: (dir) =>
      passes(
        dir,
        "const c=require('./src/config');const t=c.timeouts;if(t.connectMs!==30000||t.readMs!==30000||t.writeMs!==30000||c.api.retries!==3||c.cache.ttlMs!==60000)process.exit(1)"
      )
        ? []
        : ["timeouts not all 30000, or something else changed"]
  }
].filter((task) => !wanted || wanted.split(",").includes(task.id))

/** Earlier turns about the project, a third more than the context holds. */
const longHistory = () => {
  const source = ordersSource()
  const functions = source.split(/\n(?=\/\*\*)/).slice(1)
  const turns = []
  const target = contextTokens * 3.3 * 1.3
  for (let i = 0, size = 0; size < target; i++) {
    const block = functions[i % functions.length]
    const name = block.match(/function (\w+)/)?.[1] ?? "it"
    const question = `What does ${name} in src/orders.js do? Here it is:\n\n\`\`\`js\n${block.trim()}\n\`\`\``
    const answer =
      `\`${name}\` walks the orders it is given and compares one field of each against the value passed in. ` +
      "It does not change the array or the orders, it is synchronous, and it is exported at the bottom of the module with the others.\n\n" +
      `\`\`\`js\n${block.trim()}\n\`\`\`\n\nNothing else in the project calls it yet (turn ${i + 1}).`
    turns.push({ role: "user", content: question }, { role: "assistant", content: answer })
    size += question.length + answer.length
  }
  return turns
}

// --- Running ---------------------------------------------------------------

const SYSTEM =
  "You are twinny, a coding assistant in the user's editor. The user's workspace is a small JavaScript library. Be brief and precise."

/** Edits as the editor takes them with `twinny.chatToolsEdits` set to `apply`: written straight away. */
const applyingSink = (log) => ({
  mode: "apply",
  async edit(file, replacement) {
    const lines = fs.readFileSync(file, "utf8").split("\n")
    lines.splice(replacement.startLine, replacement.endLine - replacement.startLine + 1, ...(replacement.text === "" ? [] : replacement.text.split("\n")))
    fs.writeFileSync(file, lines.join("\n"))
    log.push(file)
    return { ok: true, message: "Applied and saved. The user can undo it." }
  },
  async create(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    log.push(file)
    return { ok: true, message: "Created and saved." }
  }
})

/** Commands as `allow` mode runs them: straight away, in the project. */
const commandRunner = (dir, ran) => ({
  mode: "allow",
  async run(command) {
    ran.push(command)
    try {
      const output = execFileSync("sh", ["-c", command], { cwd: dir, stdio: "pipe", timeout: 120_000 }).toString()
      return { ran: true, output: output.slice(-4000), exitCode: 0 }
    } catch (error) {
      return { ran: true, output: `${error.stdout ?? ""}${error.stderr ?? ""}`.slice(-4000), exitCode: error.status ?? 1 }
    }
  }
})

/** A failed attempt written out for reading: every call with its result, then what the project ended up as. */
const keepFailure = (task, mode, dir, steps, why, text) => {
  fs.mkdirSync(keepDir, { recursive: true })
  let diff = ""
  try {
    execFileSync("git", ["add", "-A"], { cwd: dir })
    diff = execFileSync("git", ["diff", "--cached"], { cwd: dir }).toString()
  } catch (error) {
    diff = String(error)
  }
  const calls = steps.map(
    (step, i) =>
      `### ${i + 1}. ${step.name ?? "?"}${step.failed ? " (failed)" : ""}\n${JSON.stringify(step.args ?? {})}\n\n${String(step.output ?? "").slice(0, 1500)}`
  )
  const file = path.join(keepDir, `${task.id}-${mode}-${Date.now()}.md`)
  fs.writeFileSync(file, [`# ${task.id} [${mode}]: ${why.join("; ")}`, ...calls, "## Reply", text, "## Diff", diff].join("\n\n"))
}

const attempt = async (task, mode) => {
  const dir = makeProject()
  const steps = []
  const edited = []
  const ran = []
  let requests = 0
  let tokens = 0
  let largest = 0
  let trimmed = 0
  const chat = withTools(
    resolveInferenceProvider(provider),
    workspaceTools(dir, [], { edits: applyingSink(edited), commands: commandRunner(dir, ran) }),
    {
      mode,
      contextWindow: () => contextTokens,
      onTrim: (results) => (trimmed += results),
      onStep: (step) => steps.push(step),
      onRequest: (_chars, _step, _mode, estimated) => {
        requests++
        tokens += estimated
        largest = Math.max(largest, estimated)
      }
    }
  )
  const started = Date.now()
  let text = ""
  try {
    const messages = [{ role: "system", content: SYSTEM }, ...(task.history ? longHistory() : []), { role: "user", content: task.ask }]
    // No reply is worth more than five minutes: one that runs on is a failure, not a hang.
    for await (const chunk of chat.chat({ model, messages }, { signal: AbortSignal.timeout(300_000) })) text += chunk.content
  } catch (error) {
    text += `\n[error: ${error.message}]`
  }
  const seconds = (Date.now() - started) / 1000
  const answer = text.split("\n").filter((line) => !line.startsWith("> ")).join("\n")
  const why = task.answer ? (task.answer.test(answer) ? [] : ["wrong answer"]) : task.check(dir)
  if (why.length && keepDir) keepFailure(task, mode, dir, steps, why, text)
  fs.rmSync(dir, { recursive: true, force: true })
  return {
    task: task.id,
    mode,
    correct: !why.length,
    why,
    steps: steps.length,
    requests,
    tokens,
    largest,
    trimmed,
    seconds,
    unreadable: steps.filter((step) => step.parseError).length,
    failedCalls: steps.filter((step) => step.failed).length,
    hitCap: requests > DEFAULT_MAX_STEPS,
    trace: steps.map((step) => step.summary),
    answer: answer.trim().replace(/\s+/g, " ").slice(0, 200)
  }
}

console.log(`${model} · context ${contextTokens} · ${path.relative(root, out)} · ${runs} run${runs === 1 ? "" : "s"}`)
const rows = []
for (const mode of modes) {
  for (const task of TASKS) {
    for (let run = 0; run < runs; run++) {
      const row = await attempt(task, mode)
      rows.push(row)
      console.log(
        `${row.correct ? "✓" : "✗"} [${mode}] ${task.id} · ${row.seconds.toFixed(1)}s · ${row.steps} steps · ${row.requests} requests · ${row.tokens} tokens sent` +
          `${row.failedCalls ? ` · ${row.failedCalls} failed calls` : ""}${row.unreadable ? ` · ${row.unreadable} unreadable` : ""}${row.trimmed ? ` · ${row.trimmed} trimmed` : ""}${row.hitCap ? " · hit the cap" : ""}\n` +
          `    ${row.trace.join(" | ") || "(no tools)"}\n` +
          `    ${row.why.length ? `✗ ${row.why.join(", ")} · ` : ""}${row.answer}`
      )
    }
  }
}

const mean = (list, key) => list.reduce((sum, row) => sum + row[key], 0) / (list.length || 1)
console.log(`\n${model} · context ${contextTokens} · ${path.relative(root, out)}`)
for (const mode of modes) {
  const mine = rows.filter((row) => row.mode === mode)
  console.log(
    `${mode.padEnd(6)} ${mine.filter((row) => row.correct).length}/${mine.length} correct · ${mean(mine, "seconds").toFixed(1)}s · ${mean(mine, "steps").toFixed(1)} steps · ` +
      `${Math.round(mean(mine, "tokens"))} tokens sent · ${mine.reduce((sum, row) => sum + row.failedCalls, 0)} failed calls · ${mine.reduce((sum, row) => sum + row.unreadable, 0)} unreadable · ` +
      `${mine.reduce((sum, row) => sum + row.trimmed, 0)} trimmed · ${mine.filter((row) => row.hitCap).length} hit the cap`
  )
  for (const task of TASKS) {
    const these = mine.filter((row) => row.task === task.id)
    console.log(
      `  ${task.id.padEnd(11)} ${these.filter((row) => row.correct).length}/${these.length} · ${mean(these, "seconds").toFixed(1)}s · ${mean(these, "steps").toFixed(1)} steps · ${Math.round(mean(these, "tokens"))} tokens`
    )
  }
}
if (jsonFile) fs.writeFileSync(jsonFile, JSON.stringify({ model, contextTokens, out: path.relative(root, out), rows }, null, 2))

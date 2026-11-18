/**
 * Reads that cost fewer steps, the project's check after changes, a task
 * list that is finished, a question put to the user and a web page read:
 * each with a scripted model and real tools, or the tool on its own.
 */
import * as assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { describePolicy, policyIsEmpty } from "../../common/team-policy"
import { parseReadFiles } from "../../common/tool-output"
import { ToolSteps } from "../../extension/chat/tool-steps"
import { ChatChunk, ChatRequest, InferenceClient } from "../../extension/inference"
import { ToolStep, withTools } from "../../extension/tools/loop"
import { askUser, choicesOf, fetchableUrl, fetchUrl, pageText } from "../../extension/tools/outside"
import { CommandSink, EditSink, pathsOf, widenedRange, workspaceTools } from "../../extension/tools/workspace"
import { parseTeamAgentPolicy } from "../../protocol/wire"

type Call = { id: string; name: string; arguments: string }
type Reply = string | { text?: string; calls?: Call[] }

const scripted = (replies: Reply[]) => {
  const requests: ChatRequest[] = []
  const client = {
    id: "scripted",
    chat(request: ChatRequest) {
      requests.push(structuredClone(request))
      const next = replies.shift() ?? ""
      const reply = typeof next === "string" ? { text: next } : next
      return (async function* (): AsyncGenerator<ChatChunk> {
        if (reply.text) yield { content: reply.text }
        if (reply.calls) yield { content: "", toolCalls: reply.calls, finishReason: "stop" }
      })()
    }
  } as unknown as InferenceClient
  return { client, requests }
}

const collect = async (stream: AsyncIterable<ChatChunk>) => {
  let text = ""
  for await (const chunk of stream) text += chunk.content
  return text
}

const workspace = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-up-"))
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  return root
}

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `const x${i + 1} = ${i + 1}`).join("\n")
const call = (id: string, name: string, args: Record<string, unknown>): Call => ({ id, name, arguments: JSON.stringify(args) })
const ask = (content: string): ChatRequest => ({ model: "m", messages: [{ role: "user", content }] })
const lastText = (request: ChatRequest) => {
  const { content } = request.messages[request.messages.length - 1]
  return typeof content === "string" ? content : ""
}

/** Edits written straight to disk, as apply mode does. */
const diskEdits = (): EditSink => ({
  mode: "apply",
  async edit(file, replacement) {
    const lines = fs.readFileSync(file, "utf8").split("\n")
    lines.splice(replacement.startLine, replacement.endLine - replacement.startLine + 1, ...(replacement.text === "" ? [] : replacement.text.split("\n")))
    fs.writeFileSync(file, lines.join("\n"))
    return { ok: true, message: "Applied." }
  },
  async create(file, content) {
    fs.writeFileSync(file, content)
    return { ok: true, message: "Created." }
  }
})

test("a slice with an end is widened; reading on from a line is not", () => {
  assert.deepStrictEqual(widenedRange(50, 100, 210, 500, true), { start: 1, end: 210, whole: true }, "a short file comes whole")
  assert.deepStrictEqual(widenedRange(1, 210, 210, 500, true), { start: 1, end: 210, whole: false }, "already whole")
  assert.deepStrictEqual(widenedRange(50, 100, 210, 150, true), { start: 35, end: 114, whole: false }, "more than one read holds")
  assert.deepStrictEqual(widenedRange(50, 100, 210, 500, false), { start: 35, end: 114, whole: false }, "no room for it whole")
  assert.deepStrictEqual(widenedRange(400, 410, 2000, 500, true), { start: 385, end: 464, whole: false })
  assert.deepStrictEqual(widenedRange(1990, 2000, 2000, 500, true), { start: 1975, end: 2000, whole: false })
  assert.deepStrictEqual(widenedRange(100, 400, 2000, 500, true), { start: 100, end: 400, whole: false }, "wide enough as asked")
  assert.deepStrictEqual(widenedRange(151, undefined, 2000, 500, true), { start: 151, end: 2000, whole: false })
  assert.deepStrictEqual(pathsOf("[\"a.ts\", \"b.ts\", \"a.ts\"]"), ["a.ts", "b.ts"])
  assert.deepStrictEqual(pathsOf("a.ts\n- b.ts\n`c.ts`, d.ts"), ["a.ts", "b.ts", "c.ts", "d.ts"])
  assert.deepStrictEqual(pathsOf(undefined), [])
})

test("read_file reads several files in one call, and a short file whole when a slice is asked for", async () => {
  const root = workspace({ "a.ts": numbered(120), "b.ts": numbered(30), "long.ts": numbered(900) })
  const tools = workspaceTools(root)
  const slice = await tools.run({ name: "read_file", args: { path: "a.ts", start_line: "40", end_line: "60" } })
  assert.match(slice.output, /^a\.ts \(lines 1–120 of 120\)\n1: const x1 = 1\n/)
  assert.match(slice.output, /… that is the whole file/)
  assert.strictEqual(slice.summary, "read `a.ts:1–120`")

  const narrow = await tools.run({ name: "read_file", args: { path: "long.ts", start_line: "400", end_line: "405" } })
  assert.match(narrow.output, /^long\.ts \(lines 385–464 of 900\)/)
  const on = await tools.run({ name: "read_file", args: { path: "long.ts", start_line: "151" } })
  assert.match(on.output, /^long\.ts \(lines 151–300 of 900\)/, "reading on starts where it was asked to")

  const again = await tools.run({ name: "read_file", args: { path: "a.ts", start_line: "1", end_line: "20" } })
  assert.match(again.output, /^a\.ts \(lines 1–20 of 120\)/, "a file already given whole is not sent whole again")
  fs.writeFileSync(path.join(root, "a.ts"), numbered(121))
  const changed = await tools.run({ name: "read_file", args: { path: "a.ts", start_line: "1", end_line: "20" } })
  assert.match(changed.output, /^a\.ts \(lines 1–121 of 121\)/, "changed since: whole again")
  fs.writeFileSync(path.join(root, "a.ts"), numbered(120))

  const several = await tools.run({ name: "read_file", args: { paths: JSON.stringify(["a.ts", "b.ts", "missing.ts"]) } })
  assert.match(several.output, /^a\.ts \(lines 1–120 of 120\)/)
  assert.match(several.output, /\n\nb\.ts \(lines 1–30 of 30\)\n1: const x1 = 1/)
  assert.match(several.output, /missing\.ts: could not be read/)
  assert.strictEqual(several.summary, "read 2 files · `a.ts:1–120`, `b.ts:1–30` · 1 not readable")
  assert.ok(!several.failed)
  assert.deepStrictEqual(parseReadFiles(several.output).map((file) => [file.path, file.startLine, file.code.split("\n").length]), [
    ["a.ts", 1, 120],
    ["b.ts", 1, 30]
  ])
  const none = await tools.run({ name: "read_file", args: { paths: "nope.ts\nnor.ts" } })
  assert.ok(none.failed)
  const many = await tools.run({ name: "read_file", args: { paths: Array.from({ length: 8 }, () => "a.ts").map((file, i) => (i ? `./${"./".repeat(i)}${file}` : file)).join("\n") } })
  assert.match(many.output, /2 more files not read: at most 6 in one call/)
})

/** A command sink that plays exit codes in turn and records what ran. */
const commands = (exits: number[], ran: string[]): CommandSink => ({
  mode: "allow",
  async run(command) {
    ran.push(command)
    const exitCode = exits.shift() ?? 0
    return { ran: true, output: exitCode ? "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'." : "ok", exitCode }
  }
})

test("the project's check runs after changes, and a failure goes back to the model", async () => {
  const root = workspace({ "a.ts": "const a: number = 1\n" })
  const ran: string[] = []
  const steps: ToolStep[] = []
  const { client, requests } = scripted([
    { calls: [call("1", "edit_file", { path: "a.ts", find: "= 1", replace: "= \"one\"" })] },
    "Changed it.",
    { calls: [call("2", "edit_file", { path: "a.ts", find: "\"one\"", replace: "2" })] },
    "Fixed: it is a number again."
  ])
  const tools = workspaceTools(root, [], { edits: diskEdits(), commands: commands([2, 0], ran) })
  const text = await collect(
    withTools(client, tools, { mode: "native", stepLines: false, check: "npx tsc --noEmit", onStep: (step) => steps.push(step) }).chat(ask("make a a string"))
  )
  assert.deepStrictEqual(ran, ["npx tsc --noEmit", "npx tsc --noEmit"], "once after each round of changes")
  assert.strictEqual(requests.length, 4)
  assert.match(lastText(requests[2]), /The project's check \(`npx tsc --noEmit`\) ran after your changes and failed:[\s\S]*TS2322[\s\S]*Fix what your changes broke/)
  assert.deepStrictEqual(requests[2].messages.slice(-2).map((message) => message.role), ["assistant", "user"])
  assert.strictEqual(text, "Changed it.\n\nFixed: it is a number again.")
  assert.deepStrictEqual(steps.map((step) => [step.name, !!step.failed]), [
    ["edit_file", false],
    ["run_command", true],
    ["edit_file", false],
    ["run_command", false]
  ])
  assert.strictEqual(fs.readFileSync(path.join(root, "a.ts"), "utf8"), "const a: number = 2\n")
})

test("the check is not run twice over, without changes, without commands, or more than twice", async () => {
  const root = workspace({ "a.ts": "const a = 1\n" })
  const edit = (id: string, find: string, replace: string) => call(id, "edit_file", { path: "a.ts", find, replace })

  // The model ran it itself after its change, and it passed.
  let ran: string[] = []
  let script = scripted([{ calls: [edit("1", "= 1", "= 2")] }, { calls: [call("2", "run_command", { command: "npm test" })] }, "Done."])
  await collect(withTools(script.client, workspaceTools(root, [], { edits: diskEdits(), commands: commands([0], ran) }), { mode: "native", check: "npm test" }).chat(ask("x")))
  assert.deepStrictEqual(ran, ["npm test"])

  // Nothing changed: nothing to check.
  ran = []
  script = scripted([{ calls: [call("1", "read_file", { path: "a.ts" })] }, "It is 2."])
  await collect(withTools(script.client, workspaceTools(root, [], { edits: diskEdits(), commands: commands([], ran) }), { mode: "native", check: "npm test" }).chat(ask("x")))
  assert.deepStrictEqual(ran, [])

  // No run_command (commands are off): no check.
  script = scripted([{ calls: [edit("1", "= 2", "= 3")] }, "Done."])
  await collect(withTools(script.client, workspaceTools(root, [], { edits: diskEdits() }), { mode: "native", check: "npm test" }).chat(ask("x")))
  assert.strictEqual(script.requests.length, 2)

  // A check that keeps failing is run twice, then the reply ends.
  ran = []
  script = scripted([
    { calls: [edit("1", "= 3", "= 4")] },
    "Done.",
    { calls: [edit("2", "= 4", "= 5")] },
    "Done again.",
    { calls: [edit("3", "= 5", "= 6")] },
    "I could not make it pass."
  ])
  const text = await collect(
    withTools(script.client, workspaceTools(root, [], { edits: diskEdits(), commands: commands([1, 1, 1], ran) }), { mode: "native", stepLines: false, check: "npm test" }).chat(ask("x"))
  )
  assert.strictEqual(ran.length, 2)
  assert.match(text, /I could not make it pass\.$/)
})

test("in text mode the check's verdict rides on the last result and outlasts its trimming; a check out of time says nothing", async () => {
  const body = Array.from({ length: 60 }, (_, i) => `const value${i} = "${"x".repeat(30)}"`).join("\n")
  const root = workspace({ "a.ts": "const a = 1\n", "big.ts": body, "big2.ts": body, "big3.ts": body })
  const textCall = (name: string, args: Record<string, unknown>) => "```tool\n" + JSON.stringify({ name, arguments: args }) + "\n```"
  const ran: string[] = []
  const script = scripted([
    textCall("edit_file", { path: "a.ts", find: "= 1", replace: "= 2" }),
    "",
    textCall("read_file", { path: "big.ts" }),
    textCall("read_file", { path: "big2.ts" }),
    textCall("read_file", { path: "big3.ts" }),
    "Left as it is."
  ])
  const text = await collect(
    withTools(script.client, workspaceTools(root, [], { edits: diskEdits(), commands: commands([1], ran) }), {
      mode: "text",
      stepLines: false,
      check: "npm test",
      contextWindow: () => 2600
    }).chat(ask("x"))
  )
  assert.deepStrictEqual(ran, ["npm test"])
  const roles = (request: ChatRequest) => request.messages.map((message) => message.role).join(" ")
  assert.strictEqual(roles(script.requests[2]), "system user assistant user", "an empty answer adds no turn: the verdict joins the result's")
  assert.match(lastText(script.requests[2]), /<\/tool_result>\n\nThe project's check \(`npm test`\) ran after your changes and failed:/)
  for (const request of script.requests.slice(2)) {
    assert.match(request.messages[3].content as string, /The project's check \(`npm test`\) ran after your changes and failed:/, "kept through trimming")
  }
  assert.strictEqual(text, "Left as it is.")

  // Stopped at the wait: failed as a command, but not a verdict on the changes.
  const slow: CommandSink = { mode: "allow", run: async () => ({ ran: true, output: "still compiling", timedOut: "stopped" }) }
  const quiet = scripted([{ calls: [call("1", "edit_file", { path: "a.ts", find: "= 2", replace: "= 3" })] }, "Done."])
  await collect(withTools(quiet.client, workspaceTools(root, [], { edits: diskEdits(), commands: slow }), { mode: "native", check: "npm test" }).chat(ask("x")))
  assert.strictEqual(quiet.requests.length, 2)
})

test("a model that answers with its list still open is told once, unless it is asking the user", async () => {
  const root = workspace({ "a.ts": "const a = 1\n", "b.ts": "const b = 1\n" })
  const list = (tasks: string) => call("t", "update_tasks", { tasks })
  const edit = (id: string, file: string) => call(id, "edit_file", { path: file, find: "= 1", replace: "= 2" })
  let script = scripted([
    { calls: [list("[ ] change a\n[ ] change b")] },
    { calls: [edit("1", "a.ts")] },
    "I changed a.",
    { calls: [edit("2", "b.ts")] },
    "Both are changed."
  ])
  const text = await collect(withTools(script.client, workspaceTools(root, [], { edits: diskEdits() }), { mode: "native", stepLines: false }).chat(ask("change both")))
  assert.strictEqual(script.requests.length, 5)
  assert.match(lastText(script.requests[3]), /Your task list still has open steps:\n\n\[ \] change a\n\[ \] change b\n\nCarry on with the next one now/)
  assert.strictEqual(text, "I changed a.\n\nBoth are changed.", "told once: the second answer ends the reply")
  assert.strictEqual(fs.readFileSync(path.join(root, "b.ts"), "utf8"), "const b = 2\n")

  // A question to the user is left to be asked; so is a list nothing was done on.
  fs.writeFileSync(path.join(root, "a.ts"), "const a = 1\n")
  script = scripted([{ calls: [list("[ ] change a\n[ ] change b")] }, { calls: [edit("1", "a.ts")] }, "Should b change too?"])
  await collect(withTools(script.client, workspaceTools(root, [], { edits: diskEdits() }), { mode: "native" }).chat(ask("x")))
  assert.strictEqual(script.requests.length, 3)
  script = scripted([{ calls: [list("[ ] change a\n[ ] change b")] }, "Here is the plan."])
  await collect(withTools(script.client, workspaceTools(root, [], { edits: diskEdits() }), { mode: "native" }).chat(ask("x")))
  assert.strictEqual(script.requests.length, 2)
})

test("ask_user puts the question and its choices to the user and gives the model the answer", async () => {
  assert.deepStrictEqual(choicesOf("[\"REST\", \"GraphQL\", \"REST\"]"), ["REST", "GraphQL"])
  assert.deepStrictEqual(choicesOf("1. keep it\n2) drop it\n- ask later"), ["keep it", "drop it", "ask later"])
  assert.strictEqual(choicesOf("a\nb\nc\nd\ne").length, 4)
  assert.deepStrictEqual(choicesOf(""), [])

  const asked: [string, string[]][] = []
  const tool = askUser({
    async ask(question, choices) {
      asked.push([question, choices])
      return choices[1]
    }
  })
  const answered = await tool.run({ question: "Which API style?", choices: "[\"REST\", \"GraphQL\"]" })
  assert.deepStrictEqual(asked, [["Which API style?", ["REST", "GraphQL"]]])
  assert.strictEqual(answered.output, "The user answered: GraphQL")
  assert.strictEqual(answered.summary, "asked: Which API style? · GraphQL")
  const silent = await askUser({ ask: async () => undefined }).run({ question: "Which?" })
  assert.match(silent.output, /did not answer[\s\S]*say in your reply what you assumed/)
  await assert.rejects(tool.run({ question: " " }), /needs a question/)

  // Through the chat's steps: the step waits with the choices, and the answer comes back.
  const sent: unknown[] = []
  const steps = new ToolSteps((list) => sent.push(structuredClone(list)))
  steps.start({ id: "0.0", name: "ask_user", args: { question: "Which?" } })
  const waiting = steps.ask("Which?", ["one", "two"])
  assert.deepStrictEqual(
    [steps.steps[0].status, steps.steps[0].approval, steps.steps[0].command, steps.steps[0].choices],
    ["waiting", "question", "Which?", ["one", "two"]]
  )
  steps.answer("0.0", true, " two ")
  assert.strictEqual(await waiting, "two")
  assert.deepStrictEqual([steps.steps[0].status, steps.steps[0].choices, steps.steps[0].approval], ["running", undefined, undefined])
  steps.start({ id: "1.0", name: "ask_user", args: {} })
  const skipped = steps.ask("Again?", [])
  steps.cancelWaiting()
  assert.strictEqual(await skipped, undefined)
  steps.start({ id: "2.0", name: "ask_user", args: {} })
  const empty = steps.ask("Again?", [])
  steps.answer("2.0", true, "  ")
  assert.strictEqual(await empty, undefined, "an empty answer is no answer")
})

test("fetch_url reads a page as text, only after the user says so", async () => {
  assert.strictEqual(fetchableUrl(" https://docs.example.com/a?b=1 ").href, "https://docs.example.com/a?b=1")
  for (const bad of ["", "docs.example.com", "file:///etc/passwd", "ftp://example.com/x", "https://user:pw@example.com/"]) {
    assert.throws(() => fetchableUrl(bad), /fetch_url|web address/, bad)
  }

  const html = `<!doctype html><html><head><title>Retry &amp; backoff</title><style>p{color:red}</style><script>track("x")</script></head>
<body><nav><a href="/">Home</a><a href="/docs">Docs</a></nav>
<main><h1>Retry</h1><p>Call <code>retry(fn)</code> to try   again&nbsp;later.</p><ul><li>max: 3</li><li>delay &lt; 5s</li></ul>
<pre><code class="ts">const r = retry(fn, {
  max: 3
})</code></pre><p>${"More words about retrying. ".repeat(12)}</p></main><footer>© Example</footer></body></html>`
  const page = pageText(html)
  assert.strictEqual(page.title, "Retry & backoff")
  assert.match(page.text, /^# Retry\n\nCall retry\(fn\) to try again later\.\n\n- max: 3\n- delay < 5s\n\n```\nconst r = retry\(fn, \{\n {2}max: 3\n\}\)\n```\n\nMore words/)
  assert.ok(!/track|color:red|Home|Example/.test(page.text), "scripts, styles, navigation and the footer are left out")

  const asked: string[] = []
  const fetched: string[] = []
  const respond = (body: string, type: string, status = 200) =>
    (async (url: string) => {
      fetched.push(url)
      return new Response(body, { status, headers: { "content-type": type } })
    }) as unknown as typeof fetch
  const tool = (allow: boolean, fetcher: typeof fetch) =>
    fetchUrl({
      async approve(url) {
        asked.push(url)
        return allow
      },
      fetch: fetcher
    })

  const read = await tool(true, respond(html, "text/html; charset=utf-8")).run({ url: "https://docs.example.com/retry" })
  assert.deepStrictEqual(asked, ["https://docs.example.com/retry"])
  assert.match(read.output, /^https:\/\/docs\.example\.com\/retry\nRetry & backoff\n\n# Retry\n/)
  assert.match(read.summary, /^fetched `docs\.example\.com\/retry` · \d+ lines$/)
  assert.ok(!read.failed)

  fetched.length = 0
  const skipped = await tool(false, respond(html, "text/html")).run({ url: "https://docs.example.com/retry" })
  assert.deepStrictEqual(fetched, [], "nothing is fetched when the user skips it")
  assert.match(skipped.output, /chose not to fetch/)

  const json = await tool(true, respond("{\"version\": \"2.1.0\"}", "application/json")).run({ url: "https://registry.example.com/pkg" })
  assert.match(json.output, /\{"version": "2\.1\.0"\}/)
  const moved = (async () => new Response(null, { status: 302, headers: { location: "/v2/retry?x=1" } })) as unknown as typeof fetch
  const redirect = await tool(true, moved).run({ url: "https://docs.example.com/retry" })
  assert.match(redirect.output, /redirects to https:\/\/docs\.example\.com\/v2\/retry\?x=1\. It was not followed/)
  assert.strictEqual(redirect.summary, "`docs.example.com/retry` redirects to `docs.example.com`")
  await assert.rejects(tool(true, respond("x", "image/png")).run({ url: "https://example.com/a.png" }), /is image\/png, not text/)
  await assert.rejects(tool(true, respond("gone", "text/plain", 404)).run({ url: "https://example.com/x" }), /answered 404/)
  const long = await tool(true, respond("word ".repeat(5000), "text/plain")).run({ url: "https://example.com/long" }, { roomChars: 3000 })
  assert.match(long.output, /… \(\d+ more characters not shown\)$/)
  assert.ok(long.output.length < 3200)

  // Offered only when the host gives a way to ask; never by default.
  const root = workspace({ "a.ts": "x" })
  assert.ok(!workspaceTools(root).tools.some((item) => item.name === "fetch_url" || item.name === "ask_user"))
  const offered = workspaceTools(root, [], { web: { approve: async () => true }, ask: { ask: async () => "yes" } }).tools.map((item) => item.name)
  assert.ok(offered.includes("fetch_url") && offered.includes("ask_user"))
})

test("a team can take web pages away from agent mode", () => {
  assert.deepStrictEqual(parseTeamAgentPolicy({ fetch: "off" }), { fetch: "off" })
  assert.deepStrictEqual(parseTeamAgentPolicy({ fetch: "allowlist" }), { fetch: "off" }, "a rule from a newer gateway reads as off")
  assert.deepStrictEqual(describePolicy({ agent: { fetch: "off" } }), ["Agent mode reads no web pages."])
  assert.ok(!policyIsEmpty({ agent: { fetch: "off" } }))
})

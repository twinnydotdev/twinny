/**
 * What the agent does to get more out of a small local model: reads sized
 * to the context, edits by line, everywhere or several at once, a
 * conversation folded when it outgrows the context, results that leave
 * a digest when trimmed, a record of what a reply did, and a task list.
 */
import * as assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { ChatChunk, ChatRequest, InferenceClient } from "../../extension/inference"
import { compactHistory, FOLD_HEADER, planContext, trimmedResult } from "../../extension/tools/budget"
import { planEdits, planLines } from "../../extension/tools/edit"
import { withTools } from "../../extension/tools/loop"
import { outlineOf } from "../../extension/tools/outline"
import { findFencedCall } from "../../extension/tools/protocol"
import { parseTasks, renderTasks, Task } from "../../extension/tools/tasks"
import { workspaceTools } from "../../extension/tools/workspace"

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

const drain = async (stream: AsyncIterable<ChatChunk>) => {
  let text = ""
  for await (const chunk of stream) text += chunk.content
  return text
}

const workspace = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-local-"))
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  return root
}

const call = (id: string, name: string, args: Record<string, unknown>): Call => ({ id, name, arguments: JSON.stringify(args) })
const ask = (content: string): ChatRequest => ({ model: "m", messages: [{ role: "user", content }] })

/** Edits written to disk as they come, as the editor's apply mode does. */
const writing = () => ({
  mode: "apply" as const,
  edit: async (file: string, plan: { startLine: number; endLine: number; text: string }) => {
    const lines = fs.readFileSync(file, "utf8").split("\n")
    lines.splice(plan.startLine, plan.endLine - plan.startLine + 1, ...(plan.text === "" ? [] : plan.text.split("\n")))
    fs.writeFileSync(file, lines.join("\n"))
    return { ok: true, message: "Applied." }
  },
  create: async (file: string, content: string) => {
    fs.writeFileSync(file, content)
    return { ok: true, message: "Created." }
  }
})

const functions = (count: number) =>
  Array.from({ length: count }, (_, i) => `function step${i}(value) {\n  return value + ${i}\n}\n`).join("\n")

test("a read is as long as the context has room for, and says what is defined below where it stops", async () => {
  const root = workspace({ "long.js": functions(200) })
  const tools = workspaceTools(root)
  const unknown = await tools.run({ name: "read_file", args: { path: "long.js" } })
  assert.match(unknown.output, /^long\.js \(lines 1–150 of 799\)/, "150 lines when nothing is known of the context")
  assert.match(unknown.output, /stopped at line 150 of 799; read on with start_line 151\nDefined further down \(line\): step38 \(153\), step39 \(157\)/)

  const roomy = await tools.run({ name: "read_file", args: { path: "long.js" } }, { roomChars: 21_000 })
  assert.match(roomy.output, /^long\.js \(lines 1–466 of 799\)/, "a 32k context reads three times as much in one request")
  assert.ok(roomy.output.length <= 21_000)

  const tight = await tools.run({ name: "read_file", args: { path: "long.js" } }, { roomChars: 2000 })
  const shown = Number(/lines 1–(\d+) of/.exec(tight.output)?.[1])
  assert.ok(shown >= 40 && shown < 150 && tight.output.length <= 2000, `a small one stops on a line inside its room: ${shown}`)
  assert.match(tight.output, /Defined further down/)

  assert.match(roomy.digest ?? "", /^long\.js \(lines 1–466 of 799\); defined there \(line\): step0 \(1\), step1 \(5\)/)
  const ranged = await tools.run({ name: "read_file", args: { path: "long.js", start_line: "153", end_line: "155" } })
  assert.ok(!ranged.output.includes("Defined further down"), "a range that was asked for and given whole has nothing to add")
})

test("an outline names declarations across languages and skips control flow", () => {
  const lines = [
    "export async function load(a) {",
    "  if (a) {",
    "  }",
    "}",
    "class Cart {",
    "  total(coupon) {",
    "  }",
    "}",
    "def parse(text):",
    "pub fn run() {",
    "export const LIMIT = 4",
    "func (s *Server) Serve() {",
    "  for (const x of y) {"
  ]
  assert.deepStrictEqual(
    outlineOf(lines).found.map(({ name, line }) => `${name}:${line}`),
    ["load:1", "Cart:5", "total:6", "parse:9", "run:10", "LIMIT:11", "Serve:12"]
  )
  assert.deepStrictEqual(outlineOf(lines, 0, lines.length, 2), { found: [{ line: 1, name: "load" }, { line: 5, name: "Cart" }], more: true })
})

test("a trimmed result leaves its digest, or its first line when it has none", () => {
  assert.strictEqual(
    trimmedResult("a.ts (lines 1–3 of 3)\n1: x", "a.ts (lines 1–3 of 3); defined there (line): x (1)"),
    "a.ts (lines 1–3 of 3); defined there (line): x (1)\n[The rest was trimmed to save context. Run the tool again if you need it.]"
  )
  assert.match(trimmedResult("first\nsecond"), /^first\n\[The rest/)
})

test("edit_file rewrites lines by number, but only numbers from a read the file has not changed since", async () => {
  const root = workspace({ "a.js": "const a = 1\nconst b = 2\nconst c = 3\nconst d = 4\n" })
  const file = path.join(root, "a.js")
  const tools = workspaceTools(root, [], { edits: writing() })
  const blind = await tools.run({ name: "edit_file", args: { path: "a.js", start_line: "2", end_line: "2", replace: "const b = 20" } })
  assert.ok(blind.failed, "not read yet: nothing is changed")
  assert.match(blind.output, /has not been read since it last changed[\s\S]*Lines 1–4 are now:\n1: const a = 1\n2: const b = 2/)
  assert.strictEqual(fs.readFileSync(file, "utf8").split("\n")[1], "const b = 2")

  // The refusal showed the lines, so the same call now holds.
  const made = await tools.run({ name: "edit_file", args: { path: "a.js", start_line: "2", end_line: "2", replace: "const b = 20" } })
  assert.ok(!made.failed)
  assert.strictEqual(made.summary, "edited `a.js:2`")
  assert.match(made.output, /^Applied\.\nLines 1–4 are now:\n1: const a = 1\n2: const b = 20\n3: const c = 3\n4: const d = 4$/)

  // One edit after another needs no read between them: the result gave the new numbers.
  const next = await tools.run({ name: "edit_file", args: { path: "a.js", start_line: "3", end_line: "4", replace: "3: const cd = 7" } })
  assert.ok(!next.failed)
  assert.strictEqual(fs.readFileSync(file, "utf8"), "const a = 1\nconst b = 20\nconst cd = 7\n", "pasted line numbers are dropped")

  // Changed behind the model's back (the user typing): refused again, with the lines as they are.
  fs.writeFileSync(file, "// header\nconst a = 1\nconst b = 20\nconst cd = 7\n")
  const stale = await tools.run({ name: "edit_file", args: { path: "a.js", start_line: "1", replace: "const a = 100" } })
  assert.ok(stale.failed)
  assert.match(stale.output, /Lines 1–3 are now:\n1: \/\/ header/)
  assert.strictEqual(fs.readFileSync(file, "utf8").split("\n")[0], "// header")

  assert.match(planLines("a\nb", 3, 4, "x") as string, /only 2 lines/)
  assert.match(planLines("a\nb", 2, 1, "x") as string, /end_line not before start_line/)
  assert.match(planLines("a\nb", 1, 1, "a") as string, /nothing would change/)
})

test("an edit to a file the model has not read, with a find that is nowhere near, gets the file back rather than advice", async () => {
  const root = workspace({ "config.js": "module.exports = {\n  connectMs: 5000,\n  readMs: 10000\n}\n" })
  const tools = workspaceTools(root, [], { edits: writing() })
  const blind = await tools.run({ name: "edit_file", args: { path: "config.js", find: "timeout: 1000", replace: "timeout: 30000" } })
  assert.ok(blind.failed)
  assert.match(blind.output, /^config\.js: find is not in the file\. You have not read config\.js yet, so here it is:\n1: module\.exports = \{\n2: {3}connectMs: 5000,\n3: {3}readMs: 10000\n4: \}\nCall edit_file again/)
  // Shown once: now it has the lines, numbers and all, and either way of editing works.
  const byLine = await tools.run({ name: "edit_file", args: { path: "config.js", start_line: "2", end_line: "3", replace: "  connectMs: 30000,\n  readMs: 30000" } })
  assert.ok(!byLine.failed, byLine.output)
  const again = await tools.run({ name: "edit_file", args: { path: "config.js", find: "nothing like it", replace: "x" } })
  assert.match(again.output, /^config\.js: find is not in the file; read the lines again/, "a second miss is told the usual thing")
})

test("edit_file changes every match with replace_all, and several places from a list, all or none", async () => {
  const source = "const price = formatPrice(a)\nlog(formatPrice(b))\n\nfunction other() {\n  return formatPrice(c)\n}\n"
  const root = workspace({ "a.js": source })
  const file = path.join(root, "a.js")
  const tools = workspaceTools(root, [], { edits: writing() })

  const all = await tools.run({ name: "edit_file", args: { path: "a.js", find: "formatPrice", replace: "formatMoney", replace_all: "true" } })
  assert.strictEqual(all.summary, "edited `a.js:1–5` · 3 places")
  assert.match(all.output, /^Applied\. 3 places changed\./)
  assert.ok(!fs.readFileSync(file, "utf8").includes("formatPrice"))

  const once = await tools.run({ name: "edit_file", args: { path: "a.js", find: "formatMoney", replace: "x" } })
  assert.match(once.output, /matches 3 places/, "without it, a find that matches more than once is still refused")

  const listed = await tools.run({
    name: "edit_file",
    args: { path: "a.js", edits: JSON.stringify([{ find: "formatMoney(a)", replace: "money(a)" }, { find: "return formatMoney(c)", replace: "return money(c)" }]) }
  })
  assert.strictEqual(listed.summary, "edited `a.js:1–5` · 2 places")
  assert.strictEqual(fs.readFileSync(file, "utf8"), "const price = money(a)\nlog(formatMoney(b))\n\nfunction other() {\n  return money(c)\n}\n")

  const before = fs.readFileSync(file, "utf8")
  const partial = await tools.run({
    name: "edit_file",
    args: { path: "a.js", edits: JSON.stringify([{ find: "money(a)", replace: "cash(a)" }, { find: "not here", replace: "x" }]) }
  })
  assert.ok(partial.failed)
  assert.match(partial.output, /edit 2 of 2: find is not in the file[\s\S]*None of the edits were made\./)
  assert.strictEqual(fs.readFileSync(file, "utf8"), before, "one edit that cannot be made leaves the file alone")

  const added = planEdits("a\nb\nc", [{ find: "b", replace: "b\nb2" }, { find: "c", replace: "c2" }])
  assert.deepStrictEqual(added, { startLine: 2, endLine: 2, original: "c", text: "b2\nc2", count: 2 }, "the stretch of lines that differ")
  const onlyAdded = planEdits("a\nb", [{ find: "a", replace: "a\nnew", all: true }])
  assert.deepStrictEqual(onlyAdded, { startLine: 0, endLine: 0, original: "a", text: "a\nnew", count: 1 }, "lines only added still rewrite the line they follow")
  assert.match(planEdits("a", [{ find: "a", replace: "b", all: true, startLine: 1 }]) as string, /cannot be used with replace_all/)

  const schema = (await import("../../extension/tools/protocol")).toolDefinition(tools.tools.find((t) => t.name === "edit_file")!)
  assert.deepStrictEqual((schema.parameters as { required: string[] }).required, ["path"])
  assert.strictEqual(((schema.parameters as { properties: Record<string, { type: string }> }).properties.edits).type, "array")
})

test("a conversation longer than the context is folded at its old end, in blocks, with the system prompt and the newest turns whole", () => {
  const plan = planContext(8192)
  const turns = (count: number) => [
    { role: "system", content: "You are twinny." },
    ...Array.from({ length: count }, (_, i) => [
      { role: "user", content: `Question ${i}: ${"why ".repeat(300)}` },
      { role: "assistant", content: `Answer ${i}: ${"because ".repeat(300)}\n\`\`\`js\nconst secret${i} = 1\n\`\`\`` }
    ]).flat(),
    { role: "user", content: "And now the real question." }
  ]
  const short = turns(2)
  assert.deepStrictEqual(compactHistory(short, plan), { messages: short, folded: 0 }, "one that fits is left alone")

  const long = turns(12)
  const { messages, folded } = compactHistory(long, plan)
  assert.ok(folded >= 16 && folded < 24, `a small context keeps the latest turn or two: ${folded}`)
  assert.strictEqual(messages[0], long[0], "the system prompt is the same object")
  assert.strictEqual(messages[messages.length - 1], long[long.length - 1])
  assert.strictEqual(messages.length, long.length - folded)
  const head = String(messages[1].content)
  assert.ok(head.startsWith(FOLD_HEADER))
  assert.match(head, /older messages not listed\)\n- The user: Question \d+: why why/)
  assert.match(head, /- You: Answer \d+: because/)
  assert.ok(!/secret\d/.test(head.slice(0, head.indexOf("]\n\n"))), "code is left out of the lines that stand for a turn")
  assert.match(head, new RegExp(`\\]\\n\\nQuestion ${folded / 2}: why`), "then the first turn kept, a user's")
  assert.deepStrictEqual(messages.slice(1).map((m) => m.role).slice(0, 3), ["user", "assistant", "user"])
  const size = messages.reduce((sum, m) => sum + String(m.content).length, 0)
  assert.ok(size / 3.3 <= plan.limit * 0.6, "and it fits with room for the tools to work")

  // With room to spare the fold goes in whole blocks, so a turn later the
  // same turns are folded and the prefix a local server has cached still holds.
  const roomy = planContext(32_768)
  const longer = turns(40)
  const first = compactHistory(longer, roomy)
  assert.ok(first.folded > 0 && first.folded % 8 === 0, `whole blocks: ${first.folded}`)
  const later = compactHistory(
    [...longer.slice(0, -1), longer[longer.length - 1], { role: "assistant", content: "Yes." }, { role: "user", content: "Another." }],
    roomy
  )
  assert.strictEqual(later.folded, first.folded)
  assert.strictEqual(later.messages[1].content, first.messages[1].content)
})

test("the loop folds a long conversation before the first request and says so", async () => {
  const root = workspace({ "a.js": "const a = 1\n" })
  const history = Array.from({ length: 16 }, (_, i) => [
    { role: "user", content: `Question ${i}: ${"why ".repeat(300)}` },
    { role: "assistant", content: `Answer ${i}: ${"because ".repeat(300)}` }
  ]).flat()
  const { client, requests } = scripted(["Done."])
  let folded = 0
  await drain(
    withTools(client, workspaceTools(root), { mode: "native", contextWindow: () => 8192, onCompact: (count) => (folded = count) }).chat({
      model: "m",
      messages: [{ role: "system", content: "You are twinny." }, ...history, { role: "user", content: "What is a?" }] as ChatRequest["messages"]
    })
  )
  assert.ok(folded >= 8 && folded < history.length, `${folded}`)
  const sent = requests[0].messages
  assert.match(String(sent[0].content), /^You are twinny\.\n\nYou can work in the user's workspace/, "the system prompt and the tools are whole")
  assert.ok(String(sent[1].content).startsWith(FOLD_HEADER))
  assert.strictEqual(sent[sent.length - 1].content, "What is a?")
  assert.strictEqual(sent.length, 2 + history.length - folded)
})

test("short results are never trimmed, and the closing request says what the reply did", async () => {
  const body = Array.from({ length: 60 }, (_, i) => `const value${i} = "${"x".repeat(30)}"`).join("\n")
  const root = workspace({ "a.js": body, "b.js": body, "c.js": body, "d.js": body })
  const { client, requests } = scripted([
    { calls: [call("1", "edit_file", { path: "a.js", find: "const value0 = \"" + "x".repeat(30) + "\"", replace: "const value0 = 0" })] },
    { calls: [call("2", "read_file", { path: "b.js" })] },
    { calls: [call("3", "read_file", { path: "c.js" })] },
    { calls: [call("4", "read_file", { path: "d.js" })] },
    "Out of steps."
  ])
  let notes: string | undefined
  let trims = 0
  await drain(
    withTools(client, workspaceTools(root, [], { edits: writing() }), {
      mode: "native",
      maxSteps: 4,
      contextWindow: () => 4096,
      onTrim: (count) => (trims += count),
      onNotes: (kept) => (notes = kept)
    }).chat(ask("Change a.js then read the rest."))
  )
  assert.ok(trims > 0, "the reads had to go")
  const last = requests[4].messages
  const results = last.filter((m) => m.role === "tool").map((m) => String(m.content))
  assert.match(results[0], /^Applied\.\nLines 1–3 are now:\n1: const value0 = 0/, "the edit's result is still there, whole")
  assert.match(results[1], /^b\.js \(lines 1–\d+ of 60\); defined there[^\n]*\n\[The rest was trimmed/)
  const closing = String(last[last.length - 1].content)
  assert.match(closing, /^You are out of tool calls[\s\S]*What you did in this reply, from the record:\n- edited `a\.js:1`$/)
  assert.match(notes ?? "", /^What that reply did:\n- edited `a\.js:1`\n\nedit_file /, "and the next turn's notes begin with it")
})

test("update_tasks keeps the model's list, shows it, and brings it back when the reply runs out or the next turn starts", async () => {
  assert.deepStrictEqual(parseTasks("- [x] read the code\n2. [ ] change it\n[X] test\nwrite docs"), [
    { text: "read the code", done: true },
    { text: "change it", done: false },
    { text: "test", done: true },
    { text: "write docs", done: false }
  ])
  assert.deepStrictEqual(parseTasks("[{\"text\": \"a\", \"done\": true}, {\"task\": \"b\", \"status\": \"pending\"}, \"[x] c\"]"), [
    { text: "a", done: true },
    { text: "b", done: false },
    { text: "c", done: true }
  ])
  assert.strictEqual(parseTasks("  \n"), undefined)
  assert.strictEqual(renderTasks([{ text: "a", done: true }, { text: "b", done: false }]), "[x] a\n[ ] b")

  const root = workspace({ "a.js": "const a = 1\n" })
  const { client, requests } = scripted([
    { calls: [call("1", "update_tasks", { tasks: "[ ] read a.js\n[ ] change it" })] },
    { calls: [call("2", "read_file", { path: "a.js" })] },
    { calls: [call("3", "update_tasks", { tasks: "[x] read a.js\n[ ] change it" })] },
    { calls: [call("4", "read_file", { path: "a.js" })] },
    "Ran out."
  ])
  const seen: Task[][] = []
  const summaries: string[] = []
  let notes: string | undefined
  await drain(
    withTools(client, workspaceTools(root), {
      mode: "native",
      maxSteps: 4,
      onTasks: (tasks) => seen.push(tasks),
      onStep: (step) => summaries.push(step.summary),
      onNotes: (kept) => (notes = kept)
    }).chat(ask("Read then change a.js."))
  )
  assert.ok(requests[0].tools?.some((tool) => tool.name === "update_tasks"))
  assert.match(String(requests[0].messages[0].content), /write the steps down first with update_tasks/)
  assert.deepStrictEqual(seen.map((tasks) => tasks.filter((task) => task.done).length), [0, 1])
  assert.deepStrictEqual(summaries, ["tasks · 0 of 2 done", "read `a.js:1–1`", "tasks · 1 of 2 done", "read `a.js:1–1` · repeated, not run again"])
  const tool = (request: ChatRequest) => request.messages.filter((m) => m.role === "tool").map((m) => String(m.content))
  assert.strictEqual(tool(requests[1])[0], "Saved (0 of 2 done). Next: read a.js")
  assert.match(tool(requests[4])[3], /already called read_file/, "writing the list does not make an earlier read stale")
  assert.match(String(requests[4].messages[requests[4].messages.length - 1].content), /Still open on your list:\n\[ \] change it$/)
  assert.match(notes ?? "", /^Your task list \(1 of 2 done\):\n\[x\] read a\.js\n\[ \] change it\n\n/)

  // Turned off, the tool is not offered and its guidance is not in the prompt.
  const off = scripted(["Hello."])
  await drain(withTools(off.client, workspaceTools(root), { mode: "native", tasks: false }).chat(ask("Hi.")))
  assert.ok(!off.requests[0].tools?.some((tool) => tool.name === "update_tasks"))
  assert.ok(!String(off.requests[0].messages[0].content).includes("update_tasks"))
})

test("a call written as code in an ordinary fenced block is run, when it is the reply's last block and names a tool", async () => {
  const names = new Set(["edit_file", "read_file"])
  const paren = findFencedCall("Sure.\n```js\nread_file({ \"path\": \"a.js\" })\n```", names)
  assert.deepStrictEqual(paren?.call, { name: "read_file", args: { path: "a.js" } })
  assert.strictEqual(paren?.start, 6)
  assert.deepStrictEqual(findFencedCall("```js\nedit_file { \"path\": \"a.js\", \"find\": \"1\", \"replace\": \"2\" }\n```\nDone.", names)?.call?.name, "edit_file")
  assert.strictEqual(findFencedCall("```js\nconsole.log(read_file)\n```", names), undefined, "code that is not a call to a tool")
  assert.strictEqual(findFencedCall("```js\nread_file({\"path\": \"a.js\"})\n```\nthen\n```js\nconst a = 1\n```", names), undefined, "only the last block")
  assert.strictEqual(findFencedCall("```js\nfetch(\"/x\")\n```", names), undefined)

  const root = workspace({ "a.js": "const a = 1\n" })
  const { client, requests } = scripted(["Let me look.\n```js\nread_file({ \"path\": \"a.js\" })\n```", "It is 1."])
  const summaries: string[] = []
  const text = await drain(withTools(client, workspaceTools(root), { mode: "text", stepLines: false, onStep: (step) => summaries.push(step.summary) }).chat(ask("What is a?")))
  assert.deepStrictEqual(summaries, ["read `a.js:1–1`"])
  assert.match(String(requests[1].messages[requests[1].messages.length - 1].content), /^<tool_result name="read_file">\na\.js \(lines 1–1 of 1\)/)
  assert.ok(text.endsWith("It is 1."))
})

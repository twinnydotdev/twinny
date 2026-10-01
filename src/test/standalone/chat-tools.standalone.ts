/**
 * The chat's read-only tools: reading a call out of a streaming reply,
 * never showing the call itself, keeping every tool inside the workspace,
 * and the loop feeding results back until the model answers.
 */
import * as assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { ToolSteps } from "../../extension/chat/tool-steps"
import { ChatChunk, ChatRequest, InferenceClient } from "../../extension/inference"
import { planReplacement } from "../../extension/tools/edit"
import { toolModeFor, withTools } from "../../extension/tools/loop"
import { displayableLength, findToolCall, nameArguments } from "../../extension/tools/protocol"
import { workspaceTools } from "../../extension/tools/workspace"

test("reads the JSON form as soon as its object closes, and not before", () => {
  const text = "Let me look.\n<tool_call>\n{\"name\": \"grep\", \"arguments\": {\"pattern\": \"foo\"}}\n</tool_call>"
  const objectEnd = text.indexOf("}}") + 2
  assert.strictEqual(findToolCall(text.slice(0, objectEnd - 1)), undefined, "the object is still open")
  // Complete at the object's end: the stream can stop there, without the closing tag.
  const early = findToolCall(text.slice(0, objectEnd))
  assert.deepStrictEqual(early?.call, { name: "grep", args: { pattern: "foo" } })
  assert.deepStrictEqual([early?.end, early?.unclosed], [objectEnd, "</tool_call>"])
  const found = findToolCall(text)
  assert.deepStrictEqual(found?.call, { name: "grep", args: { pattern: "foo" } })
  assert.strictEqual(found?.start, "Let me look.\n".length)
  assert.deepStrictEqual([found?.end, found?.unclosed], [text.length, undefined])
})

test("a call's arguments may quote the closing marker without ending the call", () => {
  const content = "# Demo\n\n```js\nconsole.log(1)\n```\n\nSee </tool_call> and {braces}.\n"
  for (const [open, close] of [["```tool\n", "\n```"], ["<tool_call>\n", "\n</tool_call>"]]) {
    const text = `${open}${JSON.stringify({ name: "create_file", arguments: { path: "README.md", content } })}${close}`
    const found = findToolCall(text)
    assert.deepStrictEqual(found?.call, { name: "create_file", args: { path: "README.md", content } }, open)
    assert.strictEqual(found?.end, text.length)
  }
  // Cut off mid-string at the end of the reply: an error the model can act on, not a half-read call.
  const cut = "```tool\n{\"name\": \"create_file\", \"arguments\": {\"content\": \"abc"
  assert.strictEqual(findToolCall(cut), undefined)
  assert.match(findToolCall(cut, true)?.error ?? "", /cut off/)
})

test("reads Qwen's function form, wrapped or bare, and an unclosed one at the end", () => {
  const qwen = "<tool_call>\n<function=read_file>\n<parameter=path>\nsrc/a.ts\n</parameter>\n<parameter=start_line>\n10\n</parameter>\n</function>\n</tool_call>"
  assert.deepStrictEqual(findToolCall(qwen)?.call, {
    name: "read_file",
    args: { path: "src/a.ts", start_line: "10" }
  })
  const bare = "<function=list_dir>\n</function>"
  assert.deepStrictEqual(findToolCall(bare)?.call, { name: "list_dir", args: {} })
  const unclosed = "<function=find_symbol>\n<parameter=name>\nChat\n</parameter>\n"
  assert.strictEqual(findToolCall(unclosed), undefined, "the function form has no end of its own to read")
  assert.deepStrictEqual(findToolCall(unclosed, true)?.call, { name: "find_symbol", args: { name: "Chat" } })
  const stringArgs = "<tool_call>\n{\"name\": \"find_symbol\", \"arguments\": \"{\\\"name\\\": \\\"Chat\\\"}\"}"
  assert.deepStrictEqual(findToolCall(stringArgs)?.call, { name: "find_symbol", args: { name: "Chat" } })
})

test("reads the fenced form, and bare JSON only when it ends the reply with arguments", () => {
  const fenced = "Checking.\n```tool\n{\"name\": \"list_dir\", \"arguments\": {\"path\": \"src\"}}\n```\n"
  assert.deepStrictEqual(findToolCall(fenced)?.call, { name: "list_dir", args: { path: "src" } })
  assert.strictEqual(findToolCall("```typescript\nconst a = 1\n```"), undefined)

  const bare = "Let me search.\n\n{\"name\": \"grep\", \"arguments\": {\"pattern\": \"a}b\"}}\n"
  assert.strictEqual(findToolCall(bare), undefined, "not while streaming")
  const found = findToolCall(bare, true)
  assert.deepStrictEqual(found?.call, { name: "grep", args: { pattern: "a}b" } })
  assert.strictEqual(found?.start, "Let me search.\n\n".length)
  assert.strictEqual(findToolCall("{\"name\": \"twinny\", \"version\": \"4.2.10\"}", true), undefined)
  assert.strictEqual(findToolCall("{\"name\": \"grep\", \"arguments\": {}} and more", true), undefined)
})

test("a call that cannot be read says why", () => {
  assert.match(findToolCall("<tool_call>{name: grep}</tool_call>")?.error ?? "", /not valid JSON/)
})

test("holds back a tail that may become a call, and nothing else", () => {
  assert.strictEqual(displayableLength("The answer is <"), "The answer is ".length)
  assert.strictEqual(displayableLength("See <tool_ca"), "See ".length)
  assert.strictEqual(displayableLength("See <func"), "See ".length)
  assert.strictEqual(displayableLength("See ```to"), "See ".length)
  assert.strictEqual(displayableLength("a < b"), "a < b".length)
  assert.strictEqual(displayableLength("x <tool_call>{}"), 2)
})

const makeWorkspace = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-tools-"))
  fs.mkdirSync(path.join(root, "src"))
  fs.writeFileSync(path.join(root, ".gitignore"), ".env\nbuild/\n")
  fs.writeFileSync(path.join(root, ".env"), "API_KEY=secret\n")
  fs.mkdirSync(path.join(root, "build"))
  fs.writeFileSync(path.join(root, "build", "out.js"), "export function warm() {}\n")
  fs.writeFileSync(
    path.join(root, "src", "warmer.ts"),
    "export class ModelWarmer {\n  public async warm() {\n    return 1\n  }\n}\n"
  )
  fs.writeFileSync(path.join(root, "src", "main.ts"), "import { ModelWarmer } from './warmer'\nnew ModelWarmer().warm()\n")
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-outside-"))
  fs.writeFileSync(path.join(outside, "private.txt"), "nope\n")
  fs.symlinkSync(outside, path.join(root, "link"))
  return root
}

test("tools find, read and search, and stay inside the workspace", async () => {
  const tools = workspaceTools(makeWorkspace())

  const symbol = await tools.run({ name: "find_symbol", args: { name: "ModelWarmer" } })
  assert.strictEqual(symbol.output, "src/warmer.ts:1: export class ModelWarmer {")
  const method = await tools.run({ name: "find_symbol", args: { name: "warm" } })
  assert.strictEqual(method.output, "src/warmer.ts:2: public async warm() {")

  const read = await tools.run({ name: "read_file", args: { path: "./src/warmer.ts", start_line: "2", end_line: "3" } })
  assert.match(read.output, /^src\/warmer.ts \(lines 2–3 of 5\)\n2: {3}public async warm\(\) \{\n3: {5}return 1$/)

  const grep = await tools.run({ name: "grep", args: { pattern: "modelwarmer" } })
  assert.strictEqual(
    grep.output,
    "src/main.ts\n1: import { ModelWarmer } from './warmer'\n2: new ModelWarmer().warm()\nsrc/warmer.ts\n1: export class ModelWarmer {\n2-   public async warm() {\n3-     return 1",
    "lowercase ignores case; matches are grouped under their file, with the lines beside them when there are few; build/ is not searched"
  )
  assert.strictEqual(grep.summary, "searched for `modelwarmer` · 3 matches in 2 files")

  const inFile = await tools.run({ name: "grep", args: { pattern: "return", path: "src/warmer.ts" } })
  assert.strictEqual(
    inFile.output,
    "src/warmer.ts\n1- export class ModelWarmer {\n2-   public async warm() {\n3:     return 1\n4-   }\n5- }"
  )

  const listing = await tools.run({ name: "list_dir", args: {} })
  assert.deepStrictEqual(listing.output.split("\n").sort(), [".gitignore", "link", "src/"].sort())

  for (const bad of ["../", ".env", "build/out.js", "link/private.txt", "/etc/passwd"]) {
    const refused = await tools.run({ name: "read_file", args: { path: bad } })
    assert.match(refused.output, /outside the workspace|ignored by \.gitignore|does not exist/, bad)
    assert.doesNotMatch(refused.output, /secret|nope|root:/)
  }
})

type Reply = string | { text?: string; calls?: ChatChunk["toolCalls"]; refuse?: string }

/** A client that replies with the scripted texts in turn, in small chunks, and records what it was sent. */
const scripted = (replies: Reply[]) => {
  const requests: ChatRequest[] = []
  const client = {
    id: "scripted",
    chat(request: ChatRequest) {
      requests.push(structuredClone(request))
      const next = replies.shift() ?? ""
      const reply = typeof next === "string" ? { text: next } : next
      return (async function* (): AsyncGenerator<ChatChunk> {
        if (reply.refuse) throw new Error(reply.refuse)
        const text = reply.text ?? ""
        for (let i = 0; i < text.length; i += 7) yield { content: text.slice(i, i + 7) }
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

test("the loop runs a call, sends the result back and shows only prose, steps and the answer", async () => {
  const { client, requests } = scripted([
    "Looking.\n<tool_call>\n{\"name\": \"find_symbol\", \"arguments\": {\"name\": \"ModelWarmer\"}}\n</tool_call>\nIGNORED",
    "It is defined in src/warmer.ts:1."
  ])
  const shown = await collect(
    withTools(client, workspaceTools(makeWorkspace())).chat({
      model: "m",
      messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Where is ModelWarmer?" }]
    })
  )
  assert.strictEqual(shown, "Looking.\n\n> looked up `ModelWarmer` · 1 definition\n\nIt is defined in src/warmer.ts:1.")
  assert.strictEqual(requests.length, 2)
  const system = requests[0].messages[0].content as string
  assert.match(system, /^Be brief\.\n\nYou can work in the user's workspace with tools\./)
  assert.match(system, /The workspace root contains: src\/, \.gitignore, link/)
  const [, , assistant, result] = requests[1].messages
  assert.doesNotMatch(assistant.content as string, /IGNORED/)
  assert.strictEqual(result.content, "<tool_result name=\"find_symbol\">\nsrc/warmer.ts:1: export class ModelWarmer {\n</tool_result>")
})

test("after the last step the model is told to answer, and a stray call is not run", async () => {
  const call = "<tool_call>{\"name\": \"list_dir\", \"arguments\": {}}</tool_call>"
  const { client, requests } = scripted([call, call, "Done."])
  const shown = await collect(
    withTools(client, workspaceTools(makeWorkspace()), { maxSteps: 2 }).chat({
      model: "m",
      messages: [{ role: "user", content: "Look around." }]
    })
  )
  assert.strictEqual(requests.length, 3)
  assert.match(requests[2].messages.at(-1)?.content as string, /out of tool calls/)
  assert.ok(shown.endsWith("Done."))
})

test("native calls go out as tools and come back as tool messages; the last request offers none", async () => {
  const { client, requests } = scripted([
    {
      calls: [
        { id: "a", name: "find_symbol", arguments: "{\"name\":\"ModelWarmer\"}" },
        { id: "b", name: "read_file", arguments: "{\"path\":\"src/warmer.ts\",\"end_line\":1}" }
      ]
    },
    { calls: [{ id: "c", name: "grep", arguments: "not json" }] },
    "In src/warmer.ts:1."
  ])
  const steps: string[] = []
  const shown = await collect(
    withTools(client, workspaceTools(makeWorkspace()), {
      mode: "native",
      maxSteps: 2,
      onStep: (step) => steps.push(`${step.mode}:${step.name}`)
    }).chat({ model: "m", messages: [{ role: "user", content: "Where is ModelWarmer?" }] })
  )
  assert.deepStrictEqual(steps, ["native:find_symbol", "native:read_file", "native:grep"])
  assert.strictEqual(
    shown,
    "> looked up `ModelWarmer` · 1 definition\n\n> read `src/warmer.ts:1–1`\n\n> tool call not understood · the arguments were not valid JSON\n\nIn src/warmer.ts:1."
  )
  assert.deepStrictEqual(requests[0].tools?.map((t) => t.name), ["list_dir", "find_files", "read_file", "grep", "find_symbol"])
  assert.doesNotMatch(requests[0].messages[0].content as string, /```tool/)
  const second = requests[1].messages
  assert.deepStrictEqual(
    second.slice(2).map((m) => [m.role, (m as { tool_call_id?: string }).tool_call_id]),
    [["assistant", undefined], ["tool", "a"], ["tool", "b"]]
  )
  assert.strictEqual(second[2].content, null, "a reply that is only calls carries no empty text (Anthropic refuses it)")
  assert.strictEqual(requests[2].tools, undefined)
})

test("a server that refuses tools gets the text protocol instead", async () => {
  const { client, requests } = scripted([
    { refuse: "registry.ollama.ai/library/tiny does not support tools" },
    "```tool\n{\"name\": \"list_dir\", \"arguments\": {}}\n```",
    "Three entries."
  ])
  const fellBack: string[] = []
  const shown = await collect(
    withTools(client, workspaceTools(makeWorkspace()), {
      mode: "native",
      onFallback: (reason) => fellBack.push(reason)
    }).chat({ model: "m", messages: [{ role: "user", content: "What is here?" }] })
  )
  assert.strictEqual(fellBack.length, 1)
  assert.strictEqual(requests[1].tools, undefined)
  assert.match(requests[1].messages[0].content as string, /```tool/)
  assert.strictEqual(shown, "> listed the workspace root · 3 entries\n\nThree entries.")
})

test("in native mode a call written as text still runs, and goes back as a native call", async () => {
  const { client, requests } = scripted([
    "I'll search.\n<function=grep>\n<parameter=pattern>\nModelWarmer\n</parameter>\n</function>\n</tool_call>",
    "Found it."
  ])
  const shown = await collect(
    withTools(client, workspaceTools(makeWorkspace()), { mode: "native" }).chat({
      model: "m",
      messages: [{ role: "user", content: "Where?" }]
    })
  )
  assert.strictEqual(shown, "I'll search.\n\n> searched for `ModelWarmer` · 3 matches in 2 files\n\nFound it.")
  const [, , assistant, tool] = requests[1].messages as unknown as Array<Record<string, unknown>>
  assert.strictEqual(assistant.content, "I'll search.")
  assert.deepStrictEqual(assistant.tool_calls, [
    { id: "call_text_0", type: "function", function: { name: "grep", arguments: "{\"pattern\":\"ModelWarmer\"}" } }
  ])
  assert.strictEqual(tool.tool_call_id, "call_text_0")
})

test("planReplacement finds text once, tolerates pasted line numbers and indentation, refuses ambiguity", () => {
  const file = "class A {\n  run() {\n    return 1\n  }\n  stop() {\n    return 1\n  }\n}\n"
  assert.deepStrictEqual(planReplacement(file, "run() {\n    return 1", "run() {\n    return 2"), {
    startLine: 1,
    endLine: 2,
    original: "  run() {\n    return 1",
    text: "  run() {\n    return 2"
  })
  assert.match(planReplacement(file, "return 1", "return 2") as string, /matches 2 places/)
  const numbered = planReplacement(file, "5:   stop() {\n6:     return 1\n", "5:   stop() {\n6:     return 0\n")
  assert.strictEqual((numbered as { text: string }).text, "  stop() {\n    return 0")
  const unindented = planReplacement(file, "stop() {\nreturn 1\n}", "stop() {\n  return 0\n}")
  assert.deepStrictEqual(unindented, {
    startLine: 4,
    endLine: 6,
    original: "  stop() {\n    return 1\n  }",
    text: "  stop() {\n    return 0\n  }"
  })
  const long = `{\n  "default": 16000,\n  "description": "${"x".repeat(300)}"\n}`
  const clipped = `  "default": 16000,\n  "description": "${"x".repeat(180)}…`
  assert.deepStrictEqual(planReplacement(long, clipped, clipped.replace("16000", "20000")), {
    startLine: 1,
    endLine: 2,
    original: `  "default": 16000,\n  "description": "${"x".repeat(300)}"`,
    text: `  "default": 20000,\n  "description": "${"x".repeat(300)}"`
  })
  assert.match(planReplacement(long, "\"default\": 16000,", `"default": 1,\n"y${"x".repeat(9)}…`) as string, /cut short/)
  assert.match(planReplacement(file, "missing()", "x") as string, /not in the file/)
  assert.match(planReplacement(file, "", "x") as string, /find is empty/)
  assert.match(planReplacement(file, "run()", "run()") as string, /nothing would change/)
  assert.strictEqual(
    (planReplacement("a\r\nb = 1\r\nc", "b = 1", "b = 2") as { text: string }).text,
    "b = 2"
  )
})

test("edit_file plans against the open buffer and hands the change to the sink", async () => {
  const root = makeWorkspace()
  const edited: Array<{ file: string; startLine: number; text: string }> = []
  const tools = workspaceTools(root, [], { edits: {
    mode: "apply",
    read: async (file) => (file.endsWith("warmer.ts") ? "export class ModelWarmer {\n  unsaved() {}\n}\n" : undefined),
    edit: async (file, replacement) => {
      edited.push({ file, startLine: replacement.startLine, text: replacement.text })
      return { ok: true, message: "Applied." }
    },
    create: async () => ({ ok: true, message: "Created." })
  } })
  assert.match(tools.tools.find((t) => t.name === "edit_file")?.description ?? "", /applied and saved straight away/)
  const result = await tools.run({
    name: "edit_file",
    args: { path: "src/warmer.ts", find: "unsaved() {}", replace: "saved() {}" }
  })
  assert.strictEqual(result.output, "Applied.")
  assert.strictEqual(result.summary, "edited `src/warmer.ts:2`")
  assert.ok(!result.final)
  assert.deepStrictEqual(edited, [{ file: path.join(root, "src", "warmer.ts"), startLine: 1, text: "  saved() {}" }])

  const miss = await tools.run({ name: "edit_file", args: { path: "src/warmer.ts", find: "public async warm", replace: "x" } })
  assert.match(miss.output, /src\/warmer.ts: find is not in the file/)
  const ignored = await tools.run({ name: "edit_file", args: { path: ".env", find: "API_KEY", replace: "x" } })
  assert.match(ignored.output, /ignored by \.gitignore/)
  assert.strictEqual(edited.length, 1)
  assert.strictEqual(workspaceTools(root).tools.some((t) => t.name === "edit_file"), false)
})

test("the reply's notes keep each call and what it returned for the next turn", async () => {
  const { client } = scripted([
    { calls: [{ id: "a", name: "find_symbol", arguments: "{\"name\":\"ModelWarmer\"}" }] },
    "In src/warmer.ts."
  ])
  const notes: Array<string | undefined> = []
  let ended = 0
  await collect(
    withTools(client, workspaceTools(makeWorkspace()), {
      mode: "native",
      onNotes: (text) => notes.push(text),
      onEnd: () => ended++
    }).chat({ model: "m", messages: [{ role: "user", content: "Where?" }] })
  )
  assert.deepStrictEqual(notes, ["find_symbol {\"name\":\"ModelWarmer\"}\nsrc/warmer.ts:1: export class ModelWarmer {"])
  assert.strictEqual(ended, 1)

  const plain: Array<string | undefined> = []
  await collect(
    withTools(scripted(["Hello."]).client, workspaceTools(makeWorkspace()), { onNotes: (text) => plain.push(text) }).chat({
      model: "m",
      messages: [{ role: "user", content: "Hi" }]
    })
  )
  assert.deepStrictEqual(plain, [undefined], "a reply that used no tool has nothing to carry over")
})

test("create_file writes new files only, inside the workspace and outside .gitignore", async () => {
  const root = makeWorkspace()
  const created: Array<[string, string]> = []
  const tools = workspaceTools(root, [], {
    edits: {
      mode: "apply",
      edit: async () => ({ ok: true, message: "" }),
      create: async (file, content) => {
        created.push([file, content])
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, content)
        return { ok: true, message: "Created." }
      }
    }
  })
  const made = await tools.run({ name: "create_file", args: { path: "src/new/util.ts", content: "export const a = 1\nexport const b = 2\n" } })
  assert.deepStrictEqual([made.output, made.summary, made.final], ["Created.", "created `src/new/util.ts` · 2 lines", undefined])
  assert.deepStrictEqual(created, [[path.join(root, "src", "new", "util.ts"), "export const a = 1\nexport const b = 2\n"]])
  const found = await tools.run({ name: "grep", args: { pattern: "export const b" } })
  assert.strictEqual(found.output, "src/new/util.ts\n1- export const a = 1\n2: export const b = 2", "searches see the new file")

  for (const [bad, why] of [
    ["src/warmer.ts", /already exists; use edit_file/],
    ["../escape.ts", /outside the workspace/],
    ["link/sneaky.ts", /outside the workspace/],
    ["build/gen.js", /ignored by \.gitignore/],
    ["src/", /file path is needed/]
  ] as const) {
    const refused = await tools.run({ name: "create_file", args: { path: bad, content: "x" } })
    assert.match(refused.output, why, bad)
  }
  assert.strictEqual(created.length, 1)
})

test("run_command reports the exit code and output, or that the user skipped it", async () => {
  const outcomes = [
    { ran: true, output: "3 passing\n", exitCode: 0 },
    { ran: false, output: "" },
    { ran: true, output: "compiling…", timedOut: "running" as const }
  ]
  const asked: string[] = []
  const tools = workspaceTools(makeWorkspace(), [], {
    commands: { mode: "ask", run: async (command) => (asked.push(command), outcomes.shift()!) }
  })
  const run = tools.tools.find((t) => t.name === "run_command")!
  assert.match(run.description, /asked before it runs/)
  const passed = await tools.run({ name: "run_command", args: { command: " npm test " } })
  assert.strictEqual(passed.output, "$ npm test\n(exit code 0)\n3 passing")
  assert.strictEqual(passed.summary, "ran `npm test` · exit 0")
  const skipped = await tools.run({ name: "run_command", args: { command: "rm -rf out" } })
  assert.match(skipped.output, /chose not to run/)
  assert.strictEqual(skipped.summary, "`rm -rf out` skipped")
  const slow = await tools.run({ name: "run_command", args: { command: "npm run build" } })
  assert.match(slow.output, /still running when the wait ran out[\s\S]*compiling…/)
  assert.deepStrictEqual(asked, ["npm test", "rm -rf out", "npm run build"])
  assert.match((await tools.run({ name: "run_command", args: {} })).output, /needs a command/)
})

test("search_code lists index hits within a budget, first among the tools", async () => {
  const root = makeWorkspace()
  const tools = workspaceTools(root, [], {
    codeSearch: {
      search: async (query) =>
        query === "nothing"
          ? []
          : [
              { file: path.join(root, "src", "warmer.ts"), startLine: 0, endLine: 4, score: 0.91, content: "export class ModelWarmer {\n}\n" },
              { file: path.join(root, "src", "main.ts"), startLine: 1, endLine: 1, score: 0.3, content: "x".repeat(7000) }
            ]
    }
  })
  assert.strictEqual(tools.tools[0].name, "search_code")
  const found = await tools.run({ name: "search_code", args: { query: "warm the model" } })
  assert.strictEqual(
    found.output,
    "src/warmer.ts:1-5 (relevance 0.91)\nexport class ModelWarmer {\n}\n\nsrc/main.ts:2-2 (relevance 0.30)\n… (not shown; read_file it)"
  )
  assert.strictEqual(found.summary, "searched the index for `warm the model` · 2 hits")
  assert.match((await tools.run({ name: "search_code", args: { query: "nothing" } })).output, /Nothing in the index matched/)
  assert.ok(!workspaceTools(root).tools.some((t) => t.name === "search_code" || t.name === "run_command"))
})

test("ToolSteps shows each call as it starts and ends, and holds a command for Run or Skip", async () => {
  const sent: string[][] = []
  const steps = new ToolSteps((all) => sent.push(all.map((s) => `${s.id}:${s.status}:${s.summary}`)))
  steps.start({ id: "0.0", name: "grep", args: { pattern: "foo" } })
  assert.deepStrictEqual(sent.at(-1), ["0.0:running:grep `foo`"])
  steps.finish({ id: "0.0", index: 0, mode: "native", summary: "searched for `foo` · 2 matches", output: "a:1\nb:2", promptChars: 0 })
  assert.deepStrictEqual(sent.at(-1), ["0.0:done:searched for `foo` · 2 matches"])
  assert.strictEqual(steps.steps[0].output, "a:1\nb:2")

  steps.start({ id: "1.0", name: "run_command", args: { command: "npm test" } })
  const ran = steps.approve("npm test")
  assert.deepStrictEqual(sent.at(-1)?.[1], "1.0:waiting:run_command `npm test`")
  assert.strictEqual(steps.steps[1].command, "npm test")
  steps.answer("1.0", true)
  assert.strictEqual(await ran, true)
  steps.finish({ id: "1.0", index: 1, mode: "native", summary: "ran `npm test` · exit 1", output: "fail", failed: true, promptChars: 0 })
  assert.strictEqual(steps.steps[1].status, "failed")

  steps.start({ id: "2.0", name: "run_command", args: { command: "rm -rf out" } })
  const skipped = steps.approve("rm -rf out")
  steps.answer("2.0", false)
  assert.strictEqual(await skipped, false)
  steps.finish({ id: "2.0", index: 2, mode: "native", summary: "`rm -rf out` skipped", output: "…", promptChars: 0 })
  assert.strictEqual(steps.steps[2].status, "skipped")

  steps.start({ id: "3.0", name: "run_command", args: { command: "make" } })
  const stopped = steps.approve("make")
  steps.cancelWaiting()
  assert.strictEqual(await stopped, false, "stopping the reply skips a waiting command")

  steps.reset()
  assert.deepStrictEqual(steps.steps, [])
})

test("the loop reports each call before and after it runs, and can leave step lines out of the text", async () => {
  const { client } = scripted([
    { calls: [{ id: "a", name: "find_symbol", arguments: "{\"name\":\"ModelWarmer\"}" }, { id: "b", name: "read_file", arguments: "{\"path\":\"nope.ts\"}" }] },
    "Answer."
  ])
  const events: string[] = []
  const text = await collect(
    withTools(client, workspaceTools(makeWorkspace()), {
      mode: "native",
      stepLines: false,
      onToolStart: (start) => events.push(`start ${start.id} ${start.name}`),
      onStep: (step) => events.push(`end ${step.id} ${step.failed ? "failed" : "ok"} ${step.output.split("\n")[0]}`)
    }).chat({ model: "m", messages: [{ role: "user", content: "Where?" }] })
  )
  assert.strictEqual(text, "Answer.")
  assert.deepStrictEqual(events, [
    "start 0.0 find_symbol",
    "end 0.0 ok src/warmer.ts:1: export class ModelWarmer {",
    "start 0.1 read_file",
    "end 0.1 failed nope.ts does not exist."
  ])
})

test("hosted providers use native tools when fluency.js can pass them, as do the gateway and a paired device; Perplexity and QVAC use text", () => {
  const modes = Object.fromEntries(
    ["anthropic", "gemini", "mistral", "groq", "openrouter", "openai", "ollama", "lmstudio", "perplexity", "qvac", "twinny-remote", "twinny-p2p"].map((kind) => [kind, toolModeFor(kind)])
  )
  assert.deepStrictEqual(modes, {
    anthropic: "native",
    gemini: "native",
    mistral: "native",
    groq: "native",
    openrouter: "native",
    openai: "native",
    ollama: "native",
    lmstudio: "native",
    perplexity: "text",
    qvac: "text",
    "twinny-remote": "native",
    "twinny-p2p": "native"
  })
})

test("a call written as code calls a function is read too, its arguments matched to the tool's", () => {
  const tools = [
    { name: "read_file", description: "", parameters: [{ name: "path", description: "" }, { name: "start_line", description: "", optional: true }] },
    { name: "grep", description: "", parameters: [{ name: "pattern", description: "" }, { name: "path", description: "", optional: true }] }
  ]
  const read = (text: string) => {
    const found = findToolCall(text, true)
    return found?.call ? nameArguments(found.call, tools) : found?.error
  }
  assert.deepStrictEqual(read("```tool\nfind_files(\"**/inference*adapter*\")\n```"), { name: "find_files", args: { "0": "**/inference*adapter*" } }, "an unknown tool keeps its positions")
  assert.deepStrictEqual(read("```tool\ngrep(\"a, b (c)\", 'src')\n```"), { name: "grep", args: { pattern: "a, b (c)", path: "src" } })
  assert.deepStrictEqual(read("```tool\nread_file(path=\"src/a.ts\", start_line=10)\n```"), { name: "read_file", args: { path: "src/a.ts", start_line: "10" } })
  assert.deepStrictEqual(read("```tool\nread_file(\"src/a.ts\", 10);\n```"), { name: "read_file", args: { path: "src/a.ts", start_line: "10" } })
  assert.deepStrictEqual(read("```tool\ngrep {\"pattern\": \"x\"}\n```"), { name: "grep", args: { pattern: "x" } })
  assert.deepStrictEqual(read("```tool\ngrep({\"pattern\": \"x\", \"path\": \"src\"})\n```"), { name: "grep", args: { pattern: "x", path: "src" } })
  assert.deepStrictEqual(read("<tool_call>\nlist_dir()\n</tool_call>"), { name: "list_dir", args: {} })
  assert.strictEqual(read("```tool\nplease read the file\n```"), "the call was not valid JSON")
})

test("the text protocol lists tools without the parentheses that invite function calls", async () => {
  const { client, requests } = scripted(["Hi."])
  await collect(withTools(client, workspaceTools(makeWorkspace())).chat({ model: "m", messages: [{ role: "user", content: "Hi" }] }))
  const system = requests[0].messages[0].content as string
  assert.match(system, /\n- read_file \{path, start_line\?, end_line\?\}: /)
  assert.doesNotMatch(system, /\n- \w+\(/)
})

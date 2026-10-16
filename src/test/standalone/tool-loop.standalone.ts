/**
 * The tool loop under pressure: a context too small for what the tools
 * return, a user who stops mid-tool, servers that count tokens and servers
 * that refuse things, and models that call too much, too late or not at
 * all. Scripted clients stand in for the model; the tools are real.
 */
import * as assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { ChatCompletionMessage } from "../../common/types"
import { buildChatTurn } from "../../extension/chat/turn"
import { ChatChunk, ChatRequest, InferenceClient, InferenceOptions, isCancelled } from "../../extension/inference"
import {
  fitResult,
  planContext,
  SMALL_CONTEXT_TOKENS,
  TokenEstimator,
  trimmedResult
} from "../../extension/tools/budget"
import { flattenToolHistory, ToolLoopUsage, ToolStep, withTools } from "../../extension/tools/loop"
import { ToolResult, WorkspaceTools, workspaceTools } from "../../extension/tools/workspace"
import { parsePeerFrame } from "../../protocol/peer"

type Call = { id: string; name: string; arguments: string }
type Reply =
  | string
  | { text?: string; calls?: Call[]; fail?: string; usage?: { promptTokens?: number; completionTokens?: number } }

/** A client that plays the scripted replies in turn and records each request. */
const scripted = (replies: Reply[]) => {
  const requests: ChatRequest[] = []
  const client = {
    id: "scripted",
    chat(request: ChatRequest) {
      requests.push(structuredClone(request))
      const next = replies.shift() ?? ""
      const reply = typeof next === "string" ? { text: next } : next
      return (async function* (): AsyncGenerator<ChatChunk> {
        if (reply.fail) throw new Error(reply.fail)
        const text = reply.text ?? ""
        for (let i = 0; i < text.length; i += 7) yield { content: text.slice(i, i + 7) }
        if (reply.calls) yield { content: "", toolCalls: reply.calls, finishReason: "stop" }
        if (reply.usage) yield { content: "", usage: reply.usage }
      })()
    }
  } as unknown as InferenceClient
  return { client, requests }
}

const collect = async (stream: AsyncIterable<ChatChunk>) => {
  const chunks: ChatChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return { text: chunks.map((chunk) => chunk.content).join(""), chunks }
}

const workspace = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-loop-"))
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  return root
}

const read = (id: string, file: string): Call => ({ id, name: "read_file", arguments: JSON.stringify({ path: file }) })
const ask = (content: string): ChatRequest => ({ model: "m", messages: [{ role: "user", content }] })

/** Tools made of one function, for what real files cannot stage. */
const fakeTools = (run: (name: string, signal?: AbortSignal) => Promise<ToolResult>): WorkspaceTools => ({
  tools: [{ name: "wait", description: "Waits.", parameters: [], run: async () => ({ output: "", summary: "" }) }],
  orientation: "",
  run: (call, context) => run(call.name, context?.signal)
})

test("a context is shared out by its size", () => {
  const small = planContext(4096)
  const local = planContext(32_768)
  const hosted = planContext(200_000)
  assert.deepStrictEqual([small.limit, small.target, small.resultChars, small.notesChars], [2867, 1863, 2703, 1200])
  assert.deepStrictEqual([local.limit, local.resultChars, local.notesChars], [27_443, 21_626, 6000])
  assert.deepStrictEqual([hosted.resultChars, hosted.notesChars], [30_000, 6000], "one result never runs past its cap")
  assert.ok(small.window < SMALL_CONTEXT_TOKENS && local.window > SMALL_CONTEXT_TOKENS)

  const estimator = new TokenEstimator()
  assert.strictEqual(estimator.tokens(3300), 1000)
  estimator.observe(8000, 2000)
  assert.strictEqual(estimator.tokens(4000), 1000, "what the server counted corrects the next estimate")
  estimator.observe(8000, undefined)
  estimator.observe(100, 90)
  assert.strictEqual(estimator.charsPerToken, 4, "no count, or a request too small to learn from, changes nothing")

  const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
  const cut = fitResult(long, 200)
  assert.ok(cut.startsWith("line 0\n") && /\nline \d+\n… cut to fit the model's context \(\d+ more characters\)/.test(cut))
  assert.strictEqual(fitResult("short", 200), "short")
  assert.strictEqual(
    trimmedResult("src/a.ts (lines 1–150 of 900)\n1: import…\n2: …"),
    "src/a.ts (lines 1–150 of 900)\n[The rest was trimmed to save context. Run the tool again if you need it.]"
  )
})

test("old results are trimmed, oldest first, when the next request would not fit the context", async () => {
  const body = Array.from({ length: 60 }, (_, i) => `const value${i} = "${"x".repeat(30)}"`).join("\n")
  const root = workspace({ "a.ts": body, "b.ts": body, "c.ts": body, "d.ts": body })
  const { client, requests } = scripted([
    { calls: [read("1", "a.ts")] },
    { calls: [read("2", "b.ts")] },
    { calls: [read("3", "c.ts")] },
    { calls: [read("4", "d.ts")] },
    "All four read."
  ])
  const trims: number[] = []
  const estimates: number[] = []
  await collect(
    withTools(client, workspaceTools(root), {
      mode: "native",
      contextWindow: () => 4096,
      onTrim: (results) => trims.push(results),
      onRequest: (_chars, _step, _mode, tokens) => estimates.push(tokens)
    }).chat(ask("Read them all."))
  )
  const plan = planContext(4096)
  assert.ok(estimates.every((tokens) => tokens <= plan.limit), `every request fits: ${estimates.join(", ")}`)
  assert.ok(trims.length >= 1, "something had to go")
  const results = (request: ChatRequest) =>
    request.messages.filter((m) => m.role === "tool").map((m) => String(m.content))
  const last = results(requests[4])
  assert.strictEqual(last.length, 4, "every call keeps its result message, so the conversation stays well formed")
  assert.strictEqual(
    last[0],
    "a.ts (lines 1–60 of 60)\n[The rest was trimmed to save context. Run the tool again if you need it.]"
  )
  assert.match(last[3], /^d\.ts \(lines 1–60 of 60\)\n1: const value0/, "the newest result is whole")
  assert.ok(last[3].length <= plan.resultChars + 120, "and held to its share of the context")
  // Without a known context nothing is trimmed.
  const untrimmed = scripted([{ calls: [read("1", "a.ts")] }, { calls: [read("2", "b.ts")] }, "Done."])
  await collect(withTools(untrimmed.client, workspaceTools(root), { mode: "native" }).chat(ask("Read two.")))
  assert.ok(results(untrimmed.requests[2]).every((content) => content.includes("const value59")))
})

test("the reply reports what the server counted: the largest prompt, all the output", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const { client } = scripted([
    { calls: [read("1", "a.ts")], usage: { promptTokens: 900, completionTokens: 20 } },
    { calls: [read("2", "a.ts")], usage: { promptTokens: 1400, completionTokens: 25 } },
    { text: "It is 1.", usage: { promptTokens: 1250, completionTokens: 5 } }
  ])
  const seen: ToolLoopUsage[] = []
  const { chunks } = await collect(
    withTools(client, workspaceTools(root), { mode: "native", onUsage: (usage) => seen.push(usage) }).chat(ask("What is a?"))
  )
  assert.deepStrictEqual(seen.at(-1), { promptTokens: 1400, completionTokens: 50 })
  assert.deepStrictEqual(chunks.at(-1), { content: "", usage: { promptTokens: 1400, completionTokens: 50 } })
})

test("stopping the reply does not wait for a tool that is still running", async () => {
  const stop = new AbortController()
  let toolSawStop = false
  const tools = fakeTools(
    (_name, signal) =>
      new Promise<ToolResult>(() => {
        signal?.addEventListener("abort", () => (toolSawStop = true))
      })
  )
  const { client } = scripted([{ calls: [{ id: "1", name: "wait", arguments: "{}" }] }])
  const events: string[] = []
  const started = Date.now()
  setTimeout(() => stop.abort(), 30)
  await assert.rejects(
    collect(
      withTools(client, tools, {
        mode: "native",
        onToolStart: (start) => events.push(`start ${start.name}`),
        onNotes: (notes) => events.push(`notes ${notes}`),
        onEnd: () => events.push("end")
      }).chat(ask("Wait."), { signal: stop.signal } as InferenceOptions)
    ),
    (error) => isCancelled(error)
  )
  assert.ok(Date.now() - started < 2000)
  assert.ok(toolSawStop, "the tool is told, so a command can be interrupted")
  assert.deepStrictEqual(events, ["start wait", "notes undefined", "end"], "the host hears the reply is over")
})

test("a stopped reply still keeps what its tools did, for the next turn", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const stop = new AbortController()
  const { client } = scripted([{ calls: [read("1", "a.ts")] }, { fail: "unreachable" }])
  const notes: Array<string | undefined> = []
  const stopping = {
    ...client,
    chat: (request: ChatRequest, options?: InferenceOptions) => {
      if (request.messages.some((m) => m.role === "tool")) stop.abort()
      return client.chat(request, options)
    }
  } as InferenceClient
  await assert.rejects(
    collect(
      withTools(stopping, workspaceTools(root), { mode: "native", onNotes: (n) => notes.push(n) }).chat(ask("Read."), {
        signal: stop.signal
      } as InferenceOptions)
    )
  )
  assert.deepStrictEqual(notes, ["read_file {\"path\":\"a.ts\"}\na.ts (lines 1–1 of 1)\n1: export const a = 1"])
})

test("calls beyond what one reply may run are named to the model, not dropped in silence", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const { client, requests } = scripted([
    { calls: Array.from({ length: 10 }, (_, i) => read(`c${i}`, "a.ts")) },
    "Read."
  ])
  const steps: string[] = []
  await collect(
    withTools(client, workspaceTools(root), { mode: "native", onStep: (step) => steps.push(step.id) }).chat(ask("Read a lot."))
  )
  assert.strictEqual(steps.length, 8)
  const [, , assistant, ...rest] = requests[1].messages as unknown as Array<Record<string, unknown>>
  assert.strictEqual((assistant.tool_calls as unknown[]).length, 8, "the conversation records only the calls that ran")
  const outputs = rest.map((m) => String(m.content))
  assert.match(outputs[7], /\n\(2 more calls in the same reply were not run; make them again if still needed\.\)$/)
  assert.ok(outputs.slice(0, 7).every((output) => !output.includes("not run")))
})

test("arguments that are not JSON go back to the server as an empty object, with the error as the result", async () => {
  const root = workspace({ "a.ts": "x\n" })
  const { client, requests } = scripted([{ calls: [{ id: "1", name: "read_file", arguments: "{path: a.ts" }] }, "Sorry."])
  await collect(withTools(client, workspaceTools(root), { mode: "native" }).chat(ask("Read.")))
  const [, , assistant, result] = requests[1].messages as unknown as Array<Record<string, unknown>>
  assert.deepStrictEqual((assistant.tool_calls as Array<{ function: unknown }>)[0].function, { name: "read_file", arguments: "{}" })
  assert.match(String(result.content), /^Your tool call could not be read: the arguments were not valid JSON \(.+\)\.\nYou wrote:\n~~~\n\{path: a\.ts\n~~~$/)
})

test("native arguments with the slips small models make are mended, not refused", async () => {
  const root = workspace({ "a.ts": "x\n" })
  const { client, requests } = scripted([
    { calls: [{ id: "1", name: "read_file", arguments: "{path: \"a.ts\",}" }] },
    "Read it."
  ])
  const steps: ToolStep[] = []
  await collect(withTools(client, workspaceTools(root), { mode: "native", onStep: (step) => steps.push(step) }).chat(ask("Read.")))
  assert.strictEqual(steps[0].parseError, undefined)
  assert.strictEqual(steps[0].summary, "read `a.ts:1–1`")
  const assistant = requests[1].messages[2] as unknown as { tool_calls: Array<{ function: { arguments: string } }> }
  assert.strictEqual(assistant.tool_calls[0].function.arguments, "{\"path\":\"a.ts\"}", "the conversation carries the mended arguments")
})

test("an error that names tools after tools have run is the reply's error, not a restart in text", async () => {
  const root = workspace({ "a.ts": "x\n" })
  const { client } = scripted([
    { calls: [read("1", "a.ts")] },
    { fail: "400 messages.2: `tool_result` blocks must follow a `tool_use` block" }
  ])
  const fallbacks: string[] = []
  await assert.rejects(
    collect(
      withTools(client, workspaceTools(root), { mode: "native", onFallback: (reason) => fallbacks.push(reason) }).chat(ask("Read."))
    ),
    /tool_result/
  )
  assert.deepStrictEqual(fallbacks, [], "what the tools found is not thrown away for a second attempt")
})

test("a server that wants tools declared beside tool history gets the history as plain messages for the last request", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const { client, requests } = scripted([
    { calls: [read("1", "a.ts")] },
    { fail: "400 tools must be provided when messages contain tool calls" },
    "a is 1."
  ])
  const { text } = await collect(
    withTools(client, workspaceTools(root), { mode: "native", maxSteps: 1, stepLines: false }).chat(ask("What is a?"))
  )
  assert.strictEqual(text, "a is 1.")
  const retry = requests[2]
  assert.strictEqual(retry.tools, undefined)
  assert.deepStrictEqual(retry.messages.map((m) => m.role), ["system", "user", "assistant", "user"])
  assert.strictEqual(retry.messages[2].content, "```tool\n{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.ts\"}}\n```")
  assert.match(
    String(retry.messages[3].content),
    /^<tool_result name="read_file">\na\.ts \(lines 1–1 of 1\)\n1: export const a = 1\n<\/tool_result>\n\nYou are out of tool calls/
  )
})

test("tool history flattens to plain messages, results of one reply together", () => {
  const flat = flattenToolHistory([
    { role: "system", content: "s" },
    { role: "user", content: "q" },
    {
      role: "assistant",
      content: "Looking.",
      tool_calls: [
        { id: "a", type: "function", function: { name: "grep", arguments: "{\"pattern\":\"x\"}" } },
        { id: "b", type: "function", function: { name: "list_dir", arguments: "not json" } }
      ]
    },
    { role: "tool", tool_call_id: "a", content: "No matches." },
    { role: "tool", tool_call_id: "b", content: "src/" }
  ] as unknown as ChatCompletionMessage[])
  assert.deepStrictEqual(flat.map((m) => m.role), ["system", "user", "assistant", "user"])
  assert.strictEqual(
    flat[2].content,
    "Looking.\n```tool\n{\"name\":\"grep\",\"arguments\":{\"pattern\":\"x\"}}\n```\n```tool\n{\"name\":\"list_dir\",\"arguments\":{}}\n```"
  )
  assert.strictEqual(
    flat[3].content,
    "<tool_result name=\"grep\">\nNo matches.\n</tool_result>\n\n<tool_result name=\"list_dir\">\nsrc/\n</tool_result>"
  )
})

test("a call written on the last request is neither run nor shown", async () => {
  const root = workspace({ "a.ts": "x\n" })
  const call = "```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.ts\"}}\n```"
  const { client, requests } = scripted([call, `Still looking.\n${call}`])
  const steps: string[] = []
  const { text } = await collect(
    withTools(client, workspaceTools(root), { maxSteps: 1, stepLines: false, onStep: (s) => steps.push(s.summary) }).chat(ask("Read."))
  )
  assert.strictEqual(requests.length, 2)
  assert.strictEqual(steps.length, 1)
  assert.strictEqual(text, "Still looking.\n")

  const only = scripted([call, call])
  const blank = await collect(
    withTools(only.client, workspaceTools(root), { maxSteps: 1, stepLines: false }).chat(ask("Read."))
  )
  assert.match(blank.text, /^I ran out of tool steps for this reply/, "a reply is never left blank")
})

test("a model that answers nothing after its tools still leaves a line to read", async () => {
  const root = workspace({ "a.ts": "x\n" })
  const { client } = scripted([{ calls: [read("1", "a.ts")] }, ""])
  const { text } = await collect(withTools(client, workspaceTools(root), { mode: "native", stepLines: false }).chat(ask("Read.")))
  assert.strictEqual(text, "The model finished without writing a reply; the steps above show what it did.")
})

test("in text mode a call is taken the moment its JSON closes and recorded with its closing marker", async () => {
  const root = workspace({ "a.ts": "x\n" })
  // The model rambles on after the call; none of that is read, shown or kept.
  const { client, requests } = scripted([
    "```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.ts\"}} and then I think the file says hello",
    "It says x."
  ])
  const { text } = await collect(withTools(client, workspaceTools(root), { stepLines: false }).chat(ask("Read.")))
  assert.strictEqual(text, "It says x.")
  assert.strictEqual(
    requests[1].messages[2].content,
    "```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.ts\"}}\n```"
  )
})

test("the previous reply's tool notes travel with the next question, once", async () => {
  const turn = await buildChatTurn(
    [
      { role: "user", content: "<p>first</p>" },
      { role: "assistant", content: "Old answer.", toolNotes: "grep {\"pattern\":\"old\"}\nold result" },
      { role: "user", content: "<p>second</p>" },
      { role: "assistant", content: "It is in a.ts.", toolNotes: "read_file {\"path\":\"a.ts\"}\n1: x" },
      { role: "user", content: "<p>and b?</p>" }
    ] as ChatCompletionMessage[],
    { systemPrompt: async () => "s", additionalContext: async () => "Selected Code:\nfoo" }
  )
  const texts = turn.map((message) =>
    typeof message.content === "string"
      ? message.content
      : (message.content as Array<{ text: string }>).map((part) => part.text).join("")
  )
  assert.deepStrictEqual(texts.slice(1, 5), ["first", "Old answer.", "second", "It is in a.ts."], "replies go back as they were shown")
  assert.strictEqual(
    texts[5],
    "[For reference: the tool calls and results behind your previous reply. The user did not see them.]\nread_file {\"path\":\"a.ts\"}\n1: x\n\n[The user's new message:]\nand b?\n\nSelected Code:\nfoo",
    "the notes come first, so the message ends on what the user is asking now"
  )
  assert.ok(!texts.join("\n").includes("old result"), "an older reply's notes are not carried any further")
  for (const message of turn) assert.deepStrictEqual(Object.keys(message).sort(), ["content", "role"])
})

test("a reply that failed after its tools ran still hands its notes on, past the error message", async () => {
  const turn = await buildChatTurn(
    [
      { role: "user", content: "<p>first</p>" },
      { role: "assistant", content: "", toolNotes: "read_file {\"path\":\"a.ts\"}\n1: x" },
      { role: "assistant", content: "The provider failed: 500." },
      { role: "user", content: "<p>try again</p>" }
    ] as ChatCompletionMessage[],
    { systemPrompt: async () => "s", additionalContext: async () => "" }
  )
  const last = turn[turn.length - 1].content as Array<{ text: string }>
  assert.match(last.map((part) => part.text).join(""), /^\[For reference: [^\n]*\]\nread_file \{"path":"a\.ts"\}\n1: x\n\n\[The user's new message:\]\ntry again$/)
})

test("a reply stopped before any text still takes its turn, and its tools' notes still travel", async () => {
  const turn = await buildChatTurn(
    [
      { role: "user", content: "<p>rename it</p>" },
      { role: "assistant", content: "", toolNotes: "edit_file {\"path\":\"a.ts\"}\nApplied and saved." },
      { role: "user", content: "<p>continue</p>" }
    ] as ChatCompletionMessage[],
    { systemPrompt: async () => "s", additionalContext: async () => "" }
  )
  const text = (message: ChatCompletionMessage) =>
    typeof message.content === "string" ? message.content : (message.content as Array<{ text: string }>)[0].text
  assert.deepStrictEqual(turn.map((m) => m.role), ["system", "user", "assistant", "user"])
  assert.strictEqual(text(turn[2]), "(This reply was stopped before any text was written.)")
  assert.match(text(turn[3]), /Applied and saved\.\n\n\[The user's new message:\]\ncontinue$/)
})

test("a reply saved with a tool transcript by an earlier build goes back as it was shown", async () => {
  const turn = await buildChatTurn(
    [
      { role: "user", content: "<p>q</p>" },
      { role: "assistant", content: "It is in a.ts.", prompt: "[What I looked at in the workspace before answering]\nread_file {}\n1: x\n\n[My answer]\nIt is in a.ts." },
      { role: "user", content: "<p>and?</p>" }
    ] as ChatCompletionMessage[],
    { systemPrompt: async () => "s", additionalContext: async () => "" }
  )
  assert.deepStrictEqual(turn[2].content, [{ type: "text", text: "It is in a.ts." }])
})

test("a gateway from before tools refuses the field by name, and the loop carries on in text", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const { client, requests } = scripted([
    { fail: "Invalid request: unknown field \"tools\"." },
    "```tool\n{\"name\":\"read_file\",\"args\":{\"path\":\"a.ts\"}}\n```",
    "It exports a."
  ])
  const fallbacks: string[] = []
  const { text } = await collect(
    withTools(client, workspaceTools(root), { mode: "native", onFallback: (_reason, what) => fallbacks.push(what) }).chat(ask("What is in a.ts?"))
  )
  assert.deepStrictEqual(fallbacks, ["tools"])
  assert.ok(requests[0].tools?.length)
  assert.ok(!requests[1].tools, "asked again without the field the gateway refused")
  assert.match(text, /It exports a\./)
  // The call was keyed `args`, and its path still reached the tool.
  assert.match(String(requests[2].messages[requests[2].messages.length - 1].content), /a\.ts \(lines 1–1 of 1\)\n1: export const a = 1/)
})

test("arguments keyed args, input or params reach the tool", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  for (const key of ["args", "input", "params"]) {
    const { client } = scripted([`\`\`\`tool\n{"name": "read_file", "${key}": {"path": "a.ts"}}\n\`\`\``, "Done."])
    const steps: ToolStep[] = []
    await collect(withTools(client, workspaceTools(root), { onStep: (step) => steps.push(step) }).chat(ask("Read.")))
    assert.strictEqual(steps[0].failed, undefined, key)
    assert.match(steps[0].output, /1: export const a = 1/, key)
  }
})

test("an answer that talks about tool-call tags is an answer, not a broken call", async () => {
  const root = workspace({ "a.ts": "x\n" })
  for (const mode of ["text", "native"] as const) {
    for (const answer of [
      "Qwen wraps calls in `<tool_call>` tags, which Ollama strips from the reply.",
      "Qwen wraps calls in <tool_call> tags, which Ollama strips from the reply."
    ]) {
      const { client, requests } = scripted([answer])
      const steps: ToolStep[] = []
      const { text } = await collect(
        withTools(client, workspaceTools(root), { mode, maxSteps: 2, onStep: (step) => steps.push(step) }).chat(ask("How?"))
      )
      assert.strictEqual(text, answer, `${mode}: ${answer}`)
      assert.strictEqual(steps.length, 0)
      assert.strictEqual(requests.length, 1)
    }
  }
})

test("on the last request a stray call is left out and the answer after it is kept", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const call = "```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.ts\"}}\n```"
  const { client } = scripted([call, `Let me check once more:\n${call}\nSince I am out of calls: a is 1.`])
  const { text } = await collect(withTools(client, workspaceTools(root), { maxSteps: 1, stepLines: false }).chat(ask("What is a?")))
  assert.strictEqual(text, "Let me check once more:\n\nSince I am out of calls: a is 1.")
})

test("text held back in case it began a call is shown when the calls come natively", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const { client } = scripted([
    { text: "Current code:\n```ts\nconst a = 1\n```", calls: [read("1", "a.ts")] },
    { text: "Checking whether a <", calls: [read("2", "a.ts")] },
    "Done."
  ])
  const { text } = await collect(withTools(client, workspaceTools(root), { mode: "native", stepLines: false }).chat(ask("Look.")))
  assert.strictEqual(text, "Current code:\n```ts\nconst a = 1\n```Checking whether a <Done.")
})

test("call markup a server leaves in the text beside native calls is not shown", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const { client } = scripted([
    { text: "Reading it.\n<tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.ts\"", calls: [read("1", "a.ts")] },
    "Done."
  ])
  const { text } = await collect(withTools(client, workspaceTools(root), { mode: "native", stepLines: false }).chat(ask("Read.")))
  assert.strictEqual(text, "Reading it.\nDone.")
})

test("a call fenced as JSON inside tool_call tags is still a call", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const { client } = scripted(["<tool_call>\n```json\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.ts\"}}\n```\n</tool_call>", "It is 1."])
  const steps: ToolStep[] = []
  const { text } = await collect(
    withTools(client, workspaceTools(root), { stepLines: false, onStep: (step) => steps.push(step) }).chat(ask("What is a?"))
  )
  assert.strictEqual(steps[0]?.name, "read_file")
  assert.strictEqual(steps[0]?.failed, undefined)
  assert.strictEqual(text, "It is 1.")
})

test("the next turn's notes keep what a tool returned, not the folder's instructions ahead of it", async () => {
  const root = workspace({ "lib/AGENTS.md": "x".repeat(3000), "lib/a.ts": "export const answer = 42\n" })
  const { client } = scripted([{ calls: [read("1", "lib/a.ts")] }, "42."])
  let notes: string | undefined
  await collect(withTools(client, workspaceTools(root), { mode: "native", onNotes: (n) => (notes = n) }).chat(ask("Read.")))
  assert.match(notes ?? "", /1: export const answer = 42/)
  assert.doesNotMatch(notes ?? "", /xxxx/)
})

test("a reply that ends on an edit waiting for review says so, not that it ran out of steps", async () => {
  const { client } = scripted([{ calls: [{ id: "1", name: "wait", arguments: "{}" }] }, ""])
  const tools = fakeTools(async () => ({ output: "Proposed.", summary: "proposed an edit", final: true }))
  const { text } = await collect(withTools(client, tools, { mode: "native", stepLines: false }).chat(ask("Fix it.")))
  assert.strictEqual(text, "The change is waiting in the editor for you to accept or reject.")
})

test("calls made together share the room, so the next request has every result whole", async () => {
  const body = Array.from({ length: 400 }, (_, i) => `export const value${i} = ${i}`).join("\n")
  const root = workspace({ "a.ts": body, "b.ts": body, "c.ts": body, "d.ts": body })
  const { client, requests } = scripted([
    { calls: ["a", "b", "c", "d"].map((name, i) => read(String(i), `${name}.ts`)) },
    "Read all four."
  ])
  const trims: number[] = []
  await collect(
    withTools(client, workspaceTools(root), { mode: "native", contextWindow: () => 8192, onTrim: (n) => trims.push(n) }).chat(ask("Read them."))
  )
  const results = requests[1].messages.filter((m) => m.role === "tool").map((m) => String(m.content))
  assert.strictEqual(results.length, 4)
  assert.ok(results.every((result) => !result.includes("[The rest was trimmed")), "none trimmed before the model saw it")
  assert.deepStrictEqual(trims, [])
})

test("a teammate's computer hands back its model's tool calls, and nothing shaped otherwise", () => {
  const frame = (chunk: unknown) => parsePeerFrame(JSON.stringify({ type: "chunk", id: "j1", chunk }))
  const calls = [{ id: "call_a", name: "read_file", arguments: "{}" }]
  assert.deepStrictEqual(frame({ content: "", toolCalls: calls, finishReason: "stop", extra: 1 }), {
    type: "chunk",
    id: "j1",
    chunk: { content: "", finishReason: "stop", toolCalls: calls }
  })
  assert.throws(() => frame({ content: "", toolCalls: [{ id: "a", name: "x", arguments: {} }] }), /toolCalls/)
})

test("a text call that cannot be read is quoted back with what the parser said", async () => {
  const root = workspace({ "a.ts": "x\n" })
  const { client, requests } = scripted(["```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": 'a.ts'}}\n```", "Done."])
  await collect(withTools(client, workspaceTools(root), { mode: "text" }).chat(ask("Read.")))
  const result = String(requests[1].messages[requests[1].messages.length - 1].content)
  assert.match(result, /could not be read: the call was not valid JSON \(.+\)\./)
  // Read as far as the object went: the stream is cut there, before the closing fence.
  assert.ok(result.includes("You wrote:\n~~~\n```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": 'a.ts'}}\n~~~"), result)
  assert.match(result, /line breaks inside strings written as \\n/)
})

test("a call repeated with nothing changed in between is answered with a pointer, not run again", async () => {
  const root = workspace({ "a.ts": "one\n", "b.ts": "two\n" })
  const { client, requests } = scripted([
    { calls: [read("1", "a.ts")] },
    { calls: [{ id: "2", name: "read_file", arguments: JSON.stringify({ path: " a.ts " }) }] },
    { calls: [read("3", "b.ts")] },
    "Both read."
  ])
  const steps: ToolStep[] = []
  const tools = workspaceTools(root)
  let runs = 0
  const counting: WorkspaceTools = { ...tools, run: (call, context) => (runs++, tools.run(call, context)) }
  await collect(withTools(client, counting, { mode: "native", onStep: (step) => steps.push(step) }).chat(ask("Read.")))
  assert.strictEqual(runs, 2, "the repeat never reached the tool")
  assert.strictEqual(steps[1].summary, "read `a.ts:1–1` · repeated, not run again")
  const repeat = requests[2].messages[requests[2].messages.length - 1]
  assert.match(String(repeat.content), /^You already called read_file with these same arguments in this reply/)
  assert.ok(requests[3].tools, "one repeat is not enough to stop the reply's tools")
})

test("a read after a change runs again, and so does one whose result was trimmed away", async () => {
  const root = workspace({ "a.ts": "one\n" })
  const edits = {
    mode: "apply" as const,
    edit: async (file: string) => {
      fs.writeFileSync(file, "two\n")
      return { ok: true, message: "Applied." }
    },
    create: async () => ({ ok: true, message: "Created." })
  }
  const { client } = scripted([
    { calls: [read("1", "a.ts")] },
    { calls: [{ id: "2", name: "edit_file", arguments: JSON.stringify({ path: "a.ts", find: "one", replace: "two" }) }] },
    { calls: [read("3", "a.ts")] },
    "Changed."
  ])
  const steps: ToolStep[] = []
  await collect(withTools(client, workspaceTools(root, [], { edits }), { mode: "native", onStep: (step) => steps.push(step) }).chat(ask("Change.")))
  assert.strictEqual(steps[2].summary, "read `a.ts:1–1`")
  assert.match(steps[2].output, /1: two/)

  const body = Array.from({ length: 60 }, (_, i) => `const value${i} = "${"x".repeat(30)}"`).join("\n")
  const big = workspace({ "a.ts": body, "b.ts": body, "c.ts": body })
  const again = scripted([
    { calls: [read("1", "a.ts")] },
    { calls: [read("2", "b.ts")] },
    { calls: [read("3", "c.ts")] },
    { calls: [read("4", "a.ts")] },
    "Read."
  ])
  const later: ToolStep[] = []
  await collect(
    withTools(again.client, workspaceTools(big), { mode: "native", contextWindow: () => 4096, onStep: (step) => later.push(step) }).chat(
      ask("Read.")
    )
  )
  assert.ok(!later[3].summary.includes("repeated"), "a.ts was trimmed out of the context, so it is read again")
})

test("a model going round in circles is asked for its answer instead of using up every step", async () => {
  const root = workspace({ "a.ts": "one\n" })
  const { client, requests } = scripted([
    { calls: [read("1", "a.ts")] },
    { calls: [read("2", "a.ts")] },
    { calls: [read("3", "a.ts")] },
    { calls: [read("4", "a.ts")] },
    "It says one."
  ])
  let outOfSteps = 0
  const { text } = await collect(
    withTools(client, workspaceTools(root), { mode: "native", stepLines: false, onOutOfSteps: () => outOfSteps++ }).chat(ask("Read."))
  )
  assert.strictEqual(requests.length, 5)
  assert.strictEqual(requests[4].tools, undefined, "after three repeats the next request offers no tools")
  assert.match(String(requests[4].messages[requests[4].messages.length - 1].content), /out of tool calls/)
  assert.strictEqual(text, "It says one.")
  assert.strictEqual(outOfSteps, 0, "going round in circles is not running out of steps")

  const unreadable = scripted(["```tool\n{oops}\n```", "```tool\n{oops}\n```", "```tool\n{oops}\n```", ""])
  const { text: said } = await collect(
    withTools(unreadable.client, workspaceTools(root), { mode: "text", stepLines: false }).chat(ask("Read."))
  )
  assert.strictEqual(unreadable.requests.length, 4, "three unreadable calls in a row, then the answer")
  assert.match(said, /going round in circles/)
})

test("using every step is reported, so the chat can offer to continue", async () => {
  const root = workspace({ "a.ts": "one\n", "b.ts": "two\n" })
  const { client } = scripted([{ calls: [read("1", "a.ts")] }, { calls: [read("2", "b.ts")] }, ""])
  let outOfSteps = 0
  const { text } = await collect(
    withTools(client, workspaceTools(root), { mode: "native", maxSteps: 2, stepLines: false, onOutOfSteps: () => outOfSteps++ }).chat(
      ask("Read.")
    )
  )
  assert.strictEqual(outOfSteps, 1)
  assert.match(text, /ran out of tool steps .* Continue, and I will carry on/)

  const early = scripted([{ calls: [read("1", "a.ts")] }, "Done."])
  let reported = 0
  await collect(withTools(early.client, workspaceTools(root), { mode: "native", maxSteps: 2, onOutOfSteps: () => reported++ }).chat(ask("Read.")))
  assert.strictEqual(reported, 0)
})

test("what the user sends mid-reply reaches the model at its next step, and the next turn's notes", async () => {
  const root = workspace({ "a.ts": "one\n", "b.ts": "two\n" })
  const waiting = ["Look in b.ts instead."]
  let asked = 0
  let notes: string | undefined
  const steering = () => (asked++, waiting.splice(0))
  const { client, requests } = scripted([{ calls: [read("1", "a.ts")] }, { calls: [read("2", "b.ts")] }, "b.ts says two."])
  await collect(
    withTools(client, workspaceTools(root), { mode: "native", steering, onNotes: (n) => (notes = n) }).chat(ask("Read a.ts."))
  )
  assert.strictEqual(asked, 2, "asked before each request after the first")
  const second = requests[1].messages
  assert.deepStrictEqual(second.slice(-2).map((m) => m.role), ["tool", "user"])
  assert.strictEqual(
    second[second.length - 1].content,
    "While you were working, the user wrote:\n\nLook in b.ts instead.\n\nTake that into account and carry on."
  )
  assert.strictEqual(requests[2].messages.filter((m) => m.role === "user").length, 2, "said once, kept in the conversation")
  assert.match(notes ?? "", /The user, while you worked: Look in b\.ts instead\./)

  const text = scripted(["```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.ts\"}}\n```", "Done."])
  const queue = ["Also check b.ts.", "And be brief."]
  await collect(withTools(text.client, workspaceTools(root), { mode: "text", steering: () => queue.splice(0) }).chat(ask("Read.")))
  const last = text.requests[1].messages[text.requests[1].messages.length - 1]
  assert.strictEqual(last.role, "user")
  assert.match(
    String(last.content),
    /^<tool_result name="read_file">[\s\S]*<\/tool_result>\n\nWhile you were working, the user wrote these messages:\n\nAlso check b\.ts\.\n\nAnd be brief\.\n\nTake that/
  )
})

test("what the user said mid-reply in text mode outlasts the result it followed being trimmed", async () => {
  const body = Array.from({ length: 60 }, (_, i) => `const value${i} = "${"x".repeat(30)}"`).join("\n")
  const root = workspace({ "a.ts": body, "b.ts": body, "c.ts": body, "d.ts": body })
  const readCall = (file: string) => "```tool\n" + JSON.stringify({ name: "read_file", arguments: { path: file } }) + "\n```"
  const { client, requests } = scripted([readCall("a.ts"), readCall("b.ts"), readCall("c.ts"), readCall("d.ts"), "All read."])
  const waiting = ["Only the constants matter."]
  let trims = 0
  await collect(
    withTools(client, workspaceTools(root), {
      mode: "text",
      contextWindow: () => 4096,
      steering: () => waiting.splice(0),
      onTrim: (n) => (trims += n)
    }).chat(ask("Read them."))
  )
  assert.ok(trims > 0, "the first result was trimmed")
  const first = String(requests[requests.length - 1].messages[3].content)
  assert.match(first, /^<tool_result name="read_file">\n[\s\S]*trimmed to save context[\s\S]*<\/tool_result>\n\nWhile you were working, the user wrote:\n\nOnly the constants matter\./)
})

test("a read that failed is tried again rather than pointed back to", async () => {
  const root = workspace({ "a.ts": "one\n" })
  const { client } = scripted([
    { calls: [read("1", "missing.ts")] },
    { calls: [read("2", "missing.ts")] },
    "Not there."
  ])
  const steps: ToolStep[] = []
  await collect(withTools(client, workspaceTools(root), { mode: "native", onStep: (step) => steps.push(step) }).chat(ask("Read.")))
  assert.ok(steps[1].failed && !steps[1].summary.includes("repeated"), steps[1].summary)
})

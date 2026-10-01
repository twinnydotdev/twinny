/**
 * Knowing how full a model's context is: asking the server for its token
 * counts and its context size, and the chat's steps saying how a reply
 * ended. A local fake stands in for Ollama and llama.cpp.
 */
import type { TokenJS } from "fluency.js"
import * as assert from "node:assert"
import * as http from "node:http"
import { AddressInfo } from "node:net"
import { test } from "node:test"

import { ChatCompletionMessage, TwinnyProvider } from "../../common/types"
import { ToolSteps } from "../../extension/chat/tool-steps"
import { buildStreamingRequest, fluencyChat, parsableToolArguments } from "../../extension/inference/adapters/fluency"
import {
  assumedContextWindow,
  contextWindowOf,
  forgetContextWindows,
  knownContextWindow
} from "../../extension/inference/context-window"
import { ChatChunk } from "../../extension/inference/types"

const provider = (kind: string, extra: Partial<TwinnyProvider> = {}): TwinnyProvider =>
  ({ id: kind, label: kind, provider: kind, type: "chat", modelName: "m", ...extra }) as TwinnyProvider

const tool = { name: "grep", description: "search", parameters: { type: "object" } }
const conversation = [
  { role: "system", content: "Be brief." },
  { role: "user", content: "Hi" }
] as ChatCompletionMessage[]

test("OpenAI-style servers are asked to count a streamed request; others are not sent the option", () => {
  for (const kind of ["ollama", "lmstudio", "llamacpp", "litellm", "openai-compatible", "openai"]) {
    assert.deepStrictEqual(
      (buildStreamingRequest(provider(kind), conversation) as { stream_options?: unknown }).stream_options,
      { include_usage: true },
      kind
    )
  }
  for (const kind of ["anthropic", "gemini", "mistral", "qvac"]) {
    assert.ok(!("stream_options" in buildStreamingRequest(provider(kind), conversation)), kind)
  }
})

test("Anthropic is told to cache the system prompt, tools and steps so far of a tool conversation, and only of one", () => {
  const marked = (request: { messages: unknown[] }) =>
    (request.messages as Array<{ role: string; cache_control?: unknown }>).filter((m) => m.cache_control)
  const withTools = buildStreamingRequest(provider("anthropic"), conversation, { tools: [tool] })
  assert.deepStrictEqual(marked(withTools), [{ role: "system", content: "Be brief.", cache_control: { type: "ephemeral" } }])
  const history = [
    ...conversation,
    { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "grep", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", content: "No matches." }
  ] as unknown as ChatCompletionMessage[]
  const twoResults = [
    ...history,
    { role: "assistant", content: null, tool_calls: [{ id: "b", type: "function", function: { name: "grep", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "b", content: "1: x" },
    { role: "user", content: "Answer now." }
  ] as unknown as ChatCompletionMessage[]
  assert.deepStrictEqual(
    marked(buildStreamingRequest(provider("anthropic"), twoResults)).map((m) => (m as { tool_call_id?: string }).tool_call_id ?? m.role),
    ["system", "b"],
    "the system prompt and the newest tool result: the conversation so far is read back, not paid for again"
  )
  assert.strictEqual(marked(buildStreamingRequest(provider("anthropic"), conversation)).length, 0, "a plain chat is not worth a cache write")
  assert.strictEqual(marked(buildStreamingRequest(provider("ollama"), conversation, { tools: [tool] })).length, 0)
})

test("a server that refuses stream_options is asked again without, and not asked for counts again", async () => {
  const bodies: Array<Record<string, unknown>> = []
  const client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          bodies.push(body)
          if ("stream_options" in body) throw new Error("400 Extra inputs are not permitted: body.stream_options")
          return (async function* () {
            yield { choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }] }
          })()
        }
      }
    }
  } as unknown as TokenJS
  const strict = provider("openai-compatible", { apiHostname: "strict.example", apiPort: 9 })
  const read = async () => {
    const chunks: ChatChunk[] = []
    for await (const chunk of fluencyChat(client, strict, { model: "m", messages: conversation })) chunks.push(chunk)
    return chunks.map((chunk) => chunk.content).join("")
  }
  assert.strictEqual(await read(), "Hello")
  assert.strictEqual(await read(), "Hello")
  assert.deepStrictEqual(
    bodies.map((body) => "stream_options" in body),
    [true, false, false],
    "refused once, then left out for that server"
  )
  assert.ok("stream_options" in buildStreamingRequest(provider("openai-compatible", { apiHostname: "other.example" }), conversation))
})

const fakeServer = async (routes: Record<string, (body: unknown) => unknown>) => {
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      hits.push(`${req.method} ${req.url}`)
      const route = routes[req.url ?? ""]
      const answer = route?.(raw ? JSON.parse(raw) : undefined)
      res.writeHead(answer === undefined ? 404 : 200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(answer ?? {}))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return { hits, port, close: () => server.close() }
}

test("Ollama says what a loaded model holds; before it is loaded, what its Modelfile sets", async () => {
  forgetContextWindows()
  let loaded = false
  const server = await fakeServer({
    "/api/ps": () => ({
      models: loaded
        ? [
            { name: "qwen3-coder:30b", model: "qwen3-coder:30b", context_length: 32768 },
            { name: "llama3:latest", model: "llama3:latest", context_length: 4096 }
          ]
        : []
    }),
    "/api/show": (body) =>
      (body as { model: string }).model === "tuned" ? { parameters: "temperature 0.7\nnum_ctx                        16384" } : { parameters: "temperature 0.7" }
  })
  try {
    const at = { apiHostname: "127.0.0.1", apiPort: server.port, apiProtocol: "http", apiPath: "/v1" }
    const qwen = provider("ollama", { ...at, modelName: "qwen3-coder:30b" })
    assert.strictEqual(await contextWindowOf(qwen), undefined, "Ollama decides when it loads the model")
    assert.strictEqual(knownContextWindow(qwen), undefined)
    assert.strictEqual(assumedContextWindow(qwen), 32_768)
    assert.strictEqual(await contextWindowOf(provider("ollama", { ...at, modelName: "tuned" })), 16_384)

    loaded = true
    forgetContextWindows()
    assert.strictEqual(await contextWindowOf(qwen), 32_768)
    assert.strictEqual(knownContextWindow(qwen), 32_768)
    const asked = server.hits.length
    assert.strictEqual(await contextWindowOf(qwen), 32_768)
    assert.strictEqual(server.hits.length, asked, "an answer is kept for a while, not asked for on every request")
    assert.strictEqual(
      await contextWindowOf(provider("ollama", { ...at, modelName: "llama3" })),
      4096,
      "`llama3` and `llama3:latest` are one model"
    )
    assert.strictEqual(await contextWindowOf(provider("ollama", { ...at, modelName: "not-loaded" })), undefined)
  } finally {
    server.close()
  }
})

test("llama.cpp says in its properties; a hosted API is not asked and is taken to be large", async () => {
  forgetContextWindows()
  const server = await fakeServer({ "/props": () => ({ default_generation_settings: { n_ctx: 8192 } }) })
  try {
    const llama = provider("llamacpp", { apiHostname: "127.0.0.1", apiPort: server.port, apiProtocol: "http" })
    assert.strictEqual(await contextWindowOf(llama), 8192)
    const hosted = provider("anthropic")
    assert.strictEqual(await contextWindowOf(hosted), undefined)
    assert.strictEqual(assumedContextWindow(hosted), 128_000)
    assert.deepStrictEqual(server.hits, ["GET /props"])
  } finally {
    server.close()
  }
})

test("a step cut off by a stop says so, and what is kept of a step is held to a size", () => {
  const sent: string[][] = []
  const steps = new ToolSteps((all) => sent.push(all.map((s) => `${s.id}:${s.status}`)))
  steps.start({ id: "0.0", name: "read_file", args: { path: "a.ts" } })
  steps.finish({ id: "0.0", index: 0, mode: "native", summary: "read `a.ts`", output: "x".repeat(9000), promptChars: 0 })
  steps.start({ id: "1.0", name: "create_file", args: { path: "b.ts", content: "y".repeat(50_000) } })
  assert.ok((steps.steps[0].output ?? "").length < 4100)
  assert.match(steps.steps[0].output ?? "", /… \(5000 more characters\)$/)
  assert.ok((steps.steps[1].args?.content ?? "").length < 2100, "a created file's whole content is not saved with the conversation")

  steps.start({ id: "1.1", name: "run_command", args: { command: "npm test" } })
  const answer = steps.approve("npm test")
  steps.settle()
  assert.deepStrictEqual(sent.at(-1), ["0.0:done", "1.0:stopped", "1.1:stopped"])
  assert.strictEqual(steps.steps[2].command, undefined, "nothing is left asking for an answer")
  return answer.then((run) => assert.strictEqual(run, false))
})

test("a tool call with no arguments goes back as {} so the SDKs can parse it", () => {
  // Anthropic streams nothing for a tool without parameters; fluency's
  // conversion then ran JSON.parse("") and the next step failed.
  const call = (args: string) =>
    ({ role: "assistant", content: null, tool_calls: [{ id: "t", type: "function", function: { name: "editor_context", arguments: args } }] }) as unknown as ChatCompletionMessage
  const argsOf = (message: ChatCompletionMessage) =>
    (message as unknown as { tool_calls: Array<{ function: { arguments: string } }> }).tool_calls[0].function.arguments
  const [empty, spaces, json, text] = parsableToolArguments([call(""), call("  "), call("{\"path\":\"a\"}"), call("src/a.ts")])
  assert.strictEqual(argsOf(empty), "{}")
  assert.strictEqual(argsOf(spaces), "{}")
  assert.strictEqual(argsOf(json), "{\"path\":\"a\"}")
  assert.deepStrictEqual(JSON.parse(argsOf(text)), { input: "src/a.ts" })
  const sent = buildStreamingRequest(provider("anthropic"), [...conversation, call("")], { tools: [tool] })
  assert.strictEqual(argsOf(sent.messages[2] as ChatCompletionMessage), "{}")
})

/**
 * OpenAI's Responses API, as twinny speaks it for tool conversations:
 * the conversation mapped to input items, and the event stream read back
 * as text, tool calls and usage. Run against a local fake server.
 */
import * as assert from "node:assert"
import * as http from "node:http"
import { AddressInfo } from "node:net"
import { test } from "node:test"

import { TwinnyProvider } from "../../common/types"
import {
  needsResponsesApi,
  responsesChat,
  toResponsesInput
} from "../../extension/inference/adapters/openai-responses"
import { ChatChunk, ChatMessage } from "../../extension/inference/types"

const conversation = [
  { role: "system", content: "Be brief." },
  { role: "user", content: [{ type: "text", text: "Fix greet." }] },
  {
    role: "assistant",
    content: "Reading it.",
    tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }]
  },
  { role: "tool", tool_call_id: "c1", content: "1: x" }
] as unknown as ChatMessage[]

test("the conversation becomes instructions and input items", () => {
  assert.deepStrictEqual(toResponsesInput(conversation), {
    instructions: "Be brief.",
    input: [
      { role: "user", content: "Fix greet." },
      { role: "assistant", content: "Reading it." },
      { type: "function_call", call_id: "c1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
      { type: "function_call_output", call_id: "c1", output: "1: x" }
    ]
  })
  assert.ok(needsResponsesApi({ model: "m", messages: conversation }))
  assert.ok(needsResponsesApi({ model: "m", messages: [], tools: [{ name: "t", description: "", parameters: {} }] }))
  assert.ok(!needsResponsesApi({ model: "m", messages: [{ role: "user", content: "hi" }] }))
})

const sse = (events: object[]) =>
  events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("")

const serve = async (reply: (body: Record<string, unknown>) => { status: number; body: string }) => {
  const received: Record<string, unknown>[] = []
  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      const body = JSON.parse(raw)
      received.push({ ...body, url: req.url, auth: req.headers.authorization })
      const { status, body: text } = reply(body)
      res.writeHead(status, { "Content-Type": status === 200 ? "text/event-stream" : "application/json" })
      // Split mid-event to check the reader joins chunks.
      res.write(text.slice(0, 40))
      setTimeout(() => res.end(text.slice(40)), 5)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  const config = {
    id: "o", label: "OpenAI", provider: "openai", type: "chat", modelName: "gpt-x",
    apiHostname: "127.0.0.1", apiPort: port, apiProtocol: "http", apiPath: "/v1", apiKey: "sk-test"
  } as TwinnyProvider
  return { config, received, close: () => server.close() }
}

const collect = async (stream: AsyncIterable<ChatChunk>) => {
  const chunks: ChatChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test("streams text, then the calls and usage when the response completes", async () => {
  const fake = await serve(() => ({
    status: 200,
    body: sse([
      { type: "response.created" },
      { type: "response.output_text.delta", delta: "Let me " },
      { type: "response.output_text.delta", delta: "look." },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "call_9", name: "grep", arguments: "{\"pattern\":\"x\"}" } },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 12, output_tokens: 3 } } }
    ])
  }))
  try {
    const chunks = await collect(
      responsesChat(fake.config, {
        model: "gpt-x",
        messages: conversation,
        tools: [{ name: "grep", description: "search", parameters: { type: "object" } }],
        reasoningEffort: "low",
        maxTokens: 500
      })
    )
    assert.strictEqual(chunks.map((c) => c.content).join(""), "Let me look.")
    assert.deepStrictEqual(chunks.at(-1), {
      content: "",
      finishReason: "stop",
      usage: { promptTokens: 12, completionTokens: 3 },
      toolCalls: [{ id: "call_9", name: "grep", arguments: "{\"pattern\":\"x\"}" }]
    })
    const [sent] = fake.received
    assert.strictEqual(sent.url, "/v1/responses")
    assert.strictEqual(sent.auth, "Bearer sk-test")
    assert.deepStrictEqual(
      { tools: sent.tools, reasoning: sent.reasoning, store: sent.store, max: sent.max_output_tokens, instructions: sent.instructions },
      {
        tools: [{ type: "function", name: "grep", description: "search", parameters: { type: "object" } }],
        reasoning: { effort: "low" },
        store: false,
        max: 500,
        instructions: "Be brief."
      }
    )
  } finally {
    fake.close()
  }
})

test("a refusal keeps OpenAI's own words, so the loop can tell what to drop", async () => {
  const fake = await serve(() => ({
    status: 400,
    body: JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning.effort' is not supported with this model." } })
  }))
  try {
    await assert.rejects(collect(responsesChat(fake.config, { model: "gpt-x", messages: conversation })), /reasoning\.effort/)
  } finally {
    fake.close()
  }
})

test("a response that runs out of tokens says so", async () => {
  const fake = await serve(() => ({
    status: 200,
    body: sse([
      { type: "response.output_text.delta", delta: "Partial" },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }
    ])
  }))
  try {
    const chunks = await collect(responsesChat(fake.config, { model: "gpt-x", messages: conversation }))
    assert.strictEqual(chunks.at(-1)?.finishReason, "length")
  } finally {
    fake.close()
  }
})

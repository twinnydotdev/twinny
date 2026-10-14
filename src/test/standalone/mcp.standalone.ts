/**
 * MCP servers as agent tools, against a real process speaking the stdio
 * transport (`suite/support/fake-mcp-server`): the handshake, paged tool
 * lists, typed arguments arriving typed, errors, a server that never
 * answers and one that dies, and the tools going through the agent loop
 * in both calling modes with their own schemas.
 */
import * as assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { McpHost } from "../../extension/chat/mcp-host"
import { ChatChunk, ChatRequest, InferenceClient } from "../../extension/inference"
import { withTools } from "../../extension/tools/loop"
import { coerceArguments, McpClient, mcpToolSpecs, qualifiedToolName } from "../../extension/tools/mcp"
import { toolDefinition } from "../../extension/tools/protocol"
import { workspaceTools } from "../../extension/tools/workspace"

const fakeServer = { command: process.execPath, args: [path.join(__dirname, "..", "suite", "support", "fake-mcp-server.js")] }
const cwd = os.tmpdir()

test("a server is started, shaken hands with, and its tools listed page by page", async () => {
  const stderr: string[] = []
  const client = new McpClient("fake", fakeServer, { cwd, onStderr: (text) => stderr.push(text) })
  try {
    const tools = await client.listTools()
    assert.deepStrictEqual(
      tools.map((tool) => tool.name),
      ["echo", "add", "fail", "slow", "crash", "odd.name/x"]
    )
    const echoed = await client.callTool("echo", { text: "hello" })
    assert.deepStrictEqual(echoed, { text: "hello\n[image]", isError: false }, "text in order, other content named")
    assert.deepStrictEqual(await client.callTool("fail", {}), { text: "no such issue", isError: true })
    assert.ok(stderr.join("").includes("a line on stderr"))
  } finally {
    client.close()
  }
})

test("arguments arrive as the server's schema types them, from the strings the tools pass", async () => {
  const add = { type: "object", properties: { a: { type: "number" }, b: { type: "number" }, options: { type: "object" }, loud: { type: "boolean" } } }
  assert.deepStrictEqual(coerceArguments(add, { a: "2", b: "3.5", options: "{\"x\":1}", loud: "true" }), {
    a: 2,
    b: 3.5,
    options: { x: 1 },
    loud: true
  })
  assert.deepStrictEqual(coerceArguments(add, { a: "two", options: "{not json", extra: "kept" }), {
    a: "two",
    options: "{not json",
    extra: "kept"
  })
  const client = new McpClient("fake", fakeServer, { cwd })
  try {
    assert.strictEqual((await client.callTool("add", coerceArguments(add, { a: "2", b: "3" }))).text, "5 (a:number,b:number)")
  } finally {
    client.close()
  }
})

test("a server that does not answer, or dies, fails the call and not the reply", async () => {
  const client = new McpClient("fake", fakeServer, { cwd, callTimeoutMs: 300 })
  try {
    await assert.rejects(client.callTool("slow", {}), /did not answer tools\/call within 0 s|did not answer tools\/call/)
    await assert.rejects(client.callTool("crash", {}), /The MCP server fake stopped: it exited with code 3/)
    await assert.rejects(client.callTool("echo", { text: "x" }), /not running/)
  } finally {
    client.close()
  }
  const missing = new McpClient("missing", { command: path.join(cwd, "no-such-mcp-server") }, { cwd, startTimeoutMs: 2000 })
  await assert.rejects(missing.start(), /could not start|stopped/)
  const stopped = new AbortController()
  const slow = new McpClient("fake", fakeServer, { cwd })
  try {
    const call = slow.callTool("slow", {}, stopped.signal)
    setTimeout(() => stopped.abort(), 200)
    await assert.rejects(call, /Stopped by the user/)
  } finally {
    slow.close()
  }
})

test("tool names are made safe for every provider and never clash", () => {
  assert.strictEqual(qualifiedToolName("git hub", "search/issues.v2"), "git_hub__search_issues_v2")
  assert.strictEqual(qualifiedToolName("s", "x".repeat(100)).length, 64)
  const taken = new Set<string>()
  const specs = mcpToolSpecs("fake", [{ name: "a.b" }, { name: "a_b" }, { name: "c", description: "d".repeat(500) }], taken)
  assert.deepStrictEqual(specs.map((spec) => spec.name), ["fake__a_b", "fake__a_b_2", "fake__c"])
  assert.ok(specs[2].description.length < 260, "a long description is cut")
  assert.deepStrictEqual(toolDefinition(specs[0]).parameters, { type: "object" }, "the server's own schema goes to native tool-calling")
})

const scripted = (replies: Array<string | { calls: { id: string; name: string; arguments: string }[] }>) => {
  const requests: ChatRequest[] = []
  const client = {
    id: "scripted",
    chat(request: ChatRequest) {
      requests.push(structuredClone(request))
      const next = replies.shift() ?? ""
      return (async function* (): AsyncGenerator<ChatChunk> {
        if (typeof next === "string") yield { content: next }
        else yield { content: "", toolCalls: next.calls, finishReason: "stop" }
      })()
    }
  } as unknown as InferenceClient
  return { client, requests }
}

test("an MCP tool goes through the agent loop in both calling modes, asked first, with typed arguments", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-mcp-loop-"))
  const host = new McpHost(() => ({ fake: fakeServer, broken: { args: ["no command"] } }), () => root)
  const asked: string[] = []
  let allow = true
  try {
    const tools = await host.ready()
    assert.ok(tools.some((tool) => tool.name === "fake__add"), "the broken entry is left out, the good server is up")
    const sink = host.sink(async (detail) => {
      asked.push(detail)
      return allow
    })

    const native = scripted([{ calls: [{ id: "1", name: "fake__add", arguments: "{\"a\": 2, \"b\": 3}" }] }, "It is 5."])
    const steps: string[] = []
    await (async () => {
      for await (const chunk of withTools(native.client, workspaceTools(root, [], { mcp: sink }), {
        mode: "native",
        onStep: (step) => steps.push(step.summary)
      }).chat({ model: "m", messages: [{ role: "user", content: "add" }] }))
        void chunk
    })()
    const offered = native.requests[0].tools?.find((tool) => tool.name === "fake__add")
    assert.strictEqual((offered?.parameters as { properties: { a: { type: string } } }).properties.a.type, "number")
    assert.deepStrictEqual(asked, ["fake/add {\"a\":2,\"b\":3}"], "the user is asked with the call in full")
    assert.match(String(native.requests[1].messages.at(-1)?.content), /^5 \(a:number,b:number\)$/)
    assert.deepStrictEqual(steps, ["`fake/add` · 5 (a:number,b:number)"])

    allow = false
    const text = scripted(["```tool\n{\"name\": \"fake__echo\", \"arguments\": {\"text\": \"hi\"}}\n```", "Skipped."])
    for await (const chunk of withTools(text.client, workspaceTools(root, [], { mcp: sink }), { mode: "text" }).chat({
      model: "m",
      messages: [{ role: "user", content: "echo" }]
    }))
      void chunk
    assert.match(String(text.requests[0].messages[0].content), /- fake__echo \{text\}: Says the text back\. \(from the MCP server fake\)/)
    assert.match(String(text.requests[1].messages.at(-1)?.content), /The user chose not to run this tool/)
  } finally {
    host.dispose()
  }
})

test("servers follow the settings: a changed entry is restarted, a removed one stopped", async () => {
  let servers: Record<string, unknown> = { fake: fakeServer }
  const host = new McpHost(() => servers, () => cwd)
  try {
    await host.ready()
    assert.strictEqual(host.tools.length, 6)
    servers = { other: fakeServer }
    await host.ready()
    assert.ok(host.tools.every((tool) => tool.server === "other"))
    servers = {}
    await host.ready()
    assert.deepStrictEqual(host.tools, [])
    assert.ok(!host.configured)
  } finally {
    host.dispose()
  }
})

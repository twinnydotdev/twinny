/**
 * Project instructions for agent mode: the root's `AGENTS.md` (or the file
 * read in its place) in the system prompt, and a folder's own `AGENTS.md`
 * with the first tool result that reaches it. Scripted clients stand in
 * for the model; the tools and files are real.
 */
import * as assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { ChatChunk, ChatRequest, InferenceClient } from "../../extension/inference"
import { isProtectedPath } from "../../extension/tools/helpers"
import {
  FolderInstructions,
  MAX_ROOT_INSTRUCTION_CHARS,
  readRootInstructions
} from "../../extension/tools/instructions"
import { ToolStep, withTools } from "../../extension/tools/loop"
import { WorkspaceView } from "../../extension/tools/view"
import { workspaceTools } from "../../extension/tools/workspace"

type Call = { id: string; name: string; arguments: string }

const workspace = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-instructions-"))
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  return root
}

const scripted = (replies: Array<string | { calls: Call[] }>) => {
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

const read = (id: string, file: string): Call => ({ id, name: "read_file", arguments: JSON.stringify({ path: file }) })
const ask = (content: string): ChatRequest => ({
  model: "m",
  messages: [
    { role: "system", content: "You are twinny." },
    { role: "user", content }
  ]
})
const drain = async (stream: AsyncIterable<ChatChunk>) => {
  for await (const chunk of stream) void chunk
}
const systemOf = (request: ChatRequest) => String(request.messages[0].content)
const toolResults = (request: ChatRequest) =>
  request.messages.filter((m) => m.role === "tool").map((m) => String(m.content))

test("the root's AGENTS.md goes into the system prompt, after the tools", async () => {
  const root = workspace({ "AGENTS.md": "Use pnpm, never npm.\n", "a.ts": "export const a = 1\n" })
  const { client, requests } = scripted(["Noted."])
  const tools = workspaceTools(root)
  await drain(withTools(client, tools, { mode: "native" }).chat(ask("How do I install?")))
  const system = systemOf(requests[0])
  assert.match(system, /^You are twinny\./, "the chat's own system prompt still comes first")
  assert.match(system, /instructions for coding agents, from AGENTS\.md[\s\S]*Use pnpm, never npm\.$/)
  assert.ok(system.indexOf("Use pnpm") > system.indexOf("You can work in the user's workspace"))
  assert.deepStrictEqual(tools.instructionFiles?.(), ["AGENTS.md"])
})

test("without AGENTS.md, CLAUDE.md is read; with both, AGENTS.md wins; with neither, nothing", () => {
  assert.deepStrictEqual(readRootInstructions(workspace({ "CLAUDE.md": "Tabs." })), { path: "CLAUDE.md", text: "Tabs." })
  assert.strictEqual(readRootInstructions(workspace({ "AGENTS.md": "Spaces.", "CLAUDE.md": "Tabs." }))?.text, "Spaces.")
  assert.strictEqual(
    readRootInstructions(workspace({ ".github/copilot-instructions.md": "Be brief." }))?.path,
    ".github/copilot-instructions.md"
  )
  assert.strictEqual(readRootInstructions(workspace({ "README.md": "Hello" })), undefined)
  assert.strictEqual(readRootInstructions(workspace({ "AGENTS.md": "  \n" })), undefined, "an empty file is no instructions")
  const root = workspace({ "a.ts": "" })
  const tools = workspaceTools(root, [], { instructions: false })
  assert.strictEqual(tools.instructions, undefined)
})

test("a long AGENTS.md is cut, and says so", () => {
  const root = workspace({ "AGENTS.md": "x".repeat(MAX_ROOT_INSTRUCTION_CHARS + 500) })
  const text = readRootInstructions(root)?.text ?? ""
  assert.ok(text.startsWith("x".repeat(MAX_ROOT_INSTRUCTION_CHARS)))
  assert.match(text, /\(cut: the file goes on for 500 more characters\)$/)
})

test("an AGENTS.md that links outside the workspace is not read", () => {
  const outside = workspace({ "secret.txt": "the private key" })
  const root = workspace({ "a.ts": "" })
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "AGENTS.md"))
  fs.mkdirSync(path.join(root, "pkg"))
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "pkg", "AGENTS.md"))
  fs.writeFileSync(path.join(root, "pkg", "b.ts"), "")
  assert.strictEqual(readRootInstructions(root), undefined)
  assert.deepStrictEqual(new FolderInstructions(new WorkspaceView(root)).for("pkg/b.ts"), [])
})

test("a folder's AGENTS.md comes with the first result under it, outermost first, once a reply", async () => {
  const root = workspace({
    "AGENTS.md": "Root rules.",
    "packages/AGENTS.md": "Packages are published; keep exports stable.",
    "packages/web/AGENTS.md": "Use React function components.",
    "packages/web/app.tsx": "export const App = () => null\n",
    "packages/web/util.ts": "export const id = (x: unknown) => x\n",
    "other.ts": "export const other = 1\n"
  })
  const { client, requests } = scripted([
    { calls: [read("1", "other.ts")] },
    { calls: [read("2", "packages/web/app.tsx")] },
    { calls: [read("3", "packages/web/util.ts")] },
    "Read."
  ])
  const steps: ToolStep[] = []
  const tools = workspaceTools(root)
  await drain(withTools(client, tools, { mode: "native", onStep: (step) => steps.push(step) }).chat(ask("Look.")))
  const [other, app, util] = toolResults(requests[3])
  assert.match(other, /^other\.ts \(lines 1–1 of 1\)/, "a file at the root brings nothing: the root's is in the system prompt")
  assert.match(
    app,
    /^\[packages\/AGENTS\.md: the project's instructions for work under packages\/\.[^\n]*\]\nPackages are published; keep exports stable\.\n\n\[packages\/web\/AGENTS\.md: [^\n]*\]\nUse React function components\.\n\npackages\/web\/app\.tsx \(lines 1–1 of 1\)/
  )
  assert.match(util, /^packages\/web\/util\.ts \(lines 1–1 of 1\)/, "given once in a reply")
  assert.ok(
    steps.every((step) => !step.output.includes("AGENTS.md")),
    "the step shows what the tool returned, not the instructions that came with it"
  )
  assert.deepStrictEqual(tools.instructionFiles?.(), ["AGENTS.md", "packages/AGENTS.md", "packages/web/AGENTS.md"])
})

test("a failed call brings no instructions, and a later one under the same folder still does", async () => {
  const root = workspace({ "lib/AGENTS.md": "Pure functions only.", "lib/a.ts": "export const a = 1\n" })
  const { client, requests } = scripted([
    { calls: [read("1", "lib/missing.ts")] },
    { calls: [read("2", "lib/a.ts")] },
    "Done."
  ])
  await drain(withTools(client, workspaceTools(root), { mode: "native" }).chat(ask("Read lib.")))
  const [missing, found] = toolResults(requests[2])
  assert.strictEqual(missing, "lib/missing.ts does not exist.")
  assert.match(found, /^\[lib\/AGENTS\.md: [^\n]*\]\nPure functions only\.\n\nlib\/a\.ts/)
})

test("a folder's instructions outlast the output they came with when the context is short", async () => {
  const body = Array.from({ length: 80 }, (_, i) => `export const value${i} = "${"x".repeat(30)}"`).join("\n")
  const root = workspace({ "src/AGENTS.md": "Never use default exports.", "src/a.ts": body, "src/b.ts": body, "src/c.ts": body })
  const { client, requests } = scripted([
    { calls: [read("1", "src/a.ts")] },
    { calls: [read("2", "src/b.ts")] },
    { calls: [read("3", "src/c.ts")] },
    "Done."
  ])
  await drain(withTools(client, workspaceTools(root), { mode: "native", contextWindow: () => 4096 }).chat(ask("Read.")))
  const [first] = toolResults(requests[3])
  assert.match(first, /^\[src\/AGENTS\.md: [^\n]*\]\nNever use default exports\.\n\nsrc\/a\.ts \(lines 1–80 of 80\)\n\[The rest was trimmed/)
})

test("text mode carries a folder's instructions in the result message too", async () => {
  const root = workspace({ "app/AGENTS.md": "Log with the logger.", "app/main.ts": "console.log(1)\n" })
  const { client, requests } = scripted([
    "```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"app/main.ts\"}}\n```",
    "Done."
  ])
  await drain(withTools(client, workspaceTools(root), { mode: "text" }).chat(ask("Read.")))
  const result = String(requests[1].messages[requests[1].messages.length - 1].content)
  assert.match(result, /^<tool_result name="read_file">\n\[app\/AGENTS\.md: [^\n]*\]\nLog with the logger\.\n\napp\/main\.ts/)
})

test("agent instruction files are protected: a change to one is always reviewed", () => {
  for (const file of ["AGENTS.md", "packages/web/AGENTS.md", "agents.md", "CLAUDE.md", ".github/copilot-instructions.md"]) {
    assert.ok(isProtectedPath(file), file)
  }
  for (const file of ["docs/CLAUDE.md.bak", "src/agents.ts", "README.md", "MY_AGENTS.md"]) {
    assert.ok(!isProtectedPath(file), file)
  }
})

/**
 * One agent reply from end to end, as close to a live window as a test
 * host gets: a typed message goes through the chat, a scripted model
 * reads a file, edits it and runs a command through the real tools, the
 * editor applies the edit, the reply is handed to the webview with its
 * steps, the project's instructions, the errors check and the files it
 * changed, and undo puts the workspace back.
 */
import * as assert from "assert"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import { ACTIVE_CHAT_PROVIDER_STORAGE_KEY, EVENT_NAME, GLOBAL_STORAGE_KEY } from "../../common/constants"
import { ChatCompletionMessage, ReplyChangesView, ToolStepView, TwinnyProvider } from "../../common/types"
import { Chat } from "../../extension/chat/index"
import { GenerationTracker } from "../../extension/generations"
import { ChatRequest, InferenceProvider, providerRegistry } from "../../extension/inference"
import { ExtensionBridge } from "../../extension/messaging/bridge"

/** A model that answers each request with the next scripted reply. */
class ScriptedModel implements InferenceProvider {
  public readonly id = "scripted-agent"
  public requests: ChatRequest[] = []

  constructor(private readonly _replies: string[]) {}

  capabilities() {
    return ["chat" as const]
  }

  async *chat(request: ChatRequest) {
    this.requests.push(structuredClone(request))
    const reply = this._replies.shift() ?? "Done."
    for (let i = 0; i < reply.length; i += 9) yield { content: reply.slice(i, i + 9) }
  }
}

const provider: TwinnyProvider = {
  id: "scripted",
  label: "Scripted",
  modelName: "scripted-model",
  provider: "scripted-agent",
  type: "chat"
}

/** The chat, working in a folder of the test's choosing. */
class ChatIn extends Chat {
  public root = ""
  protected workspaceRoot() {
    return this.root
  }
}

const call = (name: string, args: Record<string, string>) =>
  "```tool\n" + JSON.stringify({ name, arguments: args }) + "\n```"

suite("Agent reply, end to end", function () {
  this.timeout(60000)

  test("an MCP server's tool is asked for first, and Always run keeps the tool, not the call", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-agent-mcp-"))
    const settings = vscode.workspace.getConfiguration("twinny")
    await settings.update(
      "chatToolsMcpServers",
      {
        fake: {
          command: process.execPath,
          args: [path.join(__dirname, "support", "fake-mcp-server.js")],
          env: { ELECTRON_RUN_AS_NODE: "1" }
        }
      },
      vscode.ConfigurationTarget.Global
    )
    const model = new ScriptedModel([
      call("fake__add", { a: "2", b: "3" }),
      call("fake__add", { a: "4", b: "5" }),
      "5 and 9."
    ])
    providerRegistry.register("scripted-agent", { id: "scripted-agent", create: () => model })
    const stored: Record<string, unknown> = {
      [ACTIVE_CHAT_PROVIDER_STORAGE_KEY]: provider,
      [`${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.agentMode}`]: true
    }
    const context = {
      globalState: { get: (key: string) => stored[key], update: async (key: string, value: unknown) => void (stored[key] = value) },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext
    // The bridge answers the chat it belongs to, made just below.
    const chatRef: { current?: ChatIn } = {}
    const asked: string[] = []
    const bridge = {
      emit: (type: string, data: unknown) => {
        if (type !== EVENT_NAME.twinnyToolSteps) return
        const waiting = (data as ToolStepView[]).find((step) => step.status === "waiting")
        if (!waiting || asked.includes(waiting.id)) return
        asked.push(waiting.id)
        assert.strictEqual(waiting.mcpTool, "fake/add")
        setTimeout(() => chatRef.current?.answerToolApproval(waiting.id, true, true), 10)
      }
    } as unknown as ExtensionBridge
    const chat = new ChatIn(new GenerationTracker(), undefined, context, bridge, undefined)
    chatRef.current = chat
    chat.root = root
    try {
      const reply = await chat.completion([{ role: "user", content: "Add twice." } as ChatCompletionMessage])
      assert.strictEqual(reply, "5 and 9.")
      assert.ok(model.requests[0].messages.some((m) => String(m.content).includes("fake__add {a, b, options?, loud?}")))
      assert.match(JSON.stringify(model.requests[1].messages.at(-1)?.content), /5 \(a:number,b:number\)/)
      assert.match(JSON.stringify(model.requests[2].messages.at(-1)?.content), /9 \(a:number,b:number\)/)
      assert.strictEqual(asked.length, 1, "asked once: Always run held for the second call with other arguments")
      assert.deepStrictEqual(stored[`${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.alwaysRunMcpTools}`], ["fake/add"])
    } finally {
      chat.dispose()
      await settings.update("chatToolsMcpServers", undefined, vscode.ConfigurationTarget.Global)
    }
  })

  teardown(async () => {
    providerRegistry.unregister("scripted-agent")
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
  })

  test("reads, edits and runs through the real tools, hands the reply over with what it changed, and undoes it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-agent-e2e-"))
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" })
    git("init", "-q")
    git("config", "user.email", "t@example.com")
    git("config", "user.name", "T")
    fs.mkdirSync(path.join(root, "src"))
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Keep exports named.\n")
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1\n")
    git("add", ".")
    git("commit", "-qm", "first")

    const model = new ScriptedModel([
      call("read_file", { path: "src/a.ts" }),
      call("edit_file", { path: "src/a.ts", find: "export const a = 1", replace: "export const a: string = 2" }),
      call("edit_file", { path: "src/a.ts", find: "export const a: string = 2", replace: "export const a = 2" }),
      call("run_command", { command: "echo made > made.txt" }),
      "I set a to 2 and made made.txt."
    ])
    providerRegistry.register("scripted-agent", { id: "scripted-agent", create: () => model })
    const emitted: { type: string; data: unknown }[] = []
    const bridge = { emit: (type: string, data: unknown) => emitted.push({ type, data }) } as unknown as ExtensionBridge
    const stored: Record<string, unknown> = {
      [ACTIVE_CHAT_PROVIDER_STORAGE_KEY]: provider,
      [`${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.agentMode}`]: true,
      [`${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.autoRunCommands}`]: true
    }
    const context = {
      globalState: { get: (key: string) => stored[key], update: async () => undefined },
      workspaceState: { get: () => undefined, update: async () => undefined },
      storageUri: vscode.Uri.file(path.join(root, ".git", "twinny-storage")),
      subscriptions: []
    } as unknown as vscode.ExtensionContext
    const chat = new ChatIn(new GenerationTracker(), undefined, context, bridge, undefined)
    chat.root = root
    try {
      const reply = await chat.completion([{ role: "user", content: "Make a two, and make a file." } as ChatCompletionMessage])
      assert.strictEqual(reply, "I set a to 2 and made made.txt.")

      // What the model was told and given back.
      const system = String(model.requests[0].messages[0].content)
      assert.match(system, /from AGENTS\.md[\s\S]*Keep exports named\./, "the project's instructions are in the prompt")
      const results = model.requests.map((request) => JSON.stringify(request.messages[request.messages.length - 1].content))
      assert.match(results[1], /1: export const a = 1/, "the file read comes back to the model")
      assert.match(results[2], /Type 'number' is not assignable to type 'string'/, "the error its edit caused comes back with the edit")
      assert.doesNotMatch(results[3], /not assignable/, "and the fix brings none")
      assert.match(results[4], /exit code 0/)

      // What the workspace now holds.
      assert.strictEqual(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8"), "export const a = 2\n")
      assert.strictEqual(fs.readFileSync(path.join(root, "made.txt"), "utf8"), "made\n")

      // What the webview was handed.
      const steps = emitted.filter((e) => e.type === EVENT_NAME.twinnyToolSteps).pop()?.data as ToolStepView[]
      assert.deepStrictEqual(
        steps.map((s) => [s.name, s.status]),
        [
          ["read_file", "done"],
          ["edit_file", "done"],
          ["edit_file", "done"],
          ["run_command", "done"]
        ]
      )
      assert.match(steps[1].summary, /· 1 new error$/)
      const added = emitted.filter((e) => e.type === EVENT_NAME.twinnyAddMessage).pop()?.data as ChatCompletionMessage
      assert.strictEqual(added.content, "I set a to 2 and made made.txt.")
      assert.deepStrictEqual(added.meta?.instructions, ["AGENTS.md"])
      assert.match(added.toolNotes ?? "", /run_command/)
      const changes = added.changes as ReplyChangesView
      assert.deepStrictEqual(
        changes.files.map((f) => [f.path, f.status, f.added, f.removed]),
        [
          ["made.txt", "created", 1, 0],
          ["src/a.ts", "modified", 1, 1]
        ]
      )

      // And the way back.
      const undone = await chat.undoChanges(changes.id)
      assert.strictEqual(undone.error, undefined)
      assert.strictEqual(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8"), "export const a = 1\n")
      assert.ok(!fs.existsSync(path.join(root, "made.txt")))
      assert.ok(undone.view?.files.every((f) => f.undone))
    } finally {
      chat.dispose()
    }
  })
})

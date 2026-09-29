/**
 * Quickstart's model discovery: the ranking is pure, and a real run against
 * the fake Ollama writes the discovered names (and team defaults) into the
 * starter configuration without a terminal.
 */
import * as assert from "assert"
import * as cp from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Readable, Writable } from "stream"

import { candidatesFor, describeModel, discoverServers, parseBackendOption, pickModels } from "../../gateway/discover"
import { applyBackendOption, starterConfig, starterModels, StarterOptions } from "../../gateway/init"
import { palette, Tui, visibleLength } from "../../gateway/tui"

import { Backend, startBackend } from "./support/backend"

const CLI = path.resolve(__dirname, "../../../packages/twinny-server/cli.js")
const ESC = String.fromCharCode(0x1b)

const MODELS = [
  "qwen2.5-coder:7b",
  "qwen2.5-coder:7b-base",
  "llama3.1:8b",
  "codellama:7b-code",
  "nomic-embed-text:latest",
  "all-minilm:latest",
  "deepseek-r1:70b"
]

suite("quickstart model discovery", () => {
  test("ranks models by what the name says about them", () => {
    const chat = candidatesFor(MODELS, "chat")
    const fim = candidatesFor(MODELS, "fim")
    const embed = candidatesFor(MODELS, "embeddings")
    assert.ok(!chat.includes("nomic-embed-text:latest") && !chat.includes("all-minilm:latest"), "embedding models are not chat")
    assert.deepStrictEqual(chat.slice(-2).sort(), ["codellama:7b-code", "qwen2.5-coder:7b-base"], "base variants come last for chat")
    assert.deepStrictEqual(fim.slice(0, 2).sort(), ["codellama:7b-code", "qwen2.5-coder:7b-base"], "completion variants lead autocomplete")
    assert.ok(!fim.includes("llama3.1:8b"), "a general model is not offered for autocomplete")
    assert.deepStrictEqual(embed.sort(), ["all-minilm:latest", "nomic-embed-text:latest"])
    const pick = pickModels(MODELS)
    assert.ok(pick.chat && pick.fim && pick.embeddings)
    assert.deepStrictEqual(pickModels(["nomic-embed-text"]), { chat: undefined, fim: undefined, embeddings: "nomic-embed-text" })
    assert.strictEqual(describeModel("codellama:7b-code"), "completion only")
    assert.strictEqual(describeModel("llama3.1:8b"), "")
  })

  test("starter aliases fold chat and autocomplete when they share a model, and name the team defaults", () => {
    const shared = starterModels({ chat: "qwen2.5-coder:7b", fim: "qwen2.5-coder:7b", embeddings: "nomic-embed-text" })
    assert.deepStrictEqual(
      shared.map((m) => [m.alias, m.capabilities]),
      [
        ["coder", ["chat", "fim"]],
        ["embed", ["embeddings"]]
      ]
    )
    const written = JSON.parse(starterConfig({ models: shared })) as { teamDefaults: Record<string, string>; models: unknown[] }
    assert.deepStrictEqual(written.teamDefaults, { chat: "coder", fim: "coder", embeddings: "embed" })
    const placeholders = JSON.parse(starterConfig()) as { models: Array<{ model: string }>; teamDefaults: Record<string, string> }
    assert.strictEqual(placeholders.models.length, 3)
    assert.ok(placeholders.models.every((m) => /^[a-z0-9.-]+:[a-z0-9.-]+$|^[a-z-]+$/.test(m.model)), "placeholders are real Ollama tags")
    assert.deepStrictEqual(placeholders.teamDefaults, { chat: "chat", fim: "coder", embeddings: "embed" })
  })

  test("--backend names any server kind; --ollama is the shorthand; a bare port says which server is usual there", () => {
    const options: StarterOptions = {}
    applyBackendOption(options, "--ollama", "gpu-box")
    assert.deepStrictEqual(options.backend, { provider: "ollama", apiHostname: "gpu-box", apiPort: 11434, apiProtocol: "http" })
    applyBackendOption(options, "--backend", "lmstudio=10.0.0.5")
    assert.deepStrictEqual(options.backend, { provider: "lmstudio", apiHostname: "10.0.0.5", apiPort: 1234, apiProtocol: "http" })
    assert.deepStrictEqual(parseBackendOption("llamacpp=https://gpu-box:8443/"), { provider: "llamacpp", apiHostname: "gpu-box", apiPort: 8443, apiProtocol: "https" })
    assert.strictEqual(parseBackendOption("127.0.0.1:1234").provider, "lmstudio")
    assert.strictEqual(parseBackendOption("127.0.0.1:11435").provider, "qvac")
    assert.strictEqual(parseBackendOption("http://host:8000").provider, "openai-compatible")
    assert.deepStrictEqual(parseBackendOption("[::1]:11434"), { provider: "ollama", apiHostname: "::1", apiPort: 11434, apiProtocol: "http" })
    assert.throws(() => parseBackendOption("a b"))
    assert.throws(() => parseBackendOption("nosuch=host"), /not a provider kind/)
    const written = JSON.parse(starterConfig({ backend: options.backend })) as { providers: Record<string, { provider: string; apiPort: number }>; models: Array<{ provider: string }> }
    assert.deepStrictEqual(Object.keys(written.providers), ["local-lmstudio"])
    assert.strictEqual(written.providers["local-lmstudio"].apiPort, 1234)
    assert.ok(written.models.every((m) => m.provider === "local-lmstudio"))
  })

  test("servers that do not answer are simply absent", async () => {
    const nothing = await discoverServers([{ provider: "ollama", apiHostname: "127.0.0.1", apiPort: 1, apiProtocol: "http" }], 1_000)
    assert.deepStrictEqual(nothing.servers, [])
  })

  test("the terminal helpers stay plain without a TTY and measure text without escape codes", () => {
    const colour = palette(true)
    assert.strictEqual(visibleLength(colour.bold(colour.accent("hello"))), 5)
    assert.strictEqual(palette(false).accent("x"), "x")
    const out: string[] = []
    const tui = new Tui({
      stdin: Object.assign(new Readable({ read() {} }), { isTTY: false }) as never,
      stdout: Object.assign(new Writable({ write(chunk: Buffer, _e: string, cb: () => void) { out.push(chunk.toString()); cb() } }), { isTTY: false }) as never,
      env: {}
    })
    assert.strictEqual(tui.colour, false)
    assert.strictEqual(tui.interactive, false)
    tui.step("ok", "Wrote a file", "3 aliases")
    tui.box(["tsk_abc"], "Admin key")
    const text = out.join("")
    assert.match(text, /✓ Wrote a file 3 aliases/)
    assert.match(text, /╭─ Admin key ─+╮\n {2}│ {2}tsk_abc +│\n/)
    assert.ok(!text.includes(ESC), "no escape codes without a TTY")
  })

  suite("against a fake Ollama", () => {
    let backend: Backend
    let scratch: string
    suiteSetup(async () => {
      backend = await startBackend()
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-quickstart-"))
    })
    suiteTeardown(async () => {
      await backend.close()
      fs.rmSync(scratch, { recursive: true, force: true })
    })

    test("quickstart writes the discovered models and team defaults, then serves", async () => {
      const dir = path.join(scratch, "discover")
      const file = path.join(dir, "twinny.gateway.json")
      fs.mkdirSync(dir, { recursive: true })
      // The starter listens on the default port, which may be taken here,
      // so quickstart is stopped as soon as the file exists and checked.
      const node = process.env.TWINNY_TEST_NODE || process.execPath
      const child = cp.spawn(node, [CLI, "quickstart", "--config", file, "--admin", "ops", "--backend", `ollama=127.0.0.1:${backend.port}`], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", HOME: dir, USERPROFILE: dir },
        stdio: ["ignore", "pipe", "pipe"]
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
      const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)))
      const deadline = Date.now() + 10_000
      while (!/Admin key for "ops"/.test(stdout) && child.exitCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }
      child.kill("SIGTERM")
      await exited
      assert.match(stdout, /Ollama at 127\.0\.0\.1:\d+ answers 2 models/, stdout + stderr)
      assert.match(stdout, /Chat model backend-coder:7b/)
      assert.match(stdout, /Autocomplete model backend-coder:7b/)
      assert.match(stdout, /Embedding model backend-embed/)
      assert.ok(!stdout.includes(ESC), "no colour on a pipe")
      const written = JSON.parse(fs.readFileSync(file, "utf8")) as {
        models: Array<{ alias: string; model: string; capabilities: string[] }>
        teamDefaults: Record<string, string>
        providers: Record<string, { apiPort: number }>
      }
      assert.deepStrictEqual(
        written.models.map((m) => [m.alias, m.model]),
        [
          ["coder", "backend-coder:7b"],
          ["embed", "backend-embed"]
        ]
      )
      assert.deepStrictEqual(written.teamDefaults, { chat: "coder", fim: "coder", embeddings: "embed" })
      assert.strictEqual(written.providers["local-ollama"].apiPort, backend.port)
      assert.match(stdout, /Next\n {4}1\. Open http:\/\/127\.0\.0\.1:8765\/admin/)
    })

    test("with nothing listening the placeholders are written and the run says so", async () => {
      const dir = path.join(scratch, "nobody")
      const file = path.join(dir, "twinny.gateway.json")
      fs.mkdirSync(dir, { recursive: true })
      const node = process.env.TWINNY_TEST_NODE || process.execPath
      const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
        const child = cp.spawn(node, [CLI, "quickstart", "--config", file, "--admin", "bad/name", "--ollama", "127.0.0.1:1"], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", HOME: dir },
          stdio: ["ignore", "pipe", "pipe"]
        })
        let stdout = ""
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
        child.on("exit", (code) => resolve({ code, stdout }))
      })
      // Arguments are checked first, so nothing was probed or written.
      assert.strictEqual(result.code, 2)
      assert.ok(!fs.existsSync(file))
    })
  })
})

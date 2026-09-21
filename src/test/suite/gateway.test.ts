/**
 * The gateway as a process: the built CLI spawned outside VS Code, talked
 * to through the extension's own remote provider, with a fake Ollama
 * behind it. Nothing here needs a model, a GPU or the network.
 */
import * as assert from "assert"
import * as cp from "child_process"
import * as fs from "fs"
import * as http from "http"
import { AddressInfo } from "net"
import * as os from "os"
import * as path from "path"

import { API_PROVIDERS } from "../../common/constants"
import { TwinnyProvider } from "../../common/types"
import {
  FimRequest,
  InferenceError,
  isInferenceError,
  readText,
  resolveInferenceProvider
} from "../../extension/inference"
import { ConfigurationSnapshot } from "../../gateway/configuration"
import { KeyStore } from "../../gateway/keys"

import { Backend, STALL,startBackend } from "./support/backend"

const CLI = path.resolve(__dirname, "../../../packages/twinny-server/cli.js")
const TOKEN = "tok-SECRETMARKER-4f1c"
const PROMPT_MARKER = "PROMPTMARKER-9a7e"
const CHAT_MARKER = "CHATMARKER-c33d"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/* -------------------------------------------------------------------------- */
/*  The real CLI                                                              */
/* -------------------------------------------------------------------------- */

interface Gateway {
  port: number
  url: string
  process: cp.ChildProcess
  stdout: string
  stderr: string
  /** Resolves with the exit code once the process has ended. */
  exited: Promise<number | null>
  stop(): Promise<number | null>
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-gateway-test-"))

const writeConfig = (name: string, config: unknown): string => {
  const file = path.join(scratch, `${name}.json`)
  fs.writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config, null, 2))
  return file
}

/** Keys and usage for a test live under the scratch directory, never in the home directory. */
const dataDirFor = (name: string) => path.join(scratch, "data", name)

const configFor = (backendPort: number, extra: Record<string, unknown> = {}, data = "main") => ({
  listen: { host: "127.0.0.1", port: 0 },
  auth: {
    tokenEnv: "TWINNY_GATEWAY_TOKEN",
    keysFile: path.join(dataDirFor(data), "keys.json"),
    licenseFile: path.join(dataDirFor(data), "license")
  },
  usage: { dir: path.join(dataDirFor(data), "usage"), retentionDays: 30 },
  providers: {
    local: { provider: "ollama", apiHostname: "127.0.0.1", apiPort: backendPort }
  },
  models: [
    { alias: "coder", provider: "local", model: "backend-coder:7b", capabilities: ["fim", "chat"] },
    { alias: "embed", provider: "local", model: "backend-embed", capabilities: ["embeddings"] }
  ],
  ...extra
})

/** Spawns `twinny-node serve` with the test host's own binary running as Node. */
const spawnCli = (args: string[], env: Record<string, string | undefined>) => {
  const node = process.env.TWINNY_TEST_NODE || process.execPath
  const merged: Record<string, string | undefined> = { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...env }
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
  return cp.spawn(node, [CLI, ...args], {
    env: merged as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"]
  })
}

const startGateway = (configFile: string, env: Record<string, string | undefined> = {}): Promise<Gateway> =>
  new Promise((resolve, reject) => {
    const child = spawnCli(["serve", "--config", configFile], { TWINNY_GATEWAY_TOKEN: TOKEN, ...env })
    const gateway: Gateway = {
      port: 0,
      url: "",
      process: child,
      stdout: "",
      stderr: "",
      exited: new Promise((done) => child.on("exit", (code) => done(code))),
      stop: async () => {
        if (child.exitCode === null) child.kill("SIGTERM")
        return gateway.exited
      }
    }
    let ready = false
    child.stdout?.on("data", (chunk: Buffer) => {
      gateway.stdout += chunk.toString()
      const match = /listening on (http:\/\/127\.0\.0\.1:(\d+))/.exec(gateway.stdout)
      // The banner is several lines; tests read all of it, so wait for the last.
      if (match && /^ {2}usage: /m.test(gateway.stdout) && !ready) {
        ready = true
        gateway.url = match[1]
        gateway.port = Number(match[2])
        resolve(gateway)
      }
    })
    child.stderr?.on("data", (chunk: Buffer) => (gateway.stderr += chunk.toString()))
    child.on("exit", (code) => {
      if (!ready) reject(new Error(`gateway exited with ${code} before listening:\n${gateway.stderr}`))
    })
  })

/** Runs the CLI to completion, for startup failures. */
const runCli = (
  args: string[],
  env: Record<string, string | undefined> = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawnCli(args, env)
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    child.on("exit", (code) => resolve({ code, stdout, stderr }))
  })

const remoteProvider = (gateway: Gateway, extra: Partial<TwinnyProvider> = {}): TwinnyProvider => ({
  id: "gw",
  label: "Gateway",
  modelName: "coder",
  provider: API_PROVIDERS.TwinnyRemote,
  type: "fim",
  apiHostname: "127.0.0.1",
  apiPort: gateway.port,
  apiProtocol: "http",
  apiPath: "",
  apiKey: TOKEN,
  ...extra
})

const fimRequest = (prompt = `def add(a, b): ${PROMPT_MARKER}`): FimRequest => ({
  model: "coder",
  prompt,
  maxTokens: 8,
  temperature: 0
})

const expectKind = async (run: () => Promise<unknown>, kind: string): Promise<InferenceError> => {
  try {
    await run()
  } catch (error) {
    assert.ok(isInferenceError(error), `expected an InferenceError, got ${String(error)}`)
    assert.strictEqual(error.kind, kind, error.message)
    return error
  }
  assert.fail(`expected a ${kind} error`)
}

const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await wait(25)
  assert.ok(check(), "condition not met in time")
}

/* -------------------------------------------------------------------------- */

suite("Gateway process", function () {
  this.timeout(30_000)

  let backend: Backend
  let gateway: Gateway

  suiteSetup(async () => {
    assert.ok(fs.existsSync(CLI), `built CLI missing at ${CLI}; run npm run build`)
    backend = await startBackend()
    gateway = await startGateway(writeConfig("main", configFor(backend.port)))
  })

  suiteTeardown(async () => {
    await gateway.stop()
    await backend.close()
  })

  setup(() => {
    backend.requests.length = 0
  })

  test("starts standalone and says where it listens, without secrets", () => {
    assert.match(gateway.stdout, /Twinny gateway \S+ listening on http:\/\/127\.0\.0\.1:\d+/)
    assert.match(gateway.stdout, /protocol: twinny\/v1/)
    assert.match(gateway.stdout, /models: {3}2 aliases/)
    assert.ok(!gateway.stdout.includes(TOKEN))
    assert.ok(!gateway.stderr.includes(TOKEN))
  })

  test("malformed HTTP and upgrade URLs are refused without crashing the gateway", async () => {
    for (const upgrade of [false, true]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = http.request({
          hostname: "127.0.0.1",
          port: gateway.port,
          path: "//[",
          headers: upgrade ? { Connection: "Upgrade", Upgrade: "websocket" } : {}
        }, (res) => {
          res.resume()
          res.on("end", () => resolve(res.statusCode))
        })
        req.on("error", reject)
        req.end()
      })
      assert.strictEqual(status, 400)
      assert.strictEqual((await fetch(`${gateway.url}/healthz`)).status, 200)
    }
  })

  test("the health route says only that the listener is up", async () => {
    const response = await fetch(`${gateway.url}/healthz`)
    assert.strictEqual(response.status, 200)
    const text = await response.text()
    assert.deepStrictEqual(JSON.parse(text), { status: "ok" })
    assert.ok(!text.includes("coder") && !text.includes(String(backend.port)))
  })

  test("discovery lists the configured aliases, their capabilities and the backend model behind each", async () => {
    const models = await resolveInferenceProvider(remoteProvider(gateway)).models()
    assert.deepStrictEqual(
      models.map((m) => [m.id, m.capabilities, m.model]),
      [
        ["coder", ["fim", "chat"], "backend-coder:7b"],
        ["embed", ["embeddings"], "backend-embed"]
      ]
    )
    assert.strictEqual(backend.requests.length, 0, "discovery never touches the backend")
  })

  test("FIM streams incrementally and reaches the mapped backend model", async () => {
    const client = resolveInferenceProvider(remoteProvider(gateway))
    const chunks: string[] = []
    let usage
    for await (const chunk of client.fim(fimRequest())) {
      if (chunk.text) chunks.push(chunk.text)
      if (chunk.usage) usage = chunk.usage
    }
    assert.deepStrictEqual(chunks, ["def", " add"])
    assert.deepStrictEqual(usage, { promptTokens: 12, completionTokens: 2 })
    assert.strictEqual(backend.requests[0].path, "/api/generate")
    assert.strictEqual(backend.requests[0].model, "backend-coder:7b")
  })

  test("chat streams through the same alias", async () => {
    const client = resolveInferenceProvider(remoteProvider(gateway, { type: "chat" }))
    const text = await readText(
      client.chat({ model: "coder", messages: [{ role: "user", content: `hi ${CHAT_MARKER}` }] })
    )
    assert.strictEqual(text, "Hello there")
    assert.strictEqual(backend.requests[0].path, "/v1/chat/completions")
    assert.strictEqual(backend.requests[0].model, "backend-coder:7b")
  })

  test("embeddings answer through the embedding alias", async () => {
    const client = resolveInferenceProvider(remoteProvider(gateway, { type: "embedding" }))
    const { vectors } = await client.embeddings({ model: "embed", input: ["a", "b"] })
    assert.strictEqual(vectors.length, 2)
    assert.strictEqual(backend.requests[0].path, "/api/embed")
    assert.strictEqual(backend.requests[0].model, "backend-embed")
  })

  test("missing and wrong tokens are refused before any provider work", async () => {
    for (const apiKey of ["", "wrong-token"]) {
      const client = resolveInferenceProvider(remoteProvider(gateway, { apiKey }))
      const listing = await expectKind(() => client.models(), "authentication")
      assert.strictEqual(listing.status, 401)
      const inference = await expectKind(() => readText(client.fim(fimRequest())), "authentication")
      assert.ok(!inference.message.includes(TOKEN))
      await expectKind(
        () => client.embeddings({ model: "embed", input: "x" }),
        "authentication"
      )
    }
    assert.strictEqual(backend.requests.length, 0)
  })

  test("unknown aliases, forbidden capabilities and injected settings fail predictably", async () => {
    const client = resolveInferenceProvider(remoteProvider(gateway))
    const unknown = await expectKind(
      () => readText(client.fim({ ...fimRequest(), model: "ghost" })),
      "model-unavailable"
    )
    assert.strictEqual(unknown.status, 404)
    await expectKind(() => readText(client.fim({ ...fimRequest(), model: "embed" })), "unsupported-capability")
    await expectKind(() => client.embeddings({ model: "coder", input: "x" }), "unsupported-capability")

    const response = await fetch(`${gateway.url}/twinny/v1/fim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: "coder", prompt: "p", apiHostname: "attacker", apiKey: "x" })
    })
    assert.strictEqual(response.status, 400)
    const body = (await response.json()) as { error: { kind: string; message: string } }
    assert.strictEqual(body.error.kind, "inference-failure")
    assert.match(body.error.message, /unknown fields "apiHostname", "apiKey"/)
    assert.strictEqual(backend.requests.length, 0, "none of these may reach the backend")
  })

  test("nothing a request carried, and no token, reaches the logs", async () => {
    await wait(100)
    const output = gateway.stdout + gateway.stderr
    assert.ok(!output.includes(TOKEN), "token in gateway output")
    assert.ok(!output.includes(PROMPT_MARKER), "prompt in gateway output")
    assert.ok(!output.includes(CHAT_MARKER), "chat content in gateway output")
    assert.match(gateway.stderr, /event=request .*route=fim .*alias=coder .*outcome=ok/)
    assert.match(gateway.stderr, /event=auth\.rejected/)
  })
})

suite("Gateway process: capacity, deadline, shutdown", function () {
  this.timeout(30_000)

  let backend: Backend

  suiteSetup(async () => {
    backend = await startBackend()
  })

  suiteTeardown(() => backend.close())

  setup(() => {
    backend.requests.length = 0
  })

  test("capacity one: a second request waits for the slot, a third finds the queue full, cancelling the first admits the waiter", async () => {
    const gateway = await startGateway(
      writeConfig(
        "capacity",
        configFor(backend.port, {
          limits: { maxActiveRequests: 1, queue: { maxWaiting: 1, fimWaitMs: 5_000, chatWaitMs: 5_000 } }
        })
      )
    )
    try {
      const client = resolveInferenceProvider(remoteProvider(gateway))
      const controller = new AbortController()
      const first = client.fim(fimRequest(STALL), { signal: controller.signal })
      const iterator = first[Symbol.asyncIterator]()
      const head = await iterator.next()
      assert.strictEqual((head.value as { text: string }).text, "def")

      // The second request waits in the queue: nothing reaches the backend.
      const second = readText(client.fim(fimRequest()))
      await wait(300)
      assert.strictEqual(backend.requests.length, 1, "the waiting request never reached the backend")

      // The queue holds one; a third is refused at once and told what is waiting.
      const refused = await expectKind(() => readText(client.fim(fimRequest())), "rate-limited")
      assert.strictEqual(refused.status, 429)
      assert.match(refused.message, /1 request\(s\) already running and 1 waiting/)
      await until(() => /event=request\.refused .*kind=rate-limited active=1 waiting=1 reason=gateway/.test(gateway.stderr))

      const embed = resolveInferenceProvider(remoteProvider(gateway, { type: "embedding" }))
      const { vectors } = await embed.embeddings({ model: "embed", input: ["a"] })
      assert.strictEqual(vectors.length, 1, "embeddings are not counted against the cap")

      controller.abort()
      await expectKind(() => iterator.next(), "cancelled")
      await until(() => backend.requests[0].cancelled)

      // The freed slot goes straight to the waiter.
      assert.strictEqual(await second, "def add")
      await until(() => /event=request .*outcome=ok .*waited=\d+/.test(gateway.stderr))
      const after = await readText(client.fim(fimRequest()))
      assert.strictEqual(after, "def add")
    } finally {
      await gateway.stop()
    }
  })

  test("a waiting request is refused once the route's wait runs out", async () => {
    const gateway = await startGateway(
      writeConfig(
        "queue-wait",
        configFor(backend.port, {
          limits: { maxActiveRequests: 1, queue: { maxWaiting: 4, fimWaitMs: 200, chatWaitMs: 200 } }
        })
      )
    )
    try {
      const client = resolveInferenceProvider(remoteProvider(gateway))
      const controller = new AbortController()
      const iterator = client.fim(fimRequest(STALL), { signal: controller.signal })[Symbol.asyncIterator]()
      await iterator.next()

      const started = Date.now()
      const refused = await expectKind(() => readText(client.fim(fimRequest())), "rate-limited")
      assert.ok(Date.now() - started >= 180, "the refusal came after the wait")
      assert.strictEqual(refused.status, 429)
      assert.match(refused.message, /waited 200 ms for a free slot/)
      assert.strictEqual(backend.requests.length, 1)
      await until(() => /event=request\.refused .*waited=\d+ reason=queue/.test(gateway.stderr))

      controller.abort()
      await expectKind(() => iterator.next(), "cancelled")
    } finally {
      await gateway.stop()
    }
  })

  test("a client that gives up while waiting leaves the queue; queue off refuses at once", async () => {
    const gateway = await startGateway(
      writeConfig(
        "queue-leave",
        configFor(backend.port, {
          limits: { maxActiveRequests: 1, queue: { maxWaiting: 1, fimWaitMs: 5_000, chatWaitMs: 5_000 } }
        })
      )
    )
    try {
      const client = resolveInferenceProvider(remoteProvider(gateway))
      const first = new AbortController()
      const iterator = client.fim(fimRequest(STALL), { signal: first.signal })[Symbol.asyncIterator]()
      await iterator.next()

      const second = new AbortController()
      const waiting = readText(client.fim(fimRequest(), { signal: second.signal }))
      await wait(150)
      second.abort()
      await expectKind(() => waiting, "cancelled")
      await until(() => /event=request\.abandoned .*waited=\d+/.test(gateway.stderr))

      // Its place is free again: a third request waits instead of being refused.
      const third = readText(client.fim(fimRequest()))
      await wait(150)
      assert.strictEqual(backend.requests.length, 1)
      first.abort()
      await expectKind(() => iterator.next(), "cancelled")
      assert.strictEqual(await third, "def add")
    } finally {
      await gateway.stop()
    }

    const off = await startGateway(
      writeConfig("queue-off", configFor(backend.port, { limits: { maxActiveRequests: 1, queue: { maxWaiting: 0 } } }))
    )
    try {
      assert.match(off.stdout, /limits: {3}1 active, no queue/)
      const client = resolveInferenceProvider(remoteProvider(off))
      const controller = new AbortController()
      const iterator = client.fim(fimRequest(STALL), { signal: controller.signal })[Symbol.asyncIterator]()
      await iterator.next()
      const started = Date.now()
      const refused = await expectKind(() => readText(client.fim(fimRequest())), "rate-limited")
      assert.ok(Date.now() - started < 1_000)
      assert.match(refused.message, /already running\. Try again shortly/)
      controller.abort()
      await expectKind(() => iterator.next(), "cancelled")
    } finally {
      await off.stop()
    }
  })

  test("the deadline aborts the backend, reports a timeout, and releases capacity", async () => {
    const gateway = await startGateway(
      writeConfig(
        "deadline",
        configFor(backend.port, { limits: { maxActiveRequests: 1, requestDeadlineMs: 400 } })
      )
    )
    try {
      const client = resolveInferenceProvider(remoteProvider(gateway))
      const started = Date.now()
      const failure = await expectKind(() => readText(client.fim(fimRequest(STALL))), "timeout")
      assert.match(failure.message, /deadline/)
      assert.ok(Date.now() - started < 5_000)
      await until(() => backend.requests[0].cancelled)
      assert.strictEqual(await readText(client.fim(fimRequest())), "def add")
      assert.match(gateway.stderr, /outcome=error kind=timeout/)
    } finally {
      await gateway.stop()
    }
  })

  test("a backend error releases capacity", async () => {
    const dead = await startBackend()
    await dead.close()
    const gateway = await startGateway(
      writeConfig("errors", configFor(dead.port, { limits: { maxActiveRequests: 1 } }))
    )
    try {
      const client = resolveInferenceProvider(remoteProvider(gateway))
      await expectKind(() => readText(client.fim(fimRequest())), "provider-unavailable")
      await expectKind(() => readText(client.fim(fimRequest())), "provider-unavailable")
      assert.match(gateway.stderr, /kind=provider-unavailable/)
    } finally {
      await gateway.stop()
    }
  })

  test("SIGTERM with a stalled request cancels it and exits within the grace", async () => {
    const gateway = await startGateway(
      writeConfig("shutdown", configFor(backend.port, { limits: { shutdownGraceMs: 500 } }))
    )
    const client = resolveInferenceProvider(remoteProvider(gateway))
    const stream = client.fim(fimRequest(STALL))
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()

    const started = Date.now()
    gateway.process.kill("SIGTERM")
    const outcome = await expectKind(() => iterator.next(), "cancelled")
    assert.match(outcome.message, /shutting down/)
    const code = await gateway.exited
    assert.ok(Date.now() - started < 4_000, "shutdown took too long")
    assert.strictEqual(code, 0)
    await until(() => backend.requests[0].cancelled)
    assert.match(gateway.stderr, /event=gateway\.stopping/)
    assert.match(gateway.stderr, /event=gateway\.stopped/)
    await expectKind(
      () => resolveInferenceProvider(remoteProvider(gateway)).models(),
      "provider-unavailable"
    )
  })
})

suite("Gateway process: startup failures", function () {
  this.timeout(30_000)

  test("--help prints usage and exits 0", async () => {
    const result = await runCli(["serve", "--help"])
    assert.strictEqual(result.code, 0)
    assert.match(result.stdout, /twinny-server serve --config/)
    const top = await runCli(["--help"])
    assert.strictEqual(top.code, 0)
    assert.match(top.stdout, /npx twinny-server quickstart/)
    const version = await runCli(["--version"])
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/)
  })

  test("a data directory written by a newer server stops startup with exit 6; a fresh one is marked", async () => {
    const newer = dataDirFor("newer")
    fs.mkdirSync(newer, { recursive: true })
    fs.writeFileSync(path.join(newer, "format.json"), JSON.stringify({ format: 99, server: "9.0.0" }))
    const result = await runCli(["serve", "--config", writeConfig("newer", configFor(11434, {}, "newer"))], {
      TWINNY_GATEWAY_TOKEN: TOKEN
    })
    assert.strictEqual(result.code, 6)
    assert.match(result.stderr, /data-format.*newer twinny-server \(data format 99, version 9\.0\.0; this version reads format 1\)/)

    const gateway = await startGateway(writeConfig("fresh", configFor(11434, {}, "fresh")))
    try {
      assert.match(gateway.stdout, /data: {5}.*\(format 1\)/)
      const marker = JSON.parse(fs.readFileSync(path.join(dataDirFor("fresh"), "format.json"), "utf8")) as { format: number; server: string }
      assert.strictEqual(marker.format, 1)
      assert.match(marker.server, /^\d+\.\d+\.\d+$/)
    } finally {
      await gateway.stop()
    }
  })

  test("init writes a starter config that serve accepts, and never overwrites", async () => {
    const file = path.join(scratch, "init", "twinny.gateway.json")
    const first = await runCli(["init", file])
    assert.strictEqual(first.code, 0, first.stderr)
    assert.match(first.stdout, /twinny-server serve --config/)
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { models: unknown[] }
    assert.ok(parsed.models.length >= 1)
    const again = await runCli(["init", file])
    assert.strictEqual(again.code, 2)
    assert.match(again.stderr, /already exists/)
    // Valid as far as the loader is concerned; only the backend is missing.
    // The default port may be taken on this machine, so let the OS pick.
    fs.writeFileSync(file, JSON.stringify({ ...parsed, listen: { host: "127.0.0.1", port: 0 } }))
    const gateway = await startGateway(file, { TWINNY_GATEWAY_TOKEN: TOKEN })
    assert.match(gateway.stdout, /models: {3}3 aliases/)
    await gateway.stop()
  })

  test("quickstart makes an admin key once and serves; reset removes the files", async () => {
    // Keys and usage live under the scratch directory, so the data paths are
    // written into the configuration before quickstart starts from it.
    const file = path.join(scratch, "quickstart", "twinny.gateway.json")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(configFor(11434, {}, "quickstart")))
    const keysFile = path.join(dataDirFor("quickstart"), "keys.json")

    const first = await new Promise<Gateway>((resolve) => {
      const child = spawnCli(["quickstart", "--config", file, "--admin", "ops"], { TWINNY_GATEWAY_TOKEN: undefined })
      const gateway: Gateway = {
        port: 0,
        url: "",
        process: child,
        stdout: "",
        stderr: "",
        exited: new Promise((done) => child.on("exit", (code) => done(code))),
        stop: async () => {
          if (child.exitCode === null) child.kill("SIGTERM")
          return gateway.exited
        }
      }
      child.stderr?.on("data", (chunk: Buffer) => (gateway.stderr += chunk.toString()))
      child.stdout?.on("data", (chunk: Buffer) => {
        gateway.stdout += chunk.toString()
        if (/^ {2}usage: /m.test(gateway.stdout)) resolve(gateway)
      })
    })
    await first.stop()
    const key = /(tsk_[0-9a-f]{8}_[0-9a-f]{64})/.exec(first.stdout)?.[1]
    assert.ok(key, first.stdout)
    assert.match(first.stdout, /Admin key for "ops"/)
    assert.match(first.stdout, /admin: {4}http:\/\/127\.0\.0\.1:\d+\/admin/)
    assert.match(first.stdout, /access: {3}1 active key/)
    const store = KeyStore.open(keysFile)
    assert.deepStrictEqual(store.active().map((k) => [k.name, k.admin]), [["ops", true]])
    assert.ok(store.verify(key))

    // A second run keeps the key and says so, rather than minting another.
    const again = await runCli(["quickstart", "--config", file, "--help"])
    assert.strictEqual(again.code, 0)
    assert.match(again.stdout, /--fresh/)

    const dry = await runCli(["reset", "--config", file])
    assert.strictEqual(dry.code, 2)
    assert.match(dry.stdout, /Would remove:/)
    assert.ok(fs.existsSync(keysFile), "a dry run removes nothing")

    const wiped = await runCli(["reset", "--config", file, "--yes", "--all"])
    assert.strictEqual(wiped.code, 0, wiped.stderr)
    assert.match(wiped.stdout, /Removed keys:/)
    assert.match(wiped.stdout, /Removed configuration:/)
    assert.ok(!fs.existsSync(keysFile))
    assert.ok(!fs.existsSync(file))

    // With nothing on disk, quickstart writes the starter and a fresh key.
    // The starter listens on the default port, which may be taken here, so
    // only the preparation is checked: a bad --admin name stops before serving.
    const bad = await runCli(["quickstart", "--config", file, "--admin", "bad/name"])
    assert.strictEqual(bad.code, 2)
    assert.match(bad.stderr, /not a valid key name/)
    assert.ok(!fs.existsSync(file), "arguments are checked before anything is written")
  })

  test("a malformed configuration is refused with exit 2", async () => {
    const file = writeConfig("malformed", "{ not json")
    const result = await runCli(["serve", "--config", file], { TWINNY_GATEWAY_TOKEN: TOKEN })
    assert.strictEqual(result.code, 2)
    assert.match(result.stderr, /not valid JSON/)

    const invalid = writeConfig("invalid", {
      providers: { local: { provider: "ollama" } },
      models: [
        { alias: "a", provider: "local", model: "m", capabilities: ["fim"] },
        { alias: "a", provider: "nowhere", model: "m", capabilities: ["nope"] }
      ]
    })
    const second = await runCli(["serve", "--config", invalid], { TWINNY_GATEWAY_TOKEN: TOKEN })
    assert.strictEqual(second.code, 2)
    assert.match(second.stderr, /already used/)
    assert.match(second.stderr, /"nowhere" is not in providers/)
  })

  test("no shared token and no keys is exit 3 and says how to get in", async () => {
    const file = writeConfig("no-token", configFor(11434, {}, "no-token"))
    const result = await runCli(["serve", "--config", file], { TWINNY_GATEWAY_TOKEN: undefined })
    assert.strictEqual(result.code, 3)
    assert.match(result.stderr, /TWINNY_GATEWAY_TOKEN/)
    assert.match(result.stderr, /keys create/)
  })

  test("an unsupported provider kind is exit 4", async () => {
    const file = writeConfig("unsupported", {
      providers: { local: { provider: "twinny-p2p" } },
      models: [{ alias: "a", provider: "local", model: "m", capabilities: ["fim"] }]
    })
    const result = await runCli(["serve", "--config", file], { TWINNY_GATEWAY_TOKEN: TOKEN })
    assert.strictEqual(result.code, 4)
    assert.match(result.stderr, /not a provider kind this gateway can serve/)
  })

  test("an occupied port is exit 5", async () => {
    const holder = http.createServer()
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", () => resolve()))
    const { port } = holder.address() as AddressInfo
    try {
      const file = writeConfig("occupied", { ...configFor(11434), listen: { host: "127.0.0.1", port } })
      const result = await runCli(["serve", "--config", file], { TWINNY_GATEWAY_TOKEN: TOKEN })
      assert.strictEqual(result.code, 5)
      assert.match(result.stderr, /already in use/)
    } finally {
      holder.close()
    }
  })
})

suite("Gateway process: access keys and usage", function () {
  this.timeout(30_000)

  let backend: Backend
  let gateway: Gateway
  let configFile: string
  let aliceKey: string
  let bobKey: string

  const keyFrom = (stdout: string) => {
    const match = /^\s+(tsk_[0-9a-f]{8}_[0-9a-f]{64})\s*$/m.exec(stdout)
    assert.ok(match, `no key in:\n${stdout}`)
    return match[1]
  }

  suiteSetup(async () => {
    backend = await startBackend()
    configFile = writeConfig("keys", configFor(backend.port, { limits: { maxActiveRequests: 2 } }, "keys"))
    const alice = await runCli(["keys", "create", "alice", "--config", configFile])
    assert.strictEqual(alice.code, 0, alice.stderr)
    aliceKey = keyFrom(alice.stdout)
    const bob = await runCli(["keys", "create", "bob", "--config", configFile])
    bobKey = keyFrom(bob.stdout)
    gateway = await startGateway(configFile)
  })

  suiteTeardown(async () => {
    await gateway.stop()
    await backend.close()
  })

  setup(() => {
    backend.requests.length = 0
  })

  test("keys are shown once and only their hashes are stored", async () => {
    const stored = fs.readFileSync(path.join(dataDirFor("keys"), "keys.json"), "utf8")
    assert.ok(!stored.includes(aliceKey.split("_")[2]), "secret in the keys file")
    assert.match(stored, /"name": "alice"/)
    const listed = await runCli(["keys", "list", "--config", configFile])
    assert.match(listed.stdout, /alice .*active/)
    assert.match(listed.stdout, /bob .*active/)
    assert.ok(!listed.stdout.includes(aliceKey))
    const duplicate = await runCli(["keys", "create", "alice", "--config", configFile])
    assert.strictEqual(duplicate.code, 2)
    assert.match(duplicate.stderr, /already exists/)
  })

  test("startup reports the keys and warns while the shared token is still accepted", () => {
    assert.match(gateway.stdout, /access: {3}2 active keys, plus the shared token/)
    assert.match(gateway.stdout, /set auth.tokenEnv to null/)
  })

  test("two developers work with separate keys and are attributed separately", async () => {
    const alice = resolveInferenceProvider(remoteProvider(gateway, { apiKey: aliceKey }))
    const bob = resolveInferenceProvider(remoteProvider(gateway, { apiKey: bobKey }))
    assert.strictEqual(await readText(alice.fim(fimRequest())), "def add")
    assert.strictEqual(await readText(bob.fim(fimRequest())), "def add")
    assert.strictEqual(await readText(bob.fim(fimRequest())), "def add")
    const shared = resolveInferenceProvider(remoteProvider(gateway))
    assert.strictEqual(await readText(shared.fim(fimRequest())), "def add")
    await wait(100)
    assert.match(gateway.stderr, /event=request .*key=alice .*route=fim/)
    assert.match(gateway.stderr, /event=request .*key=bob .*route=fim/)
    assert.match(gateway.stderr, /event=request .*key=shared .*route=fim/)
    assert.ok(!gateway.stderr.includes(aliceKey.split("_")[2]), "key secret in the log")
  })

  test("usage is recorded per key with the backend's token counts, and summarised", async () => {
    await wait(100)
    const usageDir = path.join(dataDirFor("keys"), "usage")
    const files = fs.readdirSync(usageDir).filter((name) => name.endsWith(".jsonl"))
    assert.strictEqual(files.length, 1)
    const rows = fs
      .readFileSync(path.join(usageDir, files[0]), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const aliceRows = rows.filter((row) => row.key === "alice")
    assert.strictEqual(aliceRows.length, 1)
    assert.strictEqual(aliceRows[0].alias, "coder")
    assert.strictEqual(aliceRows[0].promptTokens, 12)
    assert.strictEqual(aliceRows[0].completionTokens, 2)
    assert.strictEqual(rows.filter((row) => row.key === "bob").length, 2)
    const text = JSON.stringify(rows)
    assert.ok(!text.includes(PROMPT_MARKER) && !text.includes("def add"), "content in usage records")

    const summary = await runCli(["usage", "--since", "1h", "--by", "key", "--config", configFile])
    assert.strictEqual(summary.code, 0, summary.stderr)
    assert.match(summary.stdout, /4 requests: 4 ok, 0 failed, 0 cancelled/)
    assert.match(summary.stdout, /^alice\s+1\s+1\s+0\s+0\s+12\s+2\s+\d+\s+-$/m)
    assert.match(summary.stdout, /^bob\s+2\s+2\s+0\s+0\s+24\s+4\s+\d+\s+-$/m)
    const byModel = await runCli(["usage", "--by", "model", "--config", configFile])
    assert.match(byModel.stdout, /^coder\s+4\s+4/m)
  })

  test("revoking a key refuses its next request without a restart; the other key keeps working", async () => {
    const revoked = await runCli(["keys", "revoke", "alice", "--config", configFile])
    assert.strictEqual(revoked.code, 0, revoked.stderr)
    assert.match(revoked.stdout, /Revoked key "alice"/)
    // The server rereads the file at most once a second.
    await wait(1_100)
    const alice = resolveInferenceProvider(remoteProvider(gateway, { apiKey: aliceKey }))
    const failure = await expectKind(() => readText(alice.fim(fimRequest())), "authentication")
    assert.strictEqual(failure.status, 401)
    await expectKind(() => alice.models(), "authentication")
    const bob = resolveInferenceProvider(remoteProvider(gateway, { apiKey: bobKey }))
    assert.strictEqual(await readText(bob.fim(fimRequest())), "def add")
    assert.strictEqual(backend.requests.length, 1, "the revoked key must not reach the backend")
    const again = await runCli(["keys", "revoke", "alice", "--config", configFile])
    assert.strictEqual(again.code, 2)
    const listed = await runCli(["keys", "list", "--config", configFile])
    assert.match(listed.stdout, /alice .*revoked/)
  })

  test("with keys and no shared token the server starts; with neither it does not", async () => {
    const withKeys = await startGateway(configFile, { TWINNY_GATEWAY_TOKEN: undefined })
    try {
      assert.match(withKeys.stdout, /access: {3}1 active key$/m)
      const bob = resolveInferenceProvider(remoteProvider(withKeys, { apiKey: bobKey }))
      assert.strictEqual(await readText(bob.fim(fimRequest())), "def add")
      await expectKind(
        () => resolveInferenceProvider(remoteProvider(withKeys)).models(),
        "authentication"
      )
    } finally {
      await withKeys.stop()
    }
    const retired = writeConfig(
      "retired",
      { ...configFor(backend.port, {}, "keys"), auth: { tokenEnv: null, keysFile: path.join(dataDirFor("keys"), "keys.json") } }
    )
    const noShared = await startGateway(retired)
    try {
      assert.ok(!/plus the shared token/.test(noShared.stdout))
      await expectKind(() => resolveInferenceProvider(remoteProvider(noShared)).models(), "authentication")
    } finally {
      await noShared.stop()
    }
  })
})

suite("Gateway process: identity, status, admin page, per-key limits", function () {
  this.timeout(30_000)

  let backend: Backend
  let dead: Backend
  let gateway: Gateway
  let configFile: string
  let adminKey: string
  let devKey: string

  const keyFrom = (stdout: string) => {
    const match = /^\s+(tsk_[0-9a-f]{8}_[0-9a-f]{64})\s*$/m.exec(stdout)
    assert.ok(match, `no key in:\n${stdout}`)
    return match[1]
  }
  const get = (route: string, key: string) =>
    fetch(`${gateway.url}${route}`, { headers: { Authorization: `Bearer ${key}` } })

  suiteSetup(async () => {
    backend = await startBackend()
    dead = await startBackend()
    await dead.close()
    const base = configFor(backend.port, { limits: { maxActiveRequests: 4, perKey: { maxActiveRequests: 1, requestsPerMinute: 3 } } }, "admin")
    const config = {
      ...base,
      providers: { ...base.providers, gone: { provider: "ollama", apiHostname: "127.0.0.1", apiPort: dead.port } },
      models: [...base.models, { alias: "ghost", provider: "gone", model: "x", capabilities: ["chat"] }]
    }
    configFile = writeConfig("admin", config)
    adminKey = keyFrom((await runCli(["keys", "create", "ops", "--admin", "--config", configFile])).stdout)
    devKey = keyFrom((await runCli(["keys", "create", "dev", "--config", configFile])).stdout)
    gateway = await startGateway(configFile, { TWINNY_GATEWAY_TOKEN: undefined })
  })

  suiteTeardown(async () => {
    await gateway.stop()
    await backend.close()
  })

  setup(() => {
    backend.requests.length = 0
  })

  test("startup probes every backend and says which is down", async () => {
    await until(() => /backend: {2}gone is not answering/.test(gateway.stdout), 8_000)
    assert.match(gateway.stdout, /backend: {2}local answers \(\d+ ms\)/)
    assert.match(gateway.stderr, /event=backend\.probe .*provider=gone ok=false/)
  })

  test("whoami names the key and whether it is an admin", async () => {
    const admin = (await (await get("/twinny/v1/whoami", adminKey)).json()) as Record<string, unknown>
    assert.deepStrictEqual(admin, { protocol: 1, key: "ops", shared: false, admin: true })
    const dev = (await (await get("/twinny/v1/whoami", devKey)).json()) as Record<string, unknown>
    assert.deepStrictEqual(dev, { protocol: 1, key: "dev", shared: false })
    assert.strictEqual((await get("/twinny/v1/whoami", "tsk_00000000_" + "0".repeat(64))).status, 401)
  })

  test("the provider test reports who the gateway took it for", async () => {
    const { testProvider } = await import("../../extension/providers/probe")
    const result = await testProvider(remoteProvider(gateway, { apiKey: devKey }))
    assert.strictEqual(result.success, true, result.error)
    assert.strictEqual(result.identity, "dev")
  })

  test("status checks the backends live, for any valid key", async () => {
    const response = await get("/twinny/v1/status", devKey)
    assert.strictEqual(response.status, 200)
    const status = (await response.json()) as { backends: Array<{ provider: string; ok: boolean; kind?: string }>; models: Array<{ id: string; ok: boolean }> }
    const byProvider = Object.fromEntries(status.backends.map((b) => [b.provider, b]))
    assert.strictEqual(byProvider.local.ok, true)
    assert.strictEqual(byProvider.gone.ok, false)
    assert.strictEqual(byProvider.gone.kind, "provider-unavailable")
    assert.deepStrictEqual(
      status.models.map((m) => [m.id, m.ok]),
      [["coder", true], ["embed", true], ["ghost", false]]
    )
  })

  test("the admin page is served to anyone; its API only to admin keys", async () => {
    const page = await fetch(`${gateway.url}/admin`)
    assert.strictEqual(page.status, 200)
    assert.match(page.headers.get("content-type") || "", /text\/html/)
    const html = await page.text()
    assert.match(html, /<title>twinny-server<\/title>/)
    assert.match(html, /id="root"/)
    assert.ok(!html.includes(adminKey))

    const forbidden = await get("/twinny/v1/admin/keys", devKey)
    assert.strictEqual(forbidden.status, 403)
    const anonymous = await fetch(`${gateway.url}/twinny/v1/admin/keys`)
    assert.strictEqual(anonymous.status, 401)

    const keys = (await (await get("/twinny/v1/admin/keys", adminKey)).json()) as { keys: Array<Record<string, unknown>>; sharedToken: boolean }
    assert.deepStrictEqual(keys.keys.map((k) => [k.name, k.admin ?? false]), [["ops", true], ["dev", false]])
    assert.ok(keys.keys.every((k) => !("hash" in k)), "hashes must not leave the server")
    assert.strictEqual(keys.sharedToken, false)

    const usage = (await (await get("/twinny/v1/admin/usage?since=1h", adminKey)).json()) as { total: { requests: number }; byDay: unknown[] }
    assert.ok(typeof usage.total.requests === "number")
    assert.ok(Array.isArray(usage.byDay))
    assert.strictEqual((await get("/twinny/v1/admin/usage?since=soon", adminKey)).status, 400)
  })

  test("an admin creates and revokes keys from the page's API; never their own", async () => {
    const post = (route: string, key: string, body?: unknown) =>
      fetch(`${gateway.url}${route}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      })
    assert.strictEqual((await post("/twinny/v1/admin/keys", devKey, { name: "eve" })).status, 403)
    assert.strictEqual((await post("/twinny/v1/admin/keys", adminKey, { name: "bad name!" })).status, 400)

    const created = await post("/twinny/v1/admin/keys", adminKey, { name: "carol", admin: false })
    assert.strictEqual(created.status, 201)
    const body = (await created.json()) as { key: string; record: { id: string; name: string } }
    assert.match(body.key, /^tsk_[0-9a-f]{8}_[0-9a-f]{64}$/)
    assert.strictEqual(body.record.name, "carol")
    const who = (await (await get("/twinny/v1/whoami", body.key)).json()) as { key: string }
    assert.strictEqual(who.key, "carol")
    const listed = await runCli(["keys", "list", "--config", configFile])
    assert.match(listed.stdout, /carol .*active/)

    const ops = (await (await get("/twinny/v1/admin/keys", adminKey)).json()) as { keys: Array<{ id: string; name: string }> }
    const opsId = ops.keys.find((k) => k.name === "ops")?.id
    assert.ok(opsId)
    const self = await post(`/twinny/v1/admin/keys/${opsId}/revoke`, adminKey)
    assert.strictEqual(self.status, 400)
    assert.match(((await self.json()) as { error: { message: string } }).error.message, /signed in with/)

    const revoked = await post(`/twinny/v1/admin/keys/${body.record.id}/revoke`, adminKey)
    assert.strictEqual(revoked.status, 200)
    await wait(1_100)
    assert.strictEqual((await get("/twinny/v1/whoami", body.key)).status, 401)
    assert.strictEqual((await post(`/twinny/v1/admin/keys/${body.record.id}/revoke`, adminKey)).status, 404)
    assert.strictEqual((await get(`/twinny/v1/admin/keys/${body.record.id}/revoke`, adminKey)).status, 502)
    assert.match(gateway.stderr, /event=admin\.key-created key=ops .*reason=carol/)
    assert.ok(!gateway.stderr.includes(body.key.split("_")[2]), "secret in the log")
  })

  test("per-key limits refuse one key's excess while another key keeps working", async () => {
    const dev = resolveInferenceProvider(remoteProvider(gateway, { apiKey: devKey }))
    const ops = resolveInferenceProvider(remoteProvider(gateway, { apiKey: adminKey }))
    const controller = new AbortController()
    const first = dev.fim(fimRequest(STALL), { signal: controller.signal })[Symbol.asyncIterator]()
    await first.next()
    const refused = await expectKind(() => readText(dev.fim(fimRequest())), "rate-limited")
    assert.match(refused.message, /Your key is at its limit of 1/)
    assert.strictEqual(await readText(ops.fim(fimRequest())), "def add")
    controller.abort()
    await expectKind(() => first.next(), "cancelled")
    await until(() => backend.requests[0].cancelled)

    // Two starts so far this minute for dev; the limit is three.
    assert.strictEqual(await readText(dev.fim(fimRequest())), "def add")
    const perMinute = await expectKind(() => readText(dev.fim(fimRequest())), "rate-limited")
    assert.match(perMinute.message, /in the last minute/)
    assert.strictEqual(await readText(ops.fim(fimRequest())), "def add")
    assert.match(gateway.stderr, /event=request\.refused .*key=dev .*kind=rate-limited .*reason=key/)
  })

  test("a revoked key is told so, an unknown key is told so, a retired shared token is told so", async () => {
    await runCli(["keys", "revoke", "dev", "--config", configFile])
    await wait(1_100)
    const revoked = await expectKind(
      () => resolveInferenceProvider(remoteProvider(gateway, { apiKey: devKey })).models(),
      "authentication"
    )
    assert.match(revoked.message, /was revoked on \d{4}-\d{2}-\d{2}/)
    const unknown = await expectKind(
      () => resolveInferenceProvider(remoteProvider(gateway, { apiKey: "tsk_01234567_" + "a".repeat(64) })).models(),
      "authentication"
    )
    assert.match(unknown.message, /not known to the gateway/)
    const shared = await expectKind(
      () => resolveInferenceProvider(remoteProvider(gateway)).models(),
      "authentication"
    )
    assert.match(shared.message, /use a personal gateway key/)
    const { describeProviderError } = await import("../../extension/providers/errors")
    assert.match(describeProviderError(revoked, remoteProvider(gateway)), /was revoked on/)
  })
})

suite("Gateway process: provider and model management", function () {
  this.timeout(30_000)
  let backend: Backend
  let gateway: Gateway
  let file: string
  let admin: string
  let developer: string
  let sequence = 0
  const endpoint = "/twinny/v1/admin/config"
  const get = (key = admin) => fetch(`${gateway.url}${endpoint}`, { headers: { Authorization: `Bearer ${key}` } })
  const snapshot = async () => (await (await get()).json()) as ConfigurationSnapshot
  const put = (body: unknown, key = admin) => fetch(`${gateway.url}${endpoint}`, {
    method: "PUT", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body)
  })
  const payload = (config: ConfigurationSnapshot) => ({ revision: config.revision, providers: config.providers, models: config.models })
  const listed = async () => (await (await fetch(`${gateway.url}/twinny/v1/models`, { headers: { Authorization: `Bearer ${developer}` } })).json()) as { models: Array<{ id: string }> }

  suiteSetup(async () => { backend = await startBackend() })
  suiteTeardown(async () => { await backend.close() })
  setup(async () => {
    const name = `configuration-${sequence++}`
    const base = configFor(backend.port, {}, name)
    file = writeConfig(name, base)
    const keys = KeyStore.open(base.auth.keysFile)
    admin = keys.create("operator", { admin: true }).key
    developer = keys.create("developer").key
    gateway = await startGateway(file)
    backend.requests.length = 0
  })
  teardown(async () => { await gateway.stop() })

  test("only admins can read or save; snapshots exclude auth, limits and secret values", async () => {
    assert.strictEqual((await get(developer)).status, 403)
    assert.strictEqual((await put({}, developer)).status, 403)
    assert.strictEqual((await fetch(`${gateway.url}${endpoint}`)).status, 401)
    assert.strictEqual((await get(TOKEN)).status, 403)
    const config = await snapshot()
    assert.deepStrictEqual(Object.keys(config).sort(), ["kinds", "models", "policy", "providers", "recording", "revision", "teamDefaults"])
    assert.ok(config.kinds.some((kind) => kind.id === "openai-compatible"))
    assert.ok(!JSON.stringify(config).includes(TOKEN))
    assert.ok(!JSON.stringify(config).includes(admin))
    const invalidMethod = await fetch(`${gateway.url}${endpoint}`, { method: "POST", headers: { Authorization: `Bearer ${admin}` } })
    assert.strictEqual(invalidMethod.status, 405)
  })

  test("add, edit, rename and remove take effect live and survive a restart", async () => {
    const before = JSON.parse(fs.readFileSync(file, "utf8"))
    const initial = await snapshot()
    const changed = payload(initial)
    changed.providers.team = { ...changed.providers.local }
    changed.models.push({ alias: "team-chat", provider: "team", model: "first-model", capabilities: ["chat"] })
    const added = await put(changed)
    assert.strictEqual(added.status, 200, await added.text())
    assert.ok((await listed()).models.some((model) => model.id === "team-chat"))

    const edit = payload(await snapshot())
    edit.providers.renamed = edit.providers.team
    delete edit.providers.team
    edit.models = edit.models.map((model) => model.alias === "team-chat" ? { ...model, alias: "shared-chat", provider: "renamed", model: "second-model", contextWindow: 8192 } : model)
    assert.strictEqual((await put(edit)).status, 200)
    const client = resolveInferenceProvider(remoteProvider(gateway, { apiKey: developer, type: "chat", modelName: "shared-chat" }))
    let reply = ""
    for await (const chunk of client.chat({ model: "shared-chat", messages: [{ role: "user", content: "Hello" }] })) reply += chunk.content
    assert.strictEqual(reply, "Hello there")
    assert.ok(backend.requests.some((request) => request.model === "second-model"))
    const disk = JSON.parse(fs.readFileSync(file, "utf8"))
    for (const key of ["auth", "listen", "usage", "limits"]) assert.deepStrictEqual(disk[key], before[key])
    await gateway.stop()
    gateway = await startGateway(file)
    assert.ok((await listed()).models.some((model) => model.id === "shared-chat"))

    const remove = payload(await snapshot())
    remove.models = remove.models.filter((model) => model.alias !== "shared-chat")
    delete remove.providers.renamed
    assert.strictEqual((await put(remove)).status, 200)
    assert.deepStrictEqual((await listed()).models.map((model) => model.id), ["coder", "embed"])
    assert.match(gateway.stderr, /event=admin\.config-updated key=operator/)
  })

  test("invalid routes, referenced provider deletion, empty configs and secrets are refused without changes", async () => {
    const initial = await snapshot()
    const before = fs.readFileSync(file, "utf8")
    const invalid = [
      { ...payload(initial), providers: {} },
      { ...payload(initial), models: [] },
      { ...payload(initial), models: [...initial.models, initial.models[0]] },
      { ...payload(initial), providers: { local: { provider: "ollama", apiKeyEnv: "TWINNY_UNSET_BACKEND_KEY_TEST" } } },
      { ...payload(initial), providers: { local: { provider: "anthropic" } } },
      { ...payload(initial), auth: { tokenEnv: null } },
      { ...payload(initial), providers: { local: { provider: "ollama", apiKey: "do-not-store" } } },
      { ...payload(initial), providers: { ...initial.providers, unused: { provider: "ollama", apiHostname: "not a host" } } }
    ]
    for (const input of invalid) {
      const response = await put(input)
      assert.strictEqual(response.status, 400, await response.text())
      assert.strictEqual(fs.readFileSync(file, "utf8"), before)
    }
    assert.strictEqual((await snapshot()).revision, initial.revision)
    assert.deepStrictEqual((await listed()).models.map((model) => model.id), ["coder", "embed"])
  })

  test("stale saves and external file edits cannot overwrite a newer configuration", async () => {
    const initial = payload(await snapshot())
    const update = { ...initial, models: initial.models.map((model) => ({ ...model, contextWindow: 4096 })) }
    assert.strictEqual((await put(update)).status, 200)
    const saved = fs.readFileSync(file, "utf8")
    assert.strictEqual((await put(initial)).status, 409)
    assert.strictEqual(fs.readFileSync(file, "utf8"), saved)
    const current = payload(await snapshot())
    fs.appendFileSync(file, "\n")
    const external = await put(current)
    assert.strictEqual(external.status, 409)
    assert.match(await external.text(), /Restart the gateway/)
    assert.strictEqual(fs.readFileSync(file, "utf8"), `${saved}\n`)
  })

  test("saving does not interrupt an active stream; subsequent requests use the edited model", async () => {
    const client = resolveInferenceProvider(remoteProvider(gateway, { apiKey: developer }))
    const controller = new AbortController()
    const stream = client.fim(fimRequest(STALL), { signal: controller.signal })[Symbol.asyncIterator]()
    assert.strictEqual((await stream.next()).value?.text, "def")
    const active = backend.requests.find((request) => request.model === "backend-coder:7b")!
    const update = payload(await snapshot())
    update.models[0].model = "replacement-coder"
    assert.strictEqual((await put(update)).status, 200)
    assert.strictEqual(active.cancelled, false)
    assert.strictEqual(await readText(client.fim(fimRequest())), "def add")
    assert.ok(backend.requests.some((request) => request.model === "replacement-coder"))
    controller.abort()
    await stream.return?.()
  })

  test("admins publish capability-checked team defaults live for authenticated developers", async () => {
    const initial = await snapshot()
    const response = await put({ ...payload(initial), teamDefaults: { chat: "coder", fim: "coder", embeddings: "embed" } })
    assert.strictEqual(response.status, 200)
    const teamUrl = `${gateway.url}/twinny/v1/team`
    assert.strictEqual((await fetch(teamUrl)).status, 401)
    const team = await (await fetch(teamUrl, { headers: { Authorization: `Bearer ${developer}` } })).json() as { defaults: unknown; models: unknown[] }
    assert.deepStrictEqual(team.defaults, { chat: "coder", fim: "coder", embeddings: "embed" })
    assert.strictEqual(team.models.length, 2)
    const current = await snapshot()
    const before = fs.readFileSync(file, "utf8")
    assert.strictEqual((await put({ ...payload(current), teamDefaults: { fim: "embed" } })).status, 400)
    assert.strictEqual((await put({ ...payload(current), teamDefaults: { chat: "missing" } })).status, 400)
    assert.strictEqual(fs.readFileSync(file, "utf8"), before)
    await gateway.stop()
    gateway = await startGateway(file)
    assert.deepStrictEqual((await snapshot()).teamDefaults, { chat: "coder", fim: "coder", embeddings: "embed" })
  })

  test("model discovery supports draft providers and is restricted to admins", async () => {
    const before = fs.readFileSync(file, "utf8")
    const draft = { provider: "openai-compatible", apiHostname: "127.0.0.1", apiPort: backend.port }
    const discover = (body: unknown, key = admin) => fetch(`${gateway.url}/twinny/v1/admin/provider-models`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body)
    })
    assert.strictEqual((await discover({ provider: draft }, developer)).status, 403)
    const response = await discover({ provider: draft })
    assert.strictEqual(response.status, 200, await response.clone().text())
    const result = await response.json() as { models: Array<{ id: string }> }
    assert.deepStrictEqual(result.models.map((model) => model.id), ["backend-coder:7b", "backend-embed"])
    assert.strictEqual((await discover({ provider: { ...draft, apiKeyEnv: "TWINNY_UNSET_BACKEND_KEY_TEST" } })).status, 400)
    assert.strictEqual((await discover({ provider: { ...draft, apiHostname: "bad host" } })).status, 400)
    const unavailable = await startBackend()
    await unavailable.close()
    const failed = await discover({ provider: { ...draft, apiPort: unavailable.port } })
    assert.strictEqual(failed.status, 400)
    assert.strictEqual(fs.readFileSync(file, "utf8"), before)
  })

  test("malformed and oversized save requests leave disk and live routing unchanged", async () => {
    const before = fs.readFileSync(file, "utf8")
    for (const body of ["not-json", JSON.stringify({ padding: "x".repeat(256 * 1024) })]) {
      const response = await fetch(`${gateway.url}${endpoint}`, { method: "PUT", headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" }, body })
      assert.strictEqual(response.status, 400)
    }
    assert.strictEqual(fs.readFileSync(file, "utf8"), before)
    assert.deepStrictEqual((await listed()).models.map((model) => model.id), ["coder", "embed"])
  })
})

suite("Gateway process: plan and seats", function () {
  this.timeout(30_000)

  let backend: Backend
  let configFile: string

  suiteSetup(async () => {
    backend = await startBackend()
    configFile = writeConfig("seats", configFor(backend.port, {}, "seats"))
  })

  suiteTeardown(async () => {
    await backend.close()
  })

  test("the free plan allows five keys from the CLI and refuses the sixth with the reason", async () => {
    for (const name of ["a", "b", "c", "d", "e"]) {
      const made = await runCli(["keys", "create", name, "--config", configFile])
      assert.strictEqual(made.code, 0, made.stderr)
    }
    const sixth = await runCli(["keys", "create", "f", "--config", configFile])
    assert.strictEqual(sixth.code, 2)
    assert.match(sixth.stderr, /No seat for a new key: 5 active keys and the free plan allows 5/)

    const plan = await runCli(["license", "--config", configFile])
    assert.strictEqual(plan.code, 0, plan.stderr)
    assert.match(plan.stdout, /^Plan: Free plan, 5 of 5 seats used/m)
    assert.match(plan.stdout, /none installed/)

    const bad = await runCli(["license", "set", "twl1.nope.nope", "--config", configFile])
    assert.strictEqual(bad.code, 2)
    assert.match(bad.stderr, /^Not installed:/)
    assert.ok(!fs.existsSync(path.join(dataDirFor("seats"), "license")), "a refused token was written")

    const help = await runCli(["license", "--help"])
    assert.strictEqual(help.code, 0)
    assert.match(help.stdout, /up to\s+5 of them/)
  })

  test("the banner reports the plan, and a key beyond the seats is refused with a reason", async () => {
    // A sixth key made directly, as an operator editing keys.json could.
    const store = KeyStore.open(path.join(dataDirFor("seats"), "keys.json"))
    const extra = store.create("f").key
    const gateway = await startGateway(configFile)
    try {
      assert.match(gateway.stdout, /plan: {5}Free plan, 6 of 5 seats used/)
      await until(() => /note: {5}1 key has no seat and will be refused: f\./.test(gateway.stdout))
      const refused = await fetch(`${gateway.url}/twinny/v1/whoami`, { headers: { Authorization: `Bearer ${extra}` } })
      assert.strictEqual(refused.status, 401)
      const body = (await refused.json()) as { error: { message: string } }
      assert.match(body.error.message, /no seat/)
      const revoked = await runCli(["keys", "revoke", "a", "--config", configFile])
      assert.strictEqual(revoked.code, 0, revoked.stderr)
      await wait(1_100)
      const seated = await fetch(`${gateway.url}/twinny/v1/whoami`, { headers: { Authorization: `Bearer ${extra}` } })
      assert.strictEqual(seated.status, 200, "revoking a key frees a seat for the next in line without a restart")
    } finally {
      await gateway.stop()
    }
  })
})

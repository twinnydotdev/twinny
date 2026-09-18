/**
 * The remote inference protocol, both ends in one process: the handler on
 * a real HTTP server fronting a deterministic provider, the remote adapter
 * resolved through the registry like any other provider.
 */
import * as assert from "assert"
import * as http from "http"
import { AddressInfo } from "net"

import { API_PROVIDERS } from "../../common/constants"
import { TwinnyProvider } from "../../common/types"
import {
  ChatRequest,
  EmbeddingRequest,
  FimRequest,
  guard,
  InferenceCapability,
  InferenceClient,
  InferenceError,
  InferenceProvider,
  isInferenceError,
  readText,
  resolveInferenceProvider
} from "../../extension/inference"
import {
  handleRemoteRequest,
  kindForStatus,
  matchRemoteRoute,
  parseFimRequest,
  REMOTE_PROTOCOL_VERSION,
  RemoteRequestOutcome,
  statusForKind
} from "../../protocol"

/* -------------------------------------------------------------------------- */
/*  A deterministic backend                                                   */
/* -------------------------------------------------------------------------- */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Streams what it is told, slowly enough to be cancelled, and remembers everything. */
class ScriptedProvider implements InferenceProvider {
  public readonly id = "scripted"
  public fimRequests: FimRequest[] = []
  public chatRequests: ChatRequest[] = []
  public embeddingRequests: EmbeddingRequest[] = []
  public aborted: string[] = []
  public started = 0
  public finished = 0

  constructor(
    public chunks: string[] = ["a", "b", "c"],
    public delayMs = 0,
    public failWith?: InferenceError
  ) {}

  capabilities(): InferenceCapability[] {
    return ["fim", "chat", "embeddings"]
  }

  async models() {
    return [{ id: "backend-model", name: "backend-model", capabilities: this.capabilities() }]
  }

  private async *emit(kind: string, signal?: AbortSignal) {
    this.started++
    const onAbort = () => this.aborted.push(kind)
    signal?.addEventListener("abort", onAbort, { once: true })
    try {
      if (this.failWith) throw this.failWith
      for (const text of this.chunks) {
        if (this.delayMs) await wait(this.delayMs)
        if (signal?.aborted) return
        yield text
      }
    } finally {
      this.finished++
      signal?.removeEventListener("abort", onAbort)
    }
  }

  async *fim(request: FimRequest, options?: { signal?: AbortSignal }) {
    this.fimRequests.push(request)
    for await (const text of this.emit("fim", options?.signal)) yield { text }
  }

  async *chat(request: ChatRequest, options?: { signal?: AbortSignal }) {
    this.chatRequests.push(request)
    for await (const text of this.emit("chat", options?.signal)) yield { content: text }
  }

  async embeddings(request: EmbeddingRequest) {
    this.embeddingRequests.push(request)
    if (this.failWith) throw this.failWith
    const inputs = Array.isArray(request.input) ? request.input : [request.input]
    return { vectors: inputs.map((text) => [text.length, 1, 2]) }
  }
}

interface Gateway {
  port: number
  outcomes: RemoteRequestOutcome[]
  /** Set to abort every in-flight job from the host side. */
  hostSignal?: AbortSignal
  close(): Promise<void>
}

const ALIASES = {
  coder: { model: "backend-coder", capabilities: ["fim", "chat"] as InferenceCapability[] },
  embed: { model: "backend-embed", capabilities: ["embeddings"] as InferenceCapability[] }
}

/** The protocol handler on a bare server: no auth, no limits, just routes. */
const startGateway = (
  client: InferenceClient,
  options: { hostSignal?: AbortSignal; maxBodyBytes?: number } = {}
): Promise<Gateway> =>
  new Promise((resolve) => {
    const outcomes: RemoteRequestOutcome[] = []
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://x")
      const match = matchRemoteRoute(url.pathname)
      if (!match) {
        res.writeHead(404).end()
        return
      }
      void handleRemoteRequest(match.route, req, res, {
        models: () =>
          Object.entries(ALIASES).map(([id, entry]) => ({
            id,
            name: id,
            capabilities: entry.capabilities
          })),
        route: (alias, capability) => {
          const entry = ALIASES[alias as keyof typeof ALIASES]
          if (!entry) throw new InferenceError("model-unavailable", `No model "${alias}".`)
          if (!entry.capabilities.includes(capability)) {
            throw new InferenceError("unsupported-capability", `${alias} cannot ${capability}.`)
          }
          return { client, model: entry.model }
        },
        signal: options.hostSignal,
        maxBodyBytes: options.maxBodyBytes
      }).then((outcome) => outcomes.push(outcome))
    })
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({
        port,
        outcomes,
        close: () =>
          new Promise((done) => {
            const closable = server as unknown as { closeAllConnections?: () => void }
            closable.closeAllConnections?.()
            server.close(() => done())
          })
      })
    })
  })

const remoteConfig = (port: number, extra: Partial<TwinnyProvider> = {}): TwinnyProvider => ({
  id: "remote-1",
  label: "Gateway",
  modelName: "coder",
  provider: API_PROVIDERS.TwinnyRemote,
  type: "fim",
  apiHostname: "127.0.0.1",
  apiPort: port,
  apiProtocol: "http",
  apiPath: "",
  apiKey: "secret-token",
  ...extra
})

const fimRequest: FimRequest = {
  model: "coder",
  prompt: "def add(a, b):\n    return",
  stop: ["\n\n"],
  maxTokens: 16,
  temperature: 0
}

const expectKind = async (run: () => Promise<unknown>, kind: string) => {
  try {
    await run()
  } catch (error) {
    assert.ok(isInferenceError(error), `expected an InferenceError, got ${String(error)}`)
    assert.strictEqual(error.kind, kind, error.message)
    return error
  }
  assert.fail(`expected a ${kind} error`)
}

/* -------------------------------------------------------------------------- */

suite("Remote protocol: wire", () => {
  test("routes are matched below the protocol base, with any prefix", () => {
    assert.strictEqual(matchRemoteRoute("/twinny/v1/models")?.route, "models")
    assert.strictEqual(matchRemoteRoute("/twinny/v1/fim")?.method, "POST")
    assert.strictEqual(matchRemoteRoute("/ai/twinny/v1/chat", "/ai")?.route, "chat")
    assert.strictEqual(matchRemoteRoute("/twinny/v1/chat", "/ai"), undefined)
    assert.strictEqual(matchRemoteRoute("/v1/models"), undefined)
    assert.strictEqual(matchRemoteRoute("/twinny/v1/embeddings/")?.route, "embeddings")
  })

  test("every error kind has a status and comes back from it", () => {
    assert.strictEqual(statusForKind("authentication"), 401)
    assert.strictEqual(statusForKind("rate-limited"), 429)
    assert.strictEqual(statusForKind("timeout"), 504)
    assert.strictEqual(kindForStatus(401), "authentication")
    assert.strictEqual(kindForStatus(503), "provider-unavailable")
    assert.strictEqual(kindForStatus(418), "inference-failure")
  })

  test("request bodies are allow-listed", () => {
    assert.throws(
      () => parseFimRequest({ model: "m", prompt: "p", apiHostname: "evil" }),
      /unknown field "apiHostname"/
    )
    assert.throws(() => parseFimRequest({ prompt: "p" }), /"model"/)
    assert.throws(() => parseFimRequest({ model: "m", prompt: 1 }), /"prompt"/)
    const parsed = parseFimRequest({ model: "m", prompt: "p", stop: ["x"], maxTokens: 3 })
    assert.deepStrictEqual(parsed.stop, ["x"])
    assert.strictEqual(parsed.maxTokens, 3)
  })
})

suite("Remote protocol: round trip", () => {
  let backend: ScriptedProvider
  let gateway: Gateway

  setup(async () => {
    backend = new ScriptedProvider(["def", " add", "(a, b)"])
    gateway = await startGateway(guard(backend))
  })

  teardown(() => gateway.close())

  test("the remote provider is resolved through the registry", () => {
    const client = resolveInferenceProvider(remoteConfig(gateway.port))
    assert.strictEqual(client.id, API_PROVIDERS.TwinnyRemote)
    assert.deepStrictEqual(client.capabilities(), ["fim", "chat", "embeddings"])
  })

  test("discovery lists only what the gateway advertises", async () => {
    const models = await resolveInferenceProvider(remoteConfig(gateway.port)).models()
    assert.deepStrictEqual(
      models.map((m) => [m.id, m.capabilities]),
      [
        ["coder", ["fim", "chat"]],
        ["embed", ["embeddings"]]
      ]
    )
    // The backend's own listing never leaks through.
    assert.ok(!models.some((m) => m.id === "backend-model"))
  })

  test("FIM streams chunk by chunk and reaches the mapped backend model", async () => {
    const client = resolveInferenceProvider(remoteConfig(gateway.port))
    const seen: string[] = []
    for await (const chunk of client.fim(fimRequest)) seen.push(chunk.text)
    assert.deepStrictEqual(seen, ["def", " add", "(a, b)"])
    assert.strictEqual(backend.fimRequests[0].model, "backend-coder")
    assert.strictEqual(backend.fimRequests[0].prompt, fimRequest.prompt)
    assert.deepStrictEqual(backend.fimRequests[0].stop, ["\n\n"])
    assert.strictEqual(gateway.outcomes[0].outcome, "ok")
    assert.strictEqual(gateway.outcomes[0].alias, "coder")
  })

  test("chat streams and carries only role and content", async () => {
    const client = resolveInferenceProvider(remoteConfig(gateway.port, { type: "chat" }))
    const text = await readText(
      client.chat({
        model: "coder",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "hi", images: ["data:..."] } as ChatRequest["messages"][number]
        ]
      })
    )
    assert.strictEqual(text, "def add(a, b)")
    const [request] = backend.chatRequests
    assert.strictEqual(request.model, "backend-coder")
    assert.deepStrictEqual(request.messages, [
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" }
    ])
  })

  test("embeddings come back as vectors in input order", async () => {
    const client = resolveInferenceProvider(remoteConfig(gateway.port, { type: "embedding" }))
    const { vectors } = await client.embeddings({ model: "embed", input: ["ab", "abcd"] })
    assert.deepStrictEqual(vectors, [
      [2, 1, 2],
      [4, 1, 2]
    ])
    assert.strictEqual(backend.embeddingRequests[0].model, "backend-embed")
  })

  test("an unknown alias and a forbidden capability are normalized errors", async () => {
    const client = resolveInferenceProvider(remoteConfig(gateway.port))
    const missing = await expectKind(
      () => readText(client.fim({ ...fimRequest, model: "nope" })),
      "model-unavailable"
    )
    assert.strictEqual(missing?.status, 404)
    await expectKind(() => readText(client.fim({ ...fimRequest, model: "embed" })), "unsupported-capability")
    await expectKind(
      () => client.embeddings({ model: "coder", input: "x" }),
      "unsupported-capability"
    )
    assert.strictEqual(backend.started, 0)
  })

  test("a request that tries to carry provider settings is refused before any provider work", async () => {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/twinny/v1/fim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "coder", prompt: "p", apiHostname: "attacker" })
    })
    assert.strictEqual(response.status, 400)
    const body = (await response.json()) as { error: { kind: string; message: string } }
    assert.strictEqual(body.error.kind, "inference-failure")
    assert.match(body.error.message, /unknown field "apiHostname"/)
    assert.strictEqual(backend.started, 0)
  })

  test("a backend failure arrives as the same kind, after the stream started", async () => {
    backend.failWith = new InferenceError("model-unavailable", "backend has no such model")
    const client = resolveInferenceProvider(remoteConfig(gateway.port))
    await expectKind(() => readText(client.fim(fimRequest)), "model-unavailable")
  })

  test("a wrong method is 405, not a provider call", async () => {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/twinny/v1/models`, {
      method: "POST"
    })
    assert.strictEqual(response.status, 405)
    assert.strictEqual(response.headers.get("allow"), "GET")
  })
})

suite("Remote protocol: cancellation and limits", () => {
  test("aborting the consumer's signal aborts the backend", async () => {
    const backend = new ScriptedProvider(["1", "2", "3", "4", "5", "6"], 60)
    const gateway = await startGateway(guard(backend))
    try {
      const client = resolveInferenceProvider(remoteConfig(gateway.port))
      const controller = new AbortController()
      const seen: string[] = []
      await expectKind(async () => {
        for await (const chunk of client.fim(fimRequest, { signal: controller.signal })) {
          seen.push(chunk.text)
          if (seen.length === 2) controller.abort()
        }
      }, "cancelled")
      assert.deepStrictEqual(seen, ["1", "2"])
      for (let i = 0; i < 40 && backend.aborted.length === 0; i++) await wait(25)
      assert.deepStrictEqual(backend.aborted, ["fim"])
      for (let i = 0; i < 40 && gateway.outcomes.length === 0; i++) await wait(25)
      // The client took two chunks and left: it was answered.
      assert.strictEqual(gateway.outcomes[0].outcome, "ok")
      assert.strictEqual(gateway.outcomes[0].chunks, 2)
      assert.strictEqual(gateway.outcomes[0].status, 200)
    } finally {
      await gateway.close()
    }
  })

  test("hanging up before the first chunk is a cancellation", async () => {
    const backend = new ScriptedProvider(["1", "2", "3"], 200)
    const gateway = await startGateway(guard(backend))
    try {
      const client = resolveInferenceProvider(remoteConfig(gateway.port))
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 40)
      await expectKind(async () => {
        for await (const chunk of client.fim(fimRequest, { signal: controller.signal })) {
          assert.fail(`unexpected chunk ${chunk.text}`)
        }
      }, "cancelled")
      for (let i = 0; i < 40 && gateway.outcomes.length === 0; i++) await wait(25)
      assert.strictEqual(gateway.outcomes[0].outcome, "cancelled")
      assert.strictEqual(gateway.outcomes[0].chunks, 0)
      assert.strictEqual(gateway.outcomes[0].status, 499)
    } finally {
      await gateway.close()
    }
  })

  test("leaving the loop early cancels the backend too", async () => {
    const backend = new ScriptedProvider(["1", "2", "3", "4", "5", "6"], 60)
    const gateway = await startGateway(guard(backend))
    try {
      const client = resolveInferenceProvider(remoteConfig(gateway.port))
      for await (const chunk of client.fim(fimRequest)) {
        if (chunk.text === "2") break
      }
      for (let i = 0; i < 40 && backend.aborted.length === 0; i++) await wait(25)
      assert.deepStrictEqual(backend.aborted, ["fim"])
    } finally {
      await gateway.close()
    }
  })

  test("the host's signal ends a stream with the reason it gives", async () => {
    const backend = new ScriptedProvider(["1", "2", "3", "4", "5", "6"], 60)
    const host = new AbortController()
    const gateway = await startGateway(guard(backend), { hostSignal: host.signal })
    try {
      const client = resolveInferenceProvider(remoteConfig(gateway.port))
      const seen: string[] = []
      const failure = await expectKind(async () => {
        for await (const chunk of client.fim(fimRequest)) {
          seen.push(chunk.text)
          if (seen.length === 1) {
            host.abort(new InferenceError("timeout", "deadline"))
          }
        }
      }, "timeout")
      assert.strictEqual(failure?.message, "deadline")
      assert.ok(seen.length >= 1)
      assert.deepStrictEqual(backend.aborted, ["fim"])
    } finally {
      await gateway.close()
    }
  })

  test("a body over the limit is refused with 413", async () => {
    const backend = new ScriptedProvider()
    const gateway = await startGateway(guard(backend), { maxBodyBytes: 2048 })
    try {
      const client = resolveInferenceProvider(remoteConfig(gateway.port))
      const failure = await expectKind(
        () => readText(client.fim({ ...fimRequest, prompt: "x".repeat(4096) })),
        "inference-failure"
      )
      assert.strictEqual(failure?.status, 413)
      assert.strictEqual(backend.started, 0)
    } finally {
      await gateway.close()
    }
  })
})

suite("Remote protocol: authentication and redirects", () => {
  test("a 401 without a protocol body is still an authentication error", async () => {
    const server = http.createServer((_, res) => {
      res.writeHead(401, { "Content-Type": "text/plain" }).end("nope")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const { port } = server.address() as AddressInfo
    try {
      const client = resolveInferenceProvider(remoteConfig(port))
      const failure = await expectKind(() => client.models(), "authentication")
      assert.strictEqual(failure?.status, 401)
      await expectKind(() => readText(client.fim(fimRequest)), "authentication")
    } finally {
      server.close()
    }
  })

  test("a redirect is not followed, so the token never reaches another origin", async () => {
    const received: http.IncomingHttpHeaders[] = []
    const other = http.createServer((req, res) => {
      received.push(req.headers)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ protocol: REMOTE_PROTOCOL_VERSION, models: [] }))
    })
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", () => resolve()))
    const otherPort = (other.address() as AddressInfo).port
    const redirecting = http.createServer((req, res) => {
      res.writeHead(307, { Location: `http://127.0.0.1:${otherPort}${req.url}` }).end()
    })
    await new Promise<void>((resolve) => redirecting.listen(0, "127.0.0.1", () => resolve()))
    const { port } = redirecting.address() as AddressInfo
    try {
      const client = resolveInferenceProvider(remoteConfig(port))
      const failure = await expectKind(() => client.models(), "provider-unavailable")
      assert.match(failure?.message || "", /redirect/i)
      await expectKind(() => readText(client.fim(fimRequest)), "provider-unavailable")
      await wait(50)
      assert.strictEqual(received.length, 0, "the redirected origin must see no request at all")
    } finally {
      redirecting.close()
      other.close()
    }
  })
})

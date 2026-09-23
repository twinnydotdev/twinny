/**
 * The provider boundary, proved with real adapters against local servers
 * speaking different dialects: the same consumer code runs against each.
 */
import * as assert from "assert"
import * as http from "http"
import { AddressInfo } from "net"
import * as vscode from "vscode"

import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ACTIVE_FIM_PROVIDER_STORAGE_KEY,
  API_PROVIDERS,
  EVENT_NAME
} from "../../common/constants"
import { normalizeProvider } from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"
import { ChatGeneration } from "../../extension/chat/generation"
import { Chat } from "../../extension/chat/index"
import { FileInteractionCache } from "../../extension/completion/file-interaction"
import { CompletionProvider } from "../../extension/completion/provider"
import { Embedder } from "../../extension/embeddings/embedder"
import { GenerationTracker } from "../../extension/generations"
import {
  ChatRequest,
  InferenceCapability,
  InferenceError,
  InferenceProvider,
  isInferenceError,
  ProviderRegistry,
  providerRegistry,
  readText,
  resolveInferenceProvider,
  toInferenceError
} from "../../extension/inference"
import { ExtensionBridge } from "../../extension/messaging/bridge"
import { describeProviderError } from "../../extension/providers/errors"
import { listProviderModels, testProvider } from "../../extension/providers/probe"
import { TemplateProvider } from "../../extension/templates/provider"

/* -------------------------------------------------------------------------- */
/*  Fake servers                                                              */
/* -------------------------------------------------------------------------- */

interface Received {
  path: string
  body: Record<string, unknown>
  headers: http.IncomingHttpHeaders
}

interface FakeServer {
  port: number
  received: Received[]
  close(): Promise<void>
}

type Respond = (request: Received, response: http.ServerResponse) => void

const startServer = (respond: Respond): Promise<FakeServer> =>
  new Promise((resolve) => {
    const received: Received[] = []
    const server = http.createServer((request, response) => {
      let text = ""
      request.on("data", (chunk) => (text += chunk))
      request.on("end", () => {
        const entry: Received = {
          path: request.url || "",
          body: text ? JSON.parse(text) : {},
          headers: request.headers
        }
        received.push(entry)
        respond(entry, response)
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({
        port,
        received,
        close: () =>
          new Promise((done) => {
            const closable = server as unknown as { closeAllConnections?: () => void }
            closable.closeAllConnections?.()
            server.close(() => done())
          })
      })
    })
  })

/** Ollama's `/api/generate`: one JSON object per line, `response` carries text. */
const ollamaServer = (chunks: string[]) =>
  startServer((_, response) => {
    response.writeHead(200, { "Content-Type": "application/x-ndjson" })
    for (const chunk of chunks) {
      response.write(`${JSON.stringify({ response: chunk, done: false })}\n`)
    }
    response.end(`${JSON.stringify({ response: "", done: true })}\n`)
  })

/** OpenAI's `/v1/completions`: server-sent events, text in `choices[0].text`. */
const openAiServer = (chunks: string[]) =>
  startServer((_, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    for (const chunk of chunks) {
      response.write(`data: ${JSON.stringify({ choices: [{ text: chunk }] })}\n\n`)
    }
    response.end("data: [DONE]\n\n")
  })

const errorServer = (status: number, body: string) =>
  startServer((_, response) => {
    response.writeHead(status, { "Content-Type": "application/json" })
    response.end(body)
  })

const fimConfig = (
  provider: string,
  port: number,
  apiPath: string,
  extra: Partial<TwinnyProvider> = {}
): TwinnyProvider => ({
  id: `${provider}-${port}`,
  label: `Fake ${provider}`,
  modelName: "codellama:7b-code",
  provider,
  type: "fim",
  apiHostname: "127.0.0.1",
  apiPort: port,
  apiProtocol: "http",
  apiPath,
  fimTemplate: "automatic",
  ...extra
})

const fimRequest = {
  model: "codellama:7b-code",
  prompt: "def add(a, b):\n    return",
  stop: ["<a>", "<b>", "<c>", "<d>", "<e>"],
  maxTokens: 16,
  temperature: 0
}

/* -------------------------------------------------------------------------- */
/*  Fake adapter                                                              */
/* -------------------------------------------------------------------------- */

/** An in-memory provider: what a future backend has to implement. */
class FakeChatProvider implements InferenceProvider {
  public readonly id = "fake-chat"
  public requests: ChatRequest[] = []

  constructor(
    private readonly _replies: string[],
    private readonly _capabilities: InferenceCapability[] = ["chat"]
  ) {}

  capabilities() {
    return this._capabilities
  }

  async *chat(request: ChatRequest) {
    this.requests.push(request)
    for (const content of this._replies) yield { content }
  }
}

const fakeChatConfig: TwinnyProvider = {
  id: "fake",
  label: "Fake",
  modelName: "fake-model",
  provider: "fake-chat",
  type: "chat"
}

const generations = new GenerationTracker()

const stubBridge = () => {
  const emitted: { type: string; data: unknown }[] = []
  const bridge = {
    emit: (type: string, data: unknown) => emitted.push({ type, data })
  } as unknown as ExtensionBridge
  return { bridge, emitted }
}

const contextWith = (active: Record<string, TwinnyProvider>) =>
  ({
    globalState: {
      get: (key: string) => active[key],
      update: async () => undefined
    },
    subscriptions: []
  }) as unknown as vscode.ExtensionContext

/* -------------------------------------------------------------------------- */
/*  Tests                                                                     */
/* -------------------------------------------------------------------------- */

suite("Inference layer", function () {
  this.timeout(20000)
  const servers: FakeServer[] = []
  const serve = async (server: Promise<FakeServer>) => {
    const started = await server
    servers.push(started)
    return started
  }

  teardown(async () => {
    while (servers.length) await servers.pop()!.close()
    providerRegistry.unregister("fake-chat")
  })

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
  })

  suite("registry", () => {
    test("serves every provider kind a user can configure", () => {
      for (const id of Object.values(API_PROVIDERS)) {
        assert.ok(providerRegistry.has(id), `${id} has no adapter`)
      }
    })

    test("providers advertise what they can do", () => {
      const capabilities = (provider: string, type = "chat") =>
        providerRegistry
          .resolve({ ...fakeChatConfig, provider, type })
          .capabilities()
      assert.deepStrictEqual(capabilities(API_PROVIDERS.Ollama), ["fim", "chat", "embeddings"])
      assert.deepStrictEqual(capabilities(API_PROVIDERS.Anthropic), ["chat"])
      assert.deepStrictEqual(capabilities(API_PROVIDERS.Mistral), ["chat", "fim"])
      assert.deepStrictEqual(capabilities(API_PROVIDERS.OpenAI), ["chat", "fim", "embeddings"])
    })

    test("an unknown kind fails as provider-unavailable", () => {
      assert.throws(
        () => providerRegistry.resolve({ ...fakeChatConfig, provider: "nope" }),
        (error: unknown) =>
          isInferenceError(error) && error.kind === "provider-unavailable"
      )
    })

    test("adding a backend is registering an adapter", async () => {
      const registry = new ProviderRegistry()
      const fake = new FakeChatProvider(["a", "b"])
      registry.register("fake-chat", { id: "fake", create: () => fake })
      const client = registry.resolve(fakeChatConfig)
      assert.strictEqual(
        await readText(client.chat({ model: "m", messages: [] })),
        "ab"
      )
    })
  })

  suite("unsupported capabilities", () => {
    test("are refused before any request is made", async () => {
      const chatOnly = providerRegistry.resolve({
        ...fakeChatConfig,
        provider: API_PROVIDERS.Anthropic
      })
      assert.throws(
        () => chatOnly.fim(fimRequest),
        (error: unknown) =>
          isInferenceError(error) && error.kind === "unsupported-capability"
      )
      await assert.rejects(
        providerRegistry
          .resolve({ ...fakeChatConfig, provider: API_PROVIDERS.Groq })
          .embeddings({ model: "m", input: "x" }),
        (error: unknown) =>
          isInferenceError(error) && error.kind === "unsupported-capability"
      )
    })

    test("an adapter without the method is refused the same way", () => {
      const registry = new ProviderRegistry().register("fake-chat", {
        id: "fake",
        create: () => new FakeChatProvider([], ["chat", "fim"])
      })
      assert.throws(
        () => registry.resolve(fakeChatConfig).fim(fimRequest),
        (error: unknown) =>
          isInferenceError(error) && error.kind === "unsupported-capability"
      )
    })
  })

  suite("FIM", () => {
    test("streams from two server dialects through one contract", async () => {
      const ollama = await serve(ollamaServer([" a", " +", " b"]))
      const openai = await serve(openAiServer([" a", " +", " b"]))

      const configs = [
        fimConfig(API_PROVIDERS.Ollama, ollama.port, "/api/generate"),
        fimConfig(API_PROVIDERS.LMStudio, openai.port, "/v1/completions")
      ]
      for (const config of configs) {
        const text = await readText(
          resolveInferenceProvider(config).fim(fimRequest)
        )
        assert.strictEqual(text, " a + b", config.provider)
      }

      // The translation happened inside the adapter, per dialect.
      const [toOllama] = ollama.received
      const [toOpenAi] = openai.received
      assert.strictEqual(toOllama.path, "/api/generate")
      assert.deepStrictEqual(toOllama.body.options, {
        temperature: 0,
        num_predict: 16,
        stop: fimRequest.stop
      })
      assert.strictEqual(toOpenAi.path, "/v1/completions")
      assert.strictEqual(toOpenAi.body.max_tokens, 16)
      assert.deepStrictEqual(toOpenAi.body.stop, fimRequest.stop)
      assert.strictEqual(toOpenAi.body.prompt, fimRequest.prompt)
    })

    test("the completion provider needs no provider-specific code", async () => {
      const reply = ["  return", " a + b", "\n}", "\n"]
      const ollama = await serve(ollamaServer(reply))
      const openai = await serve(openAiServer(reply))
      const configs = [
        fimConfig(API_PROVIDERS.Ollama, ollama.port, "/api/generate"),
        fimConfig(API_PROVIDERS.LMStudio, openai.port, "/v1/completions")
      ]

      for (const config of configs) {
        const document = await vscode.workspace.openTextDocument({
          content: "function add(a, b) {\n}\n",
          language: "javascript"
        })
        const editor = await vscode.window.showTextDocument(document)
        const position = new vscode.Position(0, "function add(a, b) {".length)
        editor.selection = new vscode.Selection(position, position)
        const provider = new CompletionProvider(
          generations,
          new FileInteractionCache(),
          new TemplateProvider(undefined),
          contextWith({ [ACTIVE_FIM_PROVIDER_STORAGE_KEY]: config })
        )
        const source = new vscode.CancellationTokenSource()
        try {
          const items = await provider.provideInlineCompletionItems(
            document,
            position,
            { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined },
            source.token
          )
          const text = items?.[0]?.insertText
          const inserted = typeof text === "string" ? text : text?.value ?? ""
          assert.ok(inserted.includes("a + b"), `${config.provider}: ${JSON.stringify(inserted)}`)
        } finally {
          source.dispose()
          provider.dispose()
        }
      }
      assert.strictEqual(ollama.received.length, 1)
      assert.strictEqual(openai.received.length, 1)
      assert.ok(typeof ollama.received[0].body.keep_alive !== "object")
      assert.ok("max_tokens" in openai.received[0].body)
    })
  })

  suite("chat", () => {
    test("the chat feature resolves its provider through the registry", async () => {
      const fake = new FakeChatProvider(["Hel", "lo"])
      providerRegistry.register("fake-chat", { id: "fake", create: () => fake })
      const { bridge } = stubBridge()
      const chat = new Chat(
        generations,
        undefined,
        contextWith({ [ACTIVE_CHAT_PROVIDER_STORAGE_KEY]: fakeChatConfig }),
        bridge,
        undefined
      )
      try {
        assert.strictEqual(await chat.generateSimpleCompletion("hi"), "Hello")
        assert.strictEqual(fake.requests[0].model, "fake-model")
        assert.deepStrictEqual(fake.requests[0].messages, [
          { role: "user", content: "hi" }
        ])
      } finally {
        chat.dispose()
      }
    })

    test("generation shows the reply as it streams, whole or in parts", async () => {
      for (const replies of [["Hel", "lo"], ["Hello"]]) {
        const fake = new FakeChatProvider(replies)
        const registry = new ProviderRegistry().register("fake-chat", {
          id: "fake",
          create: () => fake
        })
        const { bridge, emitted } = stubBridge()
        const generation = new ChatGeneration(bridge, generations)
        const reply = await generation.generate(
          registry.resolve(fakeChatConfig),
          { model: "m", messages: [{ role: "user", content: "hi" }] },
          fakeChatConfig
        )
        assert.strictEqual(reply, "Hello")
        const partials = emitted.filter((e) => e.type === EVENT_NAME.twinnyOnCompletion)
        assert.strictEqual(partials.length, replies.length)
        assert.ok(emitted.some((e) => e.type === EVENT_NAME.twinnyAddMessage))
      }
    })
  })

  suite("embeddings", () => {
    test("the embedder reads either server dialect", async () => {
      const ollama = await serve(
        startServer((request, response) => {
          const inputs = request.body.input as string[]
          response.end(JSON.stringify({ embeddings: inputs.map((_, i) => [i, 1]) }))
        })
      )
      const openai = await serve(
        startServer((request, response) => {
          const inputs = request.body.input as string[]
          response.end(
            JSON.stringify({
              data: inputs.map((_, index) => ({ index, embedding: [index, 2] })).reverse()
            })
          )
        })
      )
      const configs: TwinnyProvider[] = [
        { ...fimConfig(API_PROVIDERS.Ollama, ollama.port, "/api/embed"), type: "embedding" },
        { ...fimConfig(API_PROVIDERS.LMStudio, openai.port, "/v1/embeddings"), type: "embedding" }
      ]
      const expected = [
        [[0, 1], [1, 1]],
        [[0, 2], [1, 2]]
      ]
      for (const [i, config] of configs.entries()) {
        const embedder = new Embedder(() => config)
        assert.deepStrictEqual(await embedder.embed(["a", "b"], "document"), expected[i])
      }
      assert.deepStrictEqual(ollama.received[0].body.input, ["a", "b"])
      assert.strictEqual(ollama.received[0].body.model, "codellama:7b-code")
    })

    test("a provider saved without a route gets its kind's usual one", async () => {
      // A team provider's path is the gateway's base; the protocol route
      // is added to it. A fixed "/api/embed" here once sent the request to
      // /api/embed/twinny/v1/embeddings, which the gateway does not serve.
      const gateway = await serve(
        startServer((request, response) => {
          const inputs = request.body.input as string[]
          response.end(JSON.stringify({ vectors: inputs.map((_, i) => [i, 3]) }))
        })
      )
      const ollama = await serve(
        startServer((request, response) => {
          const inputs = request.body.input as string[]
          response.end(JSON.stringify({ embeddings: inputs.map((_, i) => [i, 1]) }))
        })
      )
      const cases: Array<[TwinnyProvider, string, number[][]]> = [
        [
          { ...fimConfig(API_PROVIDERS.TwinnyRemote, gateway.port, ""), type: "embedding" },
          "/twinny/v1/embeddings",
          [[0, 3], [1, 3]]
        ],
        [
          { ...fimConfig(API_PROVIDERS.Ollama, ollama.port, ""), type: "embedding" },
          "/api/embed",
          [[0, 1], [1, 1]]
        ]
      ]
      for (const [config, , expected] of cases) {
        const embedder = new Embedder(() => config)
        assert.deepStrictEqual(await embedder.embed(["a", "b"], "document"), expected)
      }
      assert.strictEqual(gateway.received[0].path, cases[0][1])
      assert.strictEqual(ollama.received[0].path, cases[1][1])
    })

    test("a busy server is waited out, and never mistaken for one wanting single strings", async () => {
      let refusals = 2
      const busy = await serve(
        startServer((request, response) => {
          if (refusals-- > 0) {
            response.writeHead(429, { "Retry-After": "1" })
            response.end(JSON.stringify({ error: { message: "The gateway is busy: 2 request(s) already running." } }))
            return
          }
          const inputs = request.body.input as string[]
          response.end(JSON.stringify({ embeddings: inputs.map((_, i) => [i, 1]) }))
        })
      )
      const config: TwinnyProvider = { ...fimConfig(API_PROVIDERS.Ollama, busy.port, "/api/embed"), type: "embedding" }
      const embedder = new Embedder(() => config, { rateLimitDelaysMs: [10, 10, 10] })
      assert.deepStrictEqual(await embedder.embed(["a", "b"], "document"), [[0, 1], [1, 1]])
      assert.strictEqual(busy.received.length, 3, "two refusals, then the answer")
      assert.ok(busy.received.every((r) => Array.isArray(r.body.input)), "the list was sent each time")

      refusals = 99
      await assert.rejects(embedder.embed(["c"], "document"), /rate limiting requests/)
    })
  })

  suite("errors", () => {
    test("provider responses are translated into the generic model", async () => {
      const cases: [number, string, InferenceError["kind"]][] = [
        [401, "{\"error\":\"invalid api key\"}", "authentication"],
        [404, "{\"error\":\"model 'x' not found, try pulling it first\"}", "model-unavailable"],
        [404, "404 page not found", "inference-failure"],
        [429, "{\"error\":\"rate limit exceeded\"}", "rate-limited"],
        [503, "upstream down", "provider-unavailable"]
      ]
      for (const [status, body, kind] of cases) {
        const server = await serve(errorServer(status, body))
        const config = fimConfig(API_PROVIDERS.Ollama, server.port, "/api/generate")
        await assert.rejects(
          readText(resolveInferenceProvider(config).fim(fimRequest)),
          (error: unknown) => {
            assert.ok(isInferenceError(error), `${status}: not an InferenceError`)
            assert.strictEqual(error.kind, kind, `${status} ${body}`)
            assert.strictEqual(error.status, status)
            assert.ok(error.message.includes(body), "keeps the server's words")
            return true
          }
        )
      }
    })

    test("a server that is not there is provider-unavailable", async () => {
      const closed = await serve(ollamaServer([]))
      const { port } = closed
      await closed.close()
      servers.pop()
      const config = fimConfig(API_PROVIDERS.Ollama, port, "/api/generate")
      await assert.rejects(
        readText(resolveInferenceProvider(config).fim(fimRequest)),
        (error: unknown) =>
          isInferenceError(error) && error.kind === "provider-unavailable"
      )
      await assert.rejects(
        resolveInferenceProvider({ ...config, type: "embedding" }).embeddings({
          model: "m",
          input: "x"
        }),
        (error: unknown) =>
          isInferenceError(error) && error.kind === "provider-unavailable"
      )
    })

    test("client-side failures classify by shape", () => {
      const timeout = new DOMException("Request timed out", "TimeoutError")
      assert.strictEqual(toInferenceError(timeout).kind, "timeout")
      const abort = new DOMException("This operation was aborted", "AbortError")
      assert.strictEqual(toInferenceError(abort).kind, "cancelled")
      const sdk = Object.assign(new Error("Request failed"), {
        response: { data: { error: { message: "Incorrect API key provided" } } }
      })
      const translated = toInferenceError(sdk)
      assert.strictEqual(translated.kind, "authentication")
      assert.ok(translated.message.includes("Incorrect API key"))
      assert.strictEqual(toInferenceError(translated), translated, "idempotent")
    })

    test("the explanation shown to the user follows the kind", () => {
      const summary = { label: "Box", modelName: "m" }
      const unsupported = new InferenceError("unsupported-capability", "no")
      assert.ok(describeProviderError(unsupported, summary).includes("cannot do this"))
      const down = new InferenceError("provider-unavailable", "fetch failed")
      assert.ok(describeProviderError(down, summary).includes("Could not connect"))
      const server = new InferenceError("provider-unavailable", "boom", { status: 502 })
      assert.ok(describeProviderError(server, summary).includes("server error (502)"))
    })

    test("the probe reports through the same model", async () => {
      const server = await serve(errorServer(401, "{\"error\":\"bad key\"}"))
      const result = await testProvider(
        fimConfig(API_PROVIDERS.Ollama, server.port, "/api/generate")
      )
      assert.strictEqual(result.success, false)
      assert.ok(result.error?.includes("API key"), result.error)
    })
  })

  suite("cancellation", () => {
    /**
     * Streams a chunk every 20ms until the client goes away. The response's
     * close event is the signal: the request's fires as soon as its body has
     * been read, which is before the handler even runs.
     */
    const endlessServer = () => {
      let closed = false
      const server = startServer((_, response) => {
        response.writeHead(200, { "Content-Type": "application/x-ndjson" })
        const timer = setInterval(() => {
          response.write(`${JSON.stringify({ response: "x", done: false })}\n`)
        }, 20)
        response.on("close", () => {
          closed = true
          clearInterval(timer)
        })
      })
      return { server, isClosed: () => closed }
    }

    const until = async (check: () => boolean, ms = 3000) => {
      const deadline = Date.now() + ms
      while (!check() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      return check()
    }

    test("aborting a stream ends the read and closes the connection", async () => {
      const { server, isClosed } = endlessServer()
      const endless = await serve(server)
      const config = fimConfig(API_PROVIDERS.Ollama, endless.port, "/api/generate")
      const controller = new AbortController()
      let chunks = 0
      await assert.rejects(
        (async () => {
          const stream = resolveInferenceProvider(config).fim(fimRequest, {
            signal: controller.signal
          })
          for await (const chunk of stream) {
            chunks += chunk.text.length
            if (chunks === 2) controller.abort()
          }
        })(),
        (error: unknown) => isInferenceError(error) && error.kind === "cancelled"
      )
      assert.strictEqual(chunks, 2)
      assert.ok(await until(isClosed), "the server saw the request close")
    })

    test("stopping the read early releases the connection too", async () => {
      const { server, isClosed } = endlessServer()
      const endless = await serve(server)
      const config = fimConfig(API_PROVIDERS.Ollama, endless.port, "/api/generate")
      for await (const chunk of resolveInferenceProvider(config).fim(fimRequest)) {
        if (chunk.text) break
      }
      assert.ok(await until(isClosed), "the server saw the request close")
    })

    test("a superseded completion request stops and returns nothing", async () => {
      const { server, isClosed } = endlessServer()
      const endless = await serve(server)
      const config = fimConfig(API_PROVIDERS.Ollama, endless.port, "/api/generate")
      const document = await vscode.workspace.openTextDocument({
        content: "function add(a, b) {\n}\n",
        language: "javascript"
      })
      await vscode.window.showTextDocument(document)
      const provider = new CompletionProvider(
        generations,
        new FileInteractionCache(),
        new TemplateProvider(undefined),
        contextWith({ [ACTIVE_FIM_PROVIDER_STORAGE_KEY]: config })
      )
      const source = new vscode.CancellationTokenSource()
      try {
        const pending = provider.provideInlineCompletionItems(
          document,
          new vscode.Position(0, "function add(a, b) {".length),
          { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined },
          source.token
        )
        await until(() => endless.received.length > 0)
        provider.abortCompletion()
        assert.strictEqual(await pending, undefined)
        assert.ok(await until(isClosed), "the server saw the request close")
      } finally {
        source.dispose()
        provider.dispose()
      }
    })

    test("the chat's stop keeps what had arrived", async () => {
      const registry = new ProviderRegistry().register("fake-chat", {
        id: "fake",
        create: () => ({
          id: "fake-chat",
          capabilities: () => ["chat"] as InferenceCapability[],
          async *chat() {
            yield { content: "part" }
            await new Promise(() => undefined) // never resolves
          }
        })
      })
      const { bridge } = stubBridge()
      const generation = new ChatGeneration(bridge, generations)
      const reply = generation.generate(
        registry.resolve(fakeChatConfig),
        { model: "m", messages: [] },
        fakeChatConfig
      )
      await until(() => false, 50)
      generation.abort()
      assert.strictEqual(await reply, "part")
    })
  })

  suite("existing configuration", () => {
    /** Entries as older builds stored them, untouched by any migration. */
    const stored: TwinnyProvider[] = [
      {
        id: "1", label: "Ollama FIM", modelName: "codellama:7b-code", provider: "ollama",
        type: "fim", apiHostname: "localhost", apiPort: 11434, apiProtocol: "http",
        apiPath: "/api/generate", fimTemplate: "automatic"
      },
      {
        id: "2", label: "Ollama chat", modelName: "llama3", provider: "ollama", type: "chat",
        apiHostname: "localhost", apiPort: 11434, apiProtocol: "http", apiPath: "/v1"
      },
      {
        id: "3", label: "LM Studio", modelName: "x", provider: "lmstudio", type: "fim",
        apiHostname: "localhost", apiPort: 1234, apiProtocol: "http", apiPath: "/v1/completions"
      },
      {
        id: "4", label: "llama.cpp", modelName: "x", provider: "llamacpp", type: "fim",
        apiHostname: "localhost", apiPort: 8080, apiProtocol: "http", apiPath: "/completion"
      },
      { id: "5", label: "Claude", modelName: "claude-sonnet-5", provider: "anthropic", type: "chat", apiKey: "k" },
      {
        id: "6", label: "OpenAI embeddings", modelName: "text-embedding-3-small", provider: "openai",
        type: "embedding", apiHostname: "api.openai.com", apiProtocol: "https", apiPath: "/v1/embeddings", apiKey: "k"
      },
      { id: "7", label: "Laptop", modelName: "x", provider: "twinny-p2p", type: "fim", deviceId: "a".repeat(64) }
    ]
    const capabilityFor: Record<string, InferenceCapability> = {
      chat: "chat",
      fim: "fim",
      embedding: "embeddings"
    }

    test("every stored entry resolves to an adapter able to do its job", () => {
      for (const entry of stored) {
        const client = resolveInferenceProvider(normalizeProvider(entry))
        assert.ok(
          client.capabilities().includes(capabilityFor[entry.type]),
          `${entry.label} cannot ${entry.type}`
        )
      }
    })

    test("a stored Ollama entry hits the same route as before", async () => {
      const server = await serve(ollamaServer([" ok"]))
      const config = normalizeProvider({
        ...stored[0],
        apiHostname: "127.0.0.1",
        apiPort: server.port
      })
      assert.strictEqual(
        await readText(resolveInferenceProvider(config).fim(fimRequest)),
        " ok"
      )
      assert.strictEqual(server.received[0].path, "/api/generate")
      assert.strictEqual(server.received[0].body.model, "codellama:7b-code")
      assert.strictEqual(server.received[0].headers.authorization, undefined)
    })

    test("an API key still travels as a bearer token", async () => {
      const server = await serve(openAiServer([" ok"]))
      const config = fimConfig(API_PROVIDERS.LMStudio, server.port, "/v1/completions", {
        apiKey: "secret"
      })
      await readText(resolveInferenceProvider(config).fim(fimRequest))
      assert.strictEqual(server.received[0].headers.authorization, "Bearer secret")
    })

    test("model listing reads each server's own route", async () => {
      const ollama = await serve(
        startServer((request, response) => {
          if (request.path === "/api/tags") {
            response.end(JSON.stringify({ models: [{ name: "b" }, { name: "a" }] }))
          } else {
            response.writeHead(404)
            response.end()
          }
        })
      )
      const listed = await listProviderModels(
        fimConfig(API_PROVIDERS.Ollama, ollama.port, "/api/generate")
      )
      assert.deepStrictEqual(listed, { models: ["a", "b"] })
      const hosted = await listProviderModels({
        ...fakeChatConfig,
        provider: API_PROVIDERS.Anthropic
      })
      assert.ok(hosted.models.length > 0 && !hosted.error)
    })
  })
})

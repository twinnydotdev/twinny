import * as assert from "assert"
import { TokenJS } from "fluency.js"
import * as http from "http"
import { AddressInfo } from "net"
import OpenAI from "openai"

import { API_PROVIDERS } from "../../common/constants"
import { TwinnyProvider } from "../../common/types"
import { buildBlockingRequest, buildStreamingRequest, hostedModels } from "../../extension/inference/adapters/fluency"
import { HostedInferenceProvider } from "../../extension/inference/adapters/hosted"
import { ChatChunk, ChatMessage } from "../../extension/inference/types"

const config = (extra: Partial<TwinnyProvider> = {}): TwinnyProvider => ({
  id: "mistral-fixture",
  label: "Mistral fixture",
  provider: API_PROVIDERS.Mistral,
  type: "chat",
  apiHostname: "api.mistral.ai",
  apiProtocol: "https",
  apiPath: "/v1",
  modelName: "mistral-not-in-the-bundled-catalogue",
  apiKey: "fixture-key",
  ...extra
})

interface ReceivedRequest {
  path: string
  body: Record<string, unknown>
  authorization?: string
}

const jsonReply = (response: http.ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json" })
  response.end(JSON.stringify(value))
}

const streamReply = (
  response: http.ServerResponse,
  parts: { delta: unknown; finishReason?: string; usage?: Record<string, number> }[]
) => {
  response.writeHead(200, { "Content-Type": "text/event-stream" })
  for (const part of parts) {
    response.write(`data: ${JSON.stringify({
      id: "fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: config().modelName,
      choices: [{ index: 0, delta: part.delta, finish_reason: part.finishReason ?? null }],
      ...(part.usage ? { usage: part.usage } : {})
    })}\n\n`)
  }
  response.end("data: [DONE]\n\n")
}

const restoreEnvironment = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

suite("Hosted Mistral models", function () {
  this.timeout(20000)
  let server: http.Server
  let port: number
  let received: ReceivedRequest[]
  let nativeUrls: string[]
  let listingSignal: AbortSignal | undefined
  let respond: (response: http.ServerResponse, request: ReceivedRequest) => void
  const originalFetch = globalThis.fetch
  const originalSdkFetch = OpenAI.prototype.fetchWithTimeout
  const originalMistralKey = process.env.MISTRAL_API_KEY
  const originalOpenAIKey = process.env.OPENAI_API_KEY

  setup(async () => {
    delete process.env.MISTRAL_API_KEY
    delete process.env.OPENAI_API_KEY
    received = []
    nativeUrls = []
    listingSignal = undefined
    respond = (response) => streamReply(response, [
      { delta: { content: "Hello" } },
      { delta: { tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] } },
      { delta: {}, finishReason: "tool_calls" }
    ])
    server = http.createServer((request, response) => {
      let body = ""
      request.on("data", (chunk) => { body += chunk })
      request.on("end", () => {
        const record = {
          path: request.url || "",
          body: body ? JSON.parse(body) : {},
          authorization: request.headers.authorization
        }
        received.push(record)
        respond(response, record)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as AddressInfo).port
    // The SDK captures its fetch implementation during import in the VS Code
    // host. Redirect at its transport boundary so request construction and SSE
    // parsing remain real with either the Node or web fetch shim.
    OpenAI.prototype.fetchWithTimeout = function (this: OpenAI, input, init, ms, controller) {
      const url = new URL(String(input))
      assert.strictEqual(url.hostname, "api.mistral.ai")
      assert.strictEqual(url.protocol, "https:")
      assert.ok(!url.port || url.port === "443")
      nativeUrls.push(url.toString())
      url.protocol = "http:"
      url.hostname = "127.0.0.1"
      url.port = String(port)
      const localInit = { ...init, agent: undefined }
      return originalSdkFetch.call(this, url.toString(), localInit, ms, controller)
    }
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname === "api.mistral.ai") {
        assert.strictEqual(url.protocol, "https:")
        assert.ok(!url.port || url.port === "443")
        nativeUrls.push(url.toString())
        if (url.pathname === "/v1/models") listingSignal = init?.signal ?? undefined
        url.protocol = "http:"
        url.hostname = "127.0.0.1"
        url.port = String(port)
      } else {
        assert.strictEqual(url.origin, `http://127.0.0.1:${port}`)
      }
      return originalFetch(input instanceof Request ? new Request(url, input) : url, init)
    }
  })

  teardown(async () => {
    OpenAI.prototype.fetchWithTimeout = originalSdkFetch
    globalThis.fetch = originalFetch
    restoreEnvironment("MISTRAL_API_KEY", originalMistralKey)
    restoreEnvironment("OPENAI_API_KEY", originalOpenAIKey)
    const closable = server as unknown as { closeAllConnections?: () => void }
    closable.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  for (const modelName of ["mistral-large-4", "zai-glm-5-3", config().modelName]) {
    test(`${modelName} reaches native chat with system text, tools and generation controls`, async () => {
      const before = hostedModels(API_PROVIDERS.Mistral)
      const extendedBefore = [...TokenJS.extendedModelList]
      process.env.MISTRAL_API_KEY = "other-mistral-fixture-key"
      process.env.OPENAI_API_KEY = "unrelated-openai-fixture-key"
      // Endpoint fields do not apply to hosted chat, even if an imported
      // configuration still contains them.
      const provider = new HostedInferenceProvider(config({
        modelName, apiHostname: "ignored.invalid", apiProtocol: "http", apiPort: 9, apiPath: "/ignored"
      }))
      const chunks: ChatChunk[] = []
      const messages: ChatMessage[] = [
        { role: "system", content: "Keep this instruction." },
        { role: "user", content: "Hello" }
      ]
      for await (const chunk of provider.chat({
        model: modelName, messages, maxTokens: 16, temperature: 0.8, think: false, reasoningEffort: "low",
        tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object", properties: {} } }]
      })) chunks.push(chunk)
      assert.strictEqual(received.length, 1)
      assert.deepStrictEqual(nativeUrls, ["https://api.mistral.ai/v1/chat/completions"])
      assert.strictEqual(received[0].authorization, "Bearer fixture-key")
      assert.strictEqual(received[0].body.model, modelName)
      assert.strictEqual(received[0].body.stream, true)
      assert.deepStrictEqual(received[0].body.messages, messages)
      assert.strictEqual(received[0].body.max_tokens, 16)
      assert.strictEqual(received[0].body.temperature, 0.4)
      assert.strictEqual(received[0].body.stream_options, undefined)
      assert.strictEqual(received[0].body.reasoning_effort, undefined)
      assert.strictEqual(received[0].body.provider, undefined)
      assert.deepStrictEqual(received[0].body.tools, [{
        type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object", properties: {} } }
      }])
      assert.strictEqual(chunks.map((chunk) => chunk.content).join(""), "Hello")
      assert.deepStrictEqual(chunks.flatMap((chunk) => chunk.toolCalls || []), [{ id: "call_fixture", name: "lookup", arguments: "{}" }])
      assert.deepStrictEqual(hostedModels(API_PROVIDERS.Mistral), before)
      assert.deepStrictEqual(TokenJS.extendedModelList, extendedBefore)
    })
  }

  test("known models keep their native request path", async () => {
    const modelName = "mistral-small-latest"
    assert.ok(hostedModels(API_PROVIDERS.Mistral).some((model) => model.id === modelName))
    for await (const chunk of new HostedInferenceProvider(config({ modelName })).chat({
      model: modelName, messages: [{ role: "user", content: "Hello" }], temperature: 0.8
    })) assert.ok(chunk)
    assert.strictEqual(received[0].body.model, modelName)
    assert.strictEqual(received[0].body.stream, true)
    assert.strictEqual(received[0].body.temperature, 0.4)
    assert.strictEqual(received[0].path, "/v1/chat/completions")
  })

  test("text-part replies remain text through the real SDK, alongside usage and finish reason", async () => {
    respond = (response) => streamReply(response, [
      { delta: { content: [{ type: "text", text: "Hello" }, { type: "text", text: " world" }] } },
      { delta: { content: [null, { type: "image_url", image_url: "ignored" }, { type: "text", text: 3 }] } },
      { delta: { content: "!" }, finishReason: "length", usage: { prompt_tokens: 3, completion_tokens: 2 } }
    ])
    const chunks: ChatChunk[] = []
    for await (const chunk of new HostedInferenceProvider(config()).chat({
      model: config().modelName, messages: [{ role: "user", content: "Hello" }]
    })) chunks.push(chunk)
    assert.ok(chunks.every((chunk) => typeof chunk.content === "string"))
    assert.strictEqual(chunks.map((chunk) => chunk.content).join(""), "Hello world!")
    assert.deepStrictEqual(chunks[chunks.length - 1].usage, { promptTokens: 3, completionTokens: 2 })
    assert.strictEqual(chunks[chunks.length - 1].finishReason, "length")
  })

  for (const modelName of ["mistral-small-latest", config().modelName]) {
    test(`${modelName} joins indexless tool fragments and respects explicit indexes`, async () => {
      respond = (response) => streamReply(response, [
        { delta: { tool_calls: [
          { id: "call_first", type: "function", function: { name: "lookup", arguments: "{" } },
          { id: "call_second", type: "function", function: { name: "count", arguments: "{" } }
        ] } },
        { delta: { tool_calls: [
          { index: 1, function: { arguments: "\"n\":" } },
          { index: 0, function: { arguments: "\"q\":" } }
        ] } },
        { delta: { tool_calls: [
          { function: { arguments: "\"x\"}" } },
          { function: { arguments: "1}" } }
        ] } },
        { delta: {}, finishReason: "tool_calls" }
      ])
      const chunks: ChatChunk[] = []
      for await (const chunk of new HostedInferenceProvider(config({ modelName })).chat({
        model: modelName, messages: [{ role: "user", content: "Look up x and count." }],
        tools: [
          { name: "lookup", description: "Lookup", parameters: { type: "object", properties: { q: { type: "string" } } } },
          { name: "count", description: "Count", parameters: { type: "object", properties: { n: { type: "number" } } } }
        ]
      })) chunks.push(chunk)
      assert.deepStrictEqual(chunks.flatMap((chunk) => chunk.toolCalls || []), [
        { id: "call_first", name: "lookup", arguments: "{\"q\":\"x\"}" },
        { id: "call_second", name: "count", arguments: "{\"n\":1}" }
      ])
    })
  }

  for (const modelName of ["mistral-small-latest", config().modelName]) {
    test(`${modelName} keeps native controls and system messages in blocking SDK requests`, async () => {
      respond = (response) => jsonReply(response, {
        id: "fixture", object: "chat.completion", created: 1, model: modelName,
        choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }]
      })
      const messages: ChatMessage[] = [
        { role: "system", content: "Keep this instruction." },
        { role: "user", content: "Hello" }
      ]
      // All currently bundled Mistral models stream. Exercise the blocking
      // builder through the real SDK without changing that shared catalogue.
      const client = new TokenJS({ baseURL: "https://api.mistral.ai/v1", apiKey: "fixture-key" })
      const reply = await client.chat.completions.create(buildBlockingRequest(config({ modelName }), messages, {
        temperature: 0.8, maxTokens: 16, think: false, reasoningEffort: "low"
      }))
      assert.strictEqual(reply.choices[0].message.content, "Hello")
      assert.strictEqual(received.length, 1)
      assert.deepStrictEqual(nativeUrls, ["https://api.mistral.ai/v1/chat/completions"])
      assert.strictEqual(received[0].authorization, "Bearer fixture-key")
      assert.strictEqual(received[0].body.model, modelName)
      assert.deepStrictEqual(received[0].body.messages, messages)
      assert.strictEqual(received[0].body.temperature, 0.4)
      assert.strictEqual(received[0].body.max_tokens, 16)
      assert.strictEqual(received[0].body.stream, undefined)
      assert.strictEqual(received[0].body.stream_options, undefined)
      assert.strictEqual(received[0].body.reasoning_effort, undefined)
      assert.strictEqual(received[0].body.provider, undefined)
    })
  }

  test("temperature conversion preserves zero, omission and other providers' values", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "Hello" }]
    for (const build of [buildStreamingRequest, buildBlockingRequest]) {
      assert.strictEqual(build(config(), messages, { temperature: 0 }).temperature, 0)
      assert.ok(!("temperature" in build(config(), messages)))
      for (const provider of [API_PROVIDERS.OpenAI, API_PROVIDERS.OpenAICompatible, API_PROVIDERS.Ollama]) {
        assert.strictEqual(build(config({ provider }), messages, { temperature: 0.8 }).temperature, 0.8)
      }
    }
  })

  for (const status of [400, 401]) {
    test(`unlisted-model chat surfaces the service's ${status} error`, async () => {
      respond = (response) => jsonReply(response, { error: { message: "fixture service rejection" } }, status)
      await assert.rejects(async () => {
        for await (const chunk of new HostedInferenceProvider(config()).chat({ model: config().modelName, messages: [] })) assert.ok(chunk)
      }, /fixture service rejection/)
      assert.strictEqual(received.length, 1)
    })
  }

  test("MISTRAL_API_KEY remains available for both native chat and discovery", async () => {
    process.env.MISTRAL_API_KEY = "mistral-environment-fixture-key"
    process.env.OPENAI_API_KEY = "unrelated-openai-fixture-key"
    const provider = new HostedInferenceProvider(config({ apiKey: "" }))
    for await (const chunk of provider.chat({ model: config().modelName, messages: [] })) assert.ok(chunk)
    respond = (response) => jsonReply(response, { data: [{ id: "env-chat", capabilities: { completion_chat: true } }] })
    assert.deepStrictEqual((await provider.models()).map((model) => model.id), ["env-chat"])
    assert.strictEqual(received.length, 2)
    assert.ok(received.every((request) => request.authorization === "Bearer mistral-environment-fixture-key"))
  })

  test("a missing Mistral key cannot borrow OPENAI_API_KEY", async () => {
    process.env.OPENAI_API_KEY = "unrelated-openai-fixture-key"
    await assert.rejects(async () => {
      for await (const chunk of new HostedInferenceProvider(config({ apiKey: "" })).chat({ model: config().modelName, messages: [] })) assert.ok(chunk)
    }, /Mistral requires an API key/)
    assert.deepStrictEqual(await new HostedInferenceProvider(config({ apiKey: "" })).models(), hostedModels(API_PROVIDERS.Mistral))
    assert.strictEqual(received.length, 0)
    assert.strictEqual(nativeUrls.length, 0)
  })

  test("authenticated listing includes new IDs and only advertised chat/FIM capabilities", async () => {
    respond = (response) => jsonReply(response, { data: [
      { id: "zai-glm-5-3", capabilities: { completion_chat: true } },
      { id: "mistral-large-4", capabilities: { completion_chat: true, completion_fim: false }, max_context_length: 32768 },
      { id: "new-fim", capabilities: { completion_chat: false, completion_fim: true } },
      { id: "mistral-large-4", capabilities: { completion_chat: true } },
      { id: "both", capabilities: { completion_chat: true, completion_fim: true } },
      { id: "embedding-only", capabilities: { completion_chat: false, completion_fim: false } },
      { id: "unknown-capabilities" },
      { id: "invalid-capabilities", capabilities: { completion_chat: "true" } }
    ] })
    const chat = await new HostedInferenceProvider(config()).models()
    const fim = await new HostedInferenceProvider(config({ type: "fim" })).models()
    assert.deepStrictEqual(chat.map((model) => model.id), ["both", "mistral-large-4", "zai-glm-5-3"])
    assert.deepStrictEqual(chat[1].capabilities, ["chat"])
    assert.strictEqual(chat[1].contextWindow, 32768)
    assert.deepStrictEqual(chat[0].capabilities, ["chat", "fim"])
    assert.deepStrictEqual(fim.map((model) => model.id), ["both", "new-fim"])
    assert.strictEqual(received.length, 2)
    assert.ok(received.every((request) => request.path === "/v1/models" && request.authorization === "Bearer fixture-key"))
  })

  test("custom FIM endpoint discovery and credentials stay at the configured server", async () => {
    respond = (response, request) => request.path === "/v1/models"
      ? jsonReply(response, { data: [{ id: "custom-fim" }] })
      : jsonReply(response, { error: "no tags endpoint" }, 404)
    const models = await new HostedInferenceProvider(config({
      type: "fim", apiHostname: "127.0.0.1", apiProtocol: "http", apiPort: port,
      apiPath: "/custom/fim", apiKey: "custom-endpoint-fixture-key"
    })).models()
    assert.deepStrictEqual(models.map((model) => model.id), ["custom-fim"])
    assert.strictEqual(nativeUrls.length, 0)
    assert.ok(received.length > 0)
    assert.ok(received.every((request) => request.authorization === "Bearer custom-endpoint-fixture-key"))
  })

  test("a successful empty account list stays empty", async () => {
    respond = (response) => jsonReply(response, { data: [] })
    assert.deepStrictEqual(await new HostedInferenceProvider(config()).models(), [])
    assert.strictEqual(received.length, 1)
  })

  test("a manual model ID can still be tried when account discovery does not list it", async () => {
    const chatReply = respond
    respond = (response) => jsonReply(response, { data: [] })
    const provider = new HostedInferenceProvider(config())
    assert.deepStrictEqual(await provider.models(), [])
    respond = chatReply
    for await (const chunk of provider.chat({
      model: config().modelName, messages: [{ role: "user", content: "Hello" }]
    })) assert.ok(chunk)
    assert.strictEqual(received.length, 2)
    assert.strictEqual(received[1].path, "/v1/chat/completions")
    assert.strictEqual(received[1].body.model, config().modelName)
  })

  test("a malformed successful list surfaces a discovery error", async () => {
    respond = (response) => jsonReply(response, { models: [] })
    await assert.rejects(new HostedInferenceProvider(config()).models(), /invalid model list/)
    assert.strictEqual(received.length, 1)
  })

  test("invalid JSON does not become an offline catalogue", async () => {
    respond = (response) => { response.setHeader("Content-Type", "application/json"); response.end("not JSON") }
    await assert.rejects(new HostedInferenceProvider(config()).models(), SyntaxError)
    assert.strictEqual(received.length, 1)
  })

  for (const status of [400, 401, 403, 429]) {
    test(`listing surfaces HTTP ${status} instead of hiding it behind offline models`, async () => {
      respond = (response) => jsonReply(response, { message: "fixture listing rejection" }, status)
      await assert.rejects(new HostedInferenceProvider(config()).models(), (error: unknown) => {
        assert.strictEqual((error as { status?: number }).status, status)
        assert.match((error as Error).message, /fixture listing rejection/)
        return true
      })
      assert.strictEqual(received.length, 1)
    })
  }

  test("temporary server failures retain the offline chat catalogue", async () => {
    respond = (response) => jsonReply(response, { message: "unavailable" }, 503)
    assert.deepStrictEqual(await new HostedInferenceProvider(config()).models(), hostedModels(API_PROVIDERS.Mistral))
    assert.strictEqual(received.length, 1)
  })

  test("transport failures retain the offline chat catalogue", async () => {
    respond = (response) => response.destroy()
    assert.deepStrictEqual(await new HostedInferenceProvider(config()).models(), hostedModels(API_PROVIDERS.Mistral))
    assert.strictEqual(received.length, 1)
  })

  test("a model-list deadline cancels the request and returns the offline catalogue", async () => {
    // Headers alone must not end the deadline: a stalled body is still a
    // stalled discovery request.
    respond = (response) => {
      response.writeHead(200, { "Content-Type": "application/json" })
      response.write("{\"data\":")
    }
    assert.deepStrictEqual(await new HostedInferenceProvider(config()).models(), hostedModels(API_PROVIDERS.Mistral))
    assert.strictEqual(received.length, 1)
    assert.strictEqual(listingSignal?.aborted, true)
  })

  test("offline listing makes no request and does not invent FIM capabilities", async () => {
    assert.deepStrictEqual(await new HostedInferenceProvider(config({ apiKey: "" })).models(), hostedModels(API_PROVIDERS.Mistral))
    assert.deepStrictEqual(await new HostedInferenceProvider(config({ apiKey: "", type: "fim" })).models(), [])
    assert.strictEqual(received.length, 0)
  })

  for (const apiKey of ["fixture-key", ""]) {
    test(`an already cancelled listing rejects ${apiKey ? "with credentials" : "before the offline fast path"}`, async () => {
      const controller = new AbortController()
      const reason = new Error("cancel model listing")
      controller.abort(reason)
      await assert.rejects(new HostedInferenceProvider(config({ apiKey })).models({ signal: controller.signal }), (error: unknown) => error === reason)
      assert.strictEqual(received.length, 0)
    })
  }

  test("cancellation during HTTP discovery rejects with the caller's reason", async () => {
    const controller = new AbortController()
    const reason = new Error("cancel active model listing")
    respond = () => controller.abort(reason)
    await assert.rejects(new HostedInferenceProvider(config()).models({ signal: controller.signal }), (error: unknown) => error === reason)
    assert.strictEqual(received.length, 1)
    assert.strictEqual(listingSignal?.aborted, true)
  })
})

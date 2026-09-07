import * as assert from "assert"

import { API_PROVIDERS, FIM_TEMPLATE_FORMAT } from "../../common/constants"
import {
  describeProviderEndpoint,
  getEndpointDefaults,
  hasConfigurableEndpoint,
  isProviderLike,
  normalizeProvider,
  summarizeProvider,
  usesEndpoint,
  validateProvider
} from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"

const ollamaChat: TwinnyProvider = {
  id: "1",
  label: "Ollama",
  modelName: "codellama:7b-instruct",
  provider: API_PROVIDERS.Ollama,
  type: "chat",
  apiHostname: "localhost",
  apiPort: 11434,
  apiProtocol: "http",
  apiPath: "/v1"
}

suite("Provider validation", () => {
  suite("normalizeProvider", () => {
    test("trims and coerces the port", () => {
      const result = normalizeProvider({
        ...ollamaChat,
        label: "  Ollama ",
        modelName: " llama3 ",
        apiPort: "11434" as unknown as number
      })
      assert.strictEqual(result.label, "Ollama")
      assert.strictEqual(result.modelName, "llama3")
      assert.strictEqual(result.apiPort, 11434)
    })

    test("unpicks a pasted URL in the hostname box", () => {
      const result = normalizeProvider({
        ...ollamaChat,
        apiHostname: "https://My-Box:8080/v1/",
        apiPort: undefined,
        apiProtocol: "http",
        apiPath: ""
      })
      assert.strictEqual(result.apiHostname, "my-box")
      assert.strictEqual(result.apiPort, 8080)
      assert.strictEqual(result.apiProtocol, "https")
      assert.strictEqual(result.apiPath, "/v1")
    })

    test("keeps an explicit path over one embedded in the hostname", () => {
      const result = normalizeProvider({
        ...ollamaChat,
        apiHostname: "localhost/ignored",
        apiPath: "/v1"
      })
      assert.strictEqual(result.apiHostname, "localhost")
      assert.strictEqual(result.apiPath, "/v1")
    })

    test("adds the leading slash and strips trailing ones from the path", () => {
      assert.strictEqual(
        normalizeProvider({ ...ollamaChat, apiPath: "v1/" }).apiPath,
        "/v1"
      )
    })

    test("drops /chat/completions from an OpenAI-compatible chat path", () => {
      assert.strictEqual(
        normalizeProvider({ ...ollamaChat, apiPath: "/v1/chat/completions" })
          .apiPath,
        "/v1"
      )
    })

    test("leaves a FIM path alone", () => {
      const fim = normalizeProvider({
        ...ollamaChat,
        type: "fim",
        apiPath: "/api/generate"
      })
      assert.strictEqual(fim.apiPath, "/api/generate")
      assert.strictEqual(fim.fimTemplate, FIM_TEMPLATE_FORMAT.automatic)
    })

    test("removes FIM-only fields from other types", () => {
      const result = normalizeProvider({
        ...ollamaChat,
        fimTemplate: "codellama",
        repositoryLevel: true
      })
      assert.strictEqual(result.fimTemplate, undefined)
      assert.strictEqual(result.repositoryLevel, undefined)
    })

    test("falls back to chat for an unknown type", () => {
      assert.strictEqual(
        normalizeProvider({ ...ollamaChat, type: "nonsense" }).type,
        "chat"
      )
    })
  })

  suite("validateProvider", () => {
    test("accepts a sensible local provider", () => {
      const { valid, errors } = validateProvider(ollamaChat)
      assert.ok(valid, JSON.stringify(errors))
    })

    test("requires a label and a model", () => {
      const { errors } = validateProvider({
        ...ollamaChat,
        label: "",
        modelName: ""
      })
      assert.ok(errors.label)
      assert.ok(errors.modelName)
    })

    test("requires a hostname for self-hosted servers", () => {
      const { errors } = validateProvider({ ...ollamaChat, apiHostname: "" })
      assert.ok(errors.apiHostname)
    })

    test("does not require a hostname for a hosted chat API", () => {
      const { valid } = validateProvider({
        ...ollamaChat,
        provider: API_PROVIDERS.Anthropic,
        apiHostname: "",
        apiPort: undefined,
        apiPath: "",
        apiKey: "sk-ant"
      })
      assert.ok(valid)
    })

    test("rejects a URL typed as the hostname", () => {
      const { errors } = validateProvider({
        ...ollamaChat,
        apiHostname: "http://localhost"
      })
      assert.ok(errors.apiHostname)
    })

    test("rejects an out-of-range port", () => {
      assert.ok(validateProvider({ ...ollamaChat, apiPort: 0 }).errors.apiPort)
      assert.ok(validateProvider({ ...ollamaChat, apiPort: 70000 }).errors.apiPort)
      assert.ok(validateProvider({ ...ollamaChat, apiPort: 1.5 }).errors.apiPort)
    })

    test("rejects a port that is not a number", () => {
      const normalized = normalizeProvider({
        ...ollamaChat,
        apiPort: "11a" as unknown as number
      })
      assert.ok(validateProvider(normalized).errors.apiPort)
    })

    test("rejects a path without a leading slash", () => {
      assert.ok(validateProvider({ ...ollamaChat, apiPath: "v1" }).errors.apiPath)
    })

    test("refuses FIM on a chat-only hosted API", () => {
      const { errors } = validateProvider({
        ...ollamaChat,
        provider: API_PROVIDERS.Anthropic,
        type: "fim",
        apiHostname: "api.anthropic.com"
      })
      assert.ok(errors.provider)
    })

    test("warns rather than fails when a hosted key is blank", () => {
      const { valid, warnings } = validateProvider({
        ...ollamaChat,
        provider: API_PROVIDERS.OpenAI,
        apiKey: ""
      })
      assert.ok(valid)
      assert.ok(warnings.some((w) => /API key/.test(w)))
    })

    test("warns about the classic Ollama path mix-ups", () => {
      const chat = validateProvider({ ...ollamaChat, apiPath: "/api/generate" })
      assert.ok(chat.warnings.some((w) => /\/v1/.test(w)))
      const fim = validateProvider({
        ...ollamaChat,
        type: "fim",
        apiPath: "/v1"
      })
      assert.ok(fim.warnings.some((w) => /\/api\/generate/.test(w)))
    })

    test("warns when a FIM provider has no path", () => {
      const { warnings } = validateProvider({
        ...ollamaChat,
        type: "fim",
        apiPath: ""
      })
      assert.ok(warnings.some((w) => /api\/generate/.test(w)))
    })
  })

  suite("endpoint helpers", () => {
    test("knows the usual routes for the local servers", () => {
      assert.strictEqual(
        getEndpointDefaults(API_PROVIDERS.Ollama, "fim")?.apiPath,
        "/api/generate"
      )
      assert.strictEqual(
        getEndpointDefaults(API_PROVIDERS.LMStudio, "chat")?.apiPort,
        1234
      )
      assert.strictEqual(getEndpointDefaults(API_PROVIDERS.Anthropic, "chat"), undefined)
    })

    test("hosted chat ignores the endpoint fields; everything else uses them", () => {
      assert.strictEqual(usesEndpoint(API_PROVIDERS.OpenAI, "chat"), false)
      assert.strictEqual(usesEndpoint(API_PROVIDERS.OpenAI, "embedding"), true)
      assert.strictEqual(usesEndpoint(API_PROVIDERS.Ollama, "chat"), true)
    })

    test("describes the URL a chat request will really hit", () => {
      assert.strictEqual(
        describeProviderEndpoint(ollamaChat),
        "http://localhost:11434/v1/chat/completions"
      )
      assert.strictEqual(
        describeProviderEndpoint({
          ...ollamaChat,
          type: "fim",
          apiPath: "/api/generate"
        }),
        "http://localhost:11434/api/generate"
      )
      assert.strictEqual(
        describeProviderEndpoint({
          ...ollamaChat,
          provider: API_PROVIDERS.Anthropic
        }),
        ""
      )
    })

    test("summarises a provider in one line", () => {
      assert.strictEqual(
        summarizeProvider(ollamaChat),
        "codellama:7b-instruct · localhost:11434"
      )
      assert.strictEqual(
        summarizeProvider({
          ...ollamaChat,
          provider: API_PROVIDERS.OpenAI,
          modelName: "gpt-4.1"
        }),
        "gpt-4.1 · openai"
      )
    })
  })

  suite("P2P device providers", () => {
    const device = "ab".repeat(32)
    const p2p = {
      id: "",
      label: "Home RTX",
      modelName: "qwen3:30b",
      provider: API_PROVIDERS.TwinnyP2P,
      type: "chat",
      deviceId: device.toUpperCase()
    }

    test("normalises to a device id and no address", () => {
      const normalized = normalizeProvider({
        ...p2p,
        apiHostname: "https://should-not-stay:1234/v1",
        apiKey: "secret"
      })
      assert.strictEqual(normalized.deviceId, device)
      assert.strictEqual(normalized.apiHostname, "")
      assert.strictEqual(normalized.apiPort, undefined)
      assert.strictEqual(normalized.apiPath, "")
      assert.strictEqual(normalized.apiKey, "")
    })

    test("is valid without an endpoint and invalid without a device", () => {
      assert.ok(validateProvider(normalizeProvider(p2p)).valid)
      const { valid, errors } = validateProvider(
        normalizeProvider({ ...p2p, deviceId: "nope" })
      )
      assert.strictEqual(valid, false)
      assert.match(errors.deviceId || "", /Pair a device/)
    })

    test("has no configurable endpoint but does use one", () => {
      assert.strictEqual(hasConfigurableEndpoint(API_PROVIDERS.TwinnyP2P, "chat"), false)
      assert.strictEqual(usesEndpoint(API_PROVIDERS.TwinnyP2P, "chat"), true)
      assert.strictEqual(describeProviderEndpoint(normalizeProvider(p2p)), "")
      assert.strictEqual(summarizeProvider(normalizeProvider(p2p)), "qwen3:30b · P2P device")
    })
  })

  suite("isProviderLike", () => {
    test("accepts the exported shape and rejects junk", () => {
      assert.ok(isProviderLike(ollamaChat))
      assert.ok(!isProviderLike(null))
      assert.ok(!isProviderLike({ label: "x" }))
      assert.ok(!isProviderLike("ollama"))
    })
  })
})

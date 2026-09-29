import * as assert from "assert"

import { API_PROVIDERS, FIM_TEMPLATE_FORMAT } from "../../common/constants"
import { pickModel, pickModelStrict } from "../../common/model-pick"
import {
  candidateList,
  dedupeServers,
  DEFAULT_LOCAL_CANDIDATES,
  DiscoveredServer,
  providersForServer
} from "../../common/provider-discovery"

const server = (
  overrides: Partial<DiscoveredServer> = {}
): DiscoveredServer => ({
  provider: API_PROVIDERS.Ollama,
  label: "Ollama",
  apiHostname: "localhost",
  apiPort: 11434,
  apiProtocol: "http",
  models: ["llama3:latest", "qwen2.5-coder:7b", "nomic-embed-text:latest"],
  ...overrides
})

let nextId = 0
const makeId = () => `id-${++nextId}`

suite("Provider discovery", () => {
  suite("candidates", () => {
    test("covers every local server, Ollama first", () => {
      const providers = DEFAULT_LOCAL_CANDIDATES.map((c) => c.provider)
      assert.strictEqual(providers[0], API_PROVIDERS.Ollama)
      for (const p of [
        API_PROVIDERS.LMStudio,
        API_PROVIDERS.LlamaCpp,
        API_PROVIDERS.OpenAICompatible
      ]) {
        assert.ok(providers.includes(p), `missing ${p}`)
      }
    })

    test("a configured Ollama on a custom port is tried in addition", () => {
      const extra = {
        provider: API_PROVIDERS.Ollama,
        apiHostname: "localhost",
        apiPort: 11500,
        apiProtocol: "http"
      }
      const list = candidateList([extra])
      assert.deepStrictEqual(list[0], extra)
      assert.strictEqual(list.length, DEFAULT_LOCAL_CANDIDATES.length + 1)
    })

    test("a configured Ollama on the default port replaces the default", () => {
      const extra = {
        provider: API_PROVIDERS.Ollama,
        apiHostname: "localhost",
        apiPort: 11434,
        apiProtocol: "http"
      }
      const list = candidateList([extra])
      assert.strictEqual(list.length, DEFAULT_LOCAL_CANDIDATES.length)
      assert.strictEqual(list[0].provider, API_PROVIDERS.Ollama)
    })

    test("two entries on the same port collapse to the preferred one", () => {
      const llama = server({
        provider: API_PROVIDERS.LlamaCpp,
        label: "llama.cpp",
        apiPort: 8080
      })
      const generic = server({
        provider: API_PROVIDERS.OpenAICompatible,
        label: "OpenAI-compatible server",
        apiPort: 8080
      })
      assert.deepStrictEqual(dedupeServers([llama, generic]), [llama])
    })
  })

  suite("providersForServer", () => {
    test("makes one provider per job the server has a model for", () => {
      const providers = providersForServer(server(), makeId)
      assert.deepStrictEqual(
        providers.map((p) => [p.type, p.modelName]),
        [
          ["chat", "llama3:latest"],
          ["fim", "qwen2.5-coder:7b"],
          ["embedding", "nomic-embed-text:latest"]
        ]
      )
    })

    test("uses the server's own routes for each job", () => {
      const providers = providersForServer(server(), makeId)
      const byType = Object.fromEntries(providers.map((p) => [p.type, p]))
      assert.strictEqual(byType.chat.apiPath, "/v1")
      assert.strictEqual(byType.fim.apiPath, "/api/generate")
      assert.strictEqual(byType.fim.fimTemplate, FIM_TEMPLATE_FORMAT.automatic)
      assert.strictEqual(byType.embedding.apiPath, "/api/embed")
      assert.strictEqual(byType.chat.label, "Ollama")
      assert.strictEqual(byType.fim.label, "Ollama FIM")
    })

    test("LM Studio gets OpenAI-style routes", () => {
      const providers = providersForServer(
        server({
          provider: API_PROVIDERS.LMStudio,
          label: "LM Studio",
          apiPort: 1234
        }),
        makeId
      )
      const fim = providers.find((p) => p.type === "fim")
      assert.strictEqual(fim?.apiPath, "/v1/completions")
      assert.strictEqual(fim?.apiPort, 1234)
    })

    test("leaves a job out rather than guess a wrong model", () => {
      const providers = providersForServer(
        server({ models: ["llama3:latest"] }),
        makeId
      )
      assert.deepStrictEqual(
        providers.map((p) => p.type),
        ["chat"]
      )
    })

    test("an embedding-only server backs only embeddings", () => {
      const providers = providersForServer(
        server({ models: ["nomic-embed-text:latest"] }),
        makeId
      )
      assert.deepStrictEqual(
        providers.map((p) => p.type),
        ["embedding"]
      )
    })

    test("every provider gets a distinct id", () => {
      const ids = providersForServer(server(), makeId).map((p) => p.id)
      assert.strictEqual(new Set(ids).size, ids.length)
    })
  })

  suite("pickModel", () => {
    const models = ["nomic-embed-text", "llama3", "codellama:7b-code"]

    test("lenient picking always returns something for a job", () => {
      assert.strictEqual(pickModel(models, "chat"), "llama3")
      assert.strictEqual(pickModel(models, "fim"), "codellama:7b-code")
      assert.strictEqual(pickModel(models, "embedding"), "nomic-embed-text")
      assert.strictEqual(pickModel(["llama3"], "fim"), "llama3")
      assert.strictEqual(pickModel(["llama3"], "embedding"), "llama3")
    })

    test("chat prefers an instruct model over a base code model", () => {
      const list = ["codellama:7b-code", "llama3.2:latest", "codellama:7b-instruct"]
      assert.strictEqual(pickModel(list, "chat"), "codellama:7b-instruct")
      assert.strictEqual(pickModelStrict(list, "chat"), "codellama:7b-instruct")
      assert.strictEqual(
        pickModel(["codellama:7b-code", "llama3.2:latest"], "chat"),
        "llama3.2:latest"
      )
      assert.strictEqual(pickModel(["codellama:7b-code"], "chat"), "codellama:7b-code")
    })

    test("strict picking returns nothing when no model fits", () => {
      assert.strictEqual(pickModelStrict(["llama3"], "fim"), undefined)
      assert.strictEqual(pickModelStrict(["llama3"], "embedding"), undefined)
      assert.strictEqual(pickModelStrict(["nomic-embed-text"], "chat"), undefined)
      assert.strictEqual(pickModelStrict(models, "fim"), "codellama:7b-code")
    })
  })
})

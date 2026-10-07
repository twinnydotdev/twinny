import * as assert from "node:assert"
import * as http from "node:http"
import { AddressInfo } from "node:net"
import { test } from "node:test"

import { API_PROVIDERS } from "../../common/constants"
import { TwinnyProvider } from "../../common/types"
import {
  isInferenceError,
  ProviderRegistry,
  readText
} from "../../extension/inference"
import {
  ChatGPTPlanInferenceProvider
} from "../../extension/inference/adapters/chatgpt-plan"

interface Received {
  method?: string
  path?: string
  auth?: string
  body?: Record<string, unknown>
}

const sse = (events: object[]) =>
  events
    .map(
      (event) =>
        `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(
          event
        )}\n\n`
    )
    .join("")

const serve = async (
  handler: (
    request: Received,
    response: http.ServerResponse
  ) => void
) => {
  const received: Received[] = []
  const server = http.createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => (raw += chunk))
    request.on("end", () => {
      let body: Record<string, unknown> | undefined
      if (raw) body = JSON.parse(raw) as Record<string, unknown>
      const item = {
        method: request.method,
        path: request.url,
        auth: request.headers.authorization,
        body
      }
      received.push(item)
      handler(item, response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    received,
    models: `http://127.0.0.1:${port}/v1/models`,
    responses: `http://127.0.0.1:${port}/v1/responses`,
    close: () => server.close()
  }
}

const config: TwinnyProvider = {
  id: "plan",
  label: "ChatGPT Plan",
  modelName: "gpt-test",
  provider: API_PROVIDERS.ChatGPTPlan,
  type: "fim"
}

const access = {
  async getAccessToken() {
    return "oauth-test-token"
  }
}

test("ChatGPT Plan lists visible models and streams a structured completion", async () => {
  const fake = await serve((request, response) => {
    if (request.path === "/v1/models") {
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(
        JSON.stringify({
          models: [
            {
              slug: "gpt-test",
              display_name: "GPT Test",
              visibility: "list"
            },
            {
              slug: "hidden",
              display_name: "Hidden",
              visibility: "internal"
            }
          ]
        })
      )
      return
    }

    response.writeHead(200, { "Content-Type": "text/event-stream" })
    response.end(
      sse([
        { type: "response.output_text.delta", delta: "await repo." },
        { type: "response.output_text.delta", delta: "findById(id)" },
        {
          type: "response.completed",
          response: {
            status: "completed",
            usage: { input_tokens: 42, output_tokens: 6 }
          }
        }
      ])
    )
  })

  try {
    const provider = new ChatGPTPlanInferenceProvider(config, access, {
      models: fake.models,
      responses: fake.responses
    })
    const models = await provider.models()
    assert.deepStrictEqual(models, [
      {
        id: "gpt-test",
        name: "GPT Test",
        capabilities: ["fim"]
      }
    ])

    const text = await readText(
      provider.fim({
        model: "gpt-test",
        prompt: "<PRE>legacy<SUF>legacy<MID>",
        prefix: "const user = ",
        suffix: ";\nreturn user",
        maxTokens: 512,
        temperature: 0.2,
        stop: ["</s>"],
        context: {
          language: "typescript",
          fileName: "src/user.ts",
          repoName: "example",
          prefix: "const user = ",
          suffix: ";\nreturn user",
          files: [
            {
              name: "src/repository.ts",
              text: "export const repo = { findById(id: string) {} }"
            }
          ]
        }
      })
    )
    assert.strictEqual(text, "await repo.findById(id)")

    const modelRequest = fake.received[0]
    assert.strictEqual(modelRequest.auth, "Bearer oauth-test-token")

    const inference = fake.received[1]
    assert.strictEqual(inference.path, "/v1/responses")
    assert.strictEqual(inference.auth, "Bearer oauth-test-token")
    assert.strictEqual(inference.body?.store, false)
    assert.strictEqual(inference.body?.stream, true)
    assert.strictEqual(inference.body?.temperature, undefined)
    assert.strictEqual(inference.body?.max_output_tokens, undefined)
    assert.strictEqual(inference.body?.top_p, undefined)
    assert.strictEqual(inference.body?.previous_response_id, undefined)

    const input = JSON.stringify(inference.body?.input)
    assert.ok(input.includes("src/repository.ts"))
    assert.ok(input.includes("const user = "))
    assert.ok(input.includes("return user"))
    assert.ok(!input.includes("<PRE>legacy"))
  } finally {
    fake.close()
  }
})

test("ChatGPT Plan usage-limit terminal failures become rate-limited errors", async () => {
  const fake = await serve((request, response) => {
    if (request.path === "/v1/responses") {
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      response.end(
        sse([
          { type: "response.output_text.delta", delta: "partial" },
          {
            type: "response.failed",
            response: {
              status: "failed",
              error: {
                code: "subscription_sharing_usage_limit_exceeded",
                message: "Plan usage limit reached"
              }
            }
          }
        ])
      )
      return
    }
    response.writeHead(404)
    response.end()
  })

  try {
    const registry = new ProviderRegistry().register(
      API_PROVIDERS.ChatGPTPlan,
      {
        id: "chatgpt-plan-test",
        create: (providerConfig) =>
          new ChatGPTPlanInferenceProvider(providerConfig, access, {
            models: fake.models,
            responses: fake.responses
          })
      }
    )

    await assert.rejects(
      readText(
        registry.resolve(config).fim({
          model: "gpt-test",
          prompt: "x",
          context: {
            prefix: "const x = ",
            suffix: ";"
          }
        })
      ),
      (error: unknown) =>
        isInferenceError(error) && error.kind === "rate-limited"
    )
  } finally {
    fake.close()
  }
})


test("ChatGPT Plan usage-unavailable failures stay transient provider errors", async () => {
  const fake = await serve((request, response) => {
    if (request.path === "/v1/responses") {
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      response.end(
        sse([
          {
            type: "response.failed",
            response: {
              status: "failed",
              error: {
                code: "subscription_sharing_usage_unavailable",
                message: "Usage availability could not be checked"
              }
            }
          }
        ])
      )
      return
    }
    response.writeHead(404)
    response.end()
  })

  try {
    const registry = new ProviderRegistry().register(
      API_PROVIDERS.ChatGPTPlan,
      {
        id: "chatgpt-plan-test",
        create: (providerConfig) =>
          new ChatGPTPlanInferenceProvider(providerConfig, access, {
            models: fake.models,
            responses: fake.responses
          })
      }
    )

    await assert.rejects(
      readText(
        registry.resolve(config).fim({
          model: "gpt-test",
          prompt: "x",
          context: {
            prefix: "const x = ",
            suffix: ";"
          }
        })
      ),
      (error: unknown) =>
        isInferenceError(error) && error.kind === "provider-unavailable"
    )
  } finally {
    fake.close()
  }
})

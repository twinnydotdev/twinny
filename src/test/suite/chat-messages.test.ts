import * as assert from "assert"

import { API_PROVIDERS } from "../../common/constants"
import { ChatCompletionMessage } from "../../common/types"
import { buildChatTurn } from "../../extension/chat/turn"
import {
  buildBlockingRequest,
  buildStreamingRequest,
  getFluencyProvider,
  supportsStreaming
} from "../../extension/inference/adapters/fluency"

const provider = {
  id: "1",
  label: "Ollama",
  modelName: "llama3",
  provider: API_PROVIDERS.Ollama,
  type: "chat"
}

suite("Chat messages", () => {
  test("routes local servers through the OpenAI-compatible client", () => {
    assert.strictEqual(getFluencyProvider(provider), "openai-compatible")
    assert.strictEqual(
      getFluencyProvider({ ...provider, provider: API_PROVIDERS.Anthropic }),
      "anthropic"
    )
  })

  test("streams unless the catalogue says the model cannot", () => {
    assert.strictEqual(supportsStreaming(provider), true)
  })

  test("the blocking request leaves the system prompt out", () => {
    const messages: ChatCompletionMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "u" }
    ]
    assert.strictEqual(buildBlockingRequest(provider, messages).messages.length, 1)
    const streaming = buildStreamingRequest(provider, messages)
    assert.strictEqual(streaming.messages.length, 2)
    assert.strictEqual(streaming.stream, true)
  })

  test("text-only parts go to the provider as a plain string; images keep their parts", () => {
    const plain = { role: "user", content: [{ type: "text", text: "Hi" }] } as ChatCompletionMessage
    const withImage = {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
      ]
    } as ChatCompletionMessage
    const request = buildStreamingRequest(provider, [plain, withImage])
    assert.strictEqual(request.messages[0].content, "Hi", "Mistral rejects a parts list for plain text")
    assert.ok(Array.isArray(request.messages[1].content))
    assert.strictEqual((request.messages[1].content as Array<{ type: string }>).length, 2)
    const blocking = buildBlockingRequest(provider, [plain])
    assert.strictEqual(blocking.messages[0].content, "Hi")
  })

  test("sends no twinny-only fields to the provider", async () => {
    const turn = await buildChatTurn(
      [
        { role: "user", content: "Explain", id: "m-1", prompt: "Explain this code" },
        { role: "assistant", content: "It adds.", id: "m-2", context: { stage: "done", query: "q", threshold: 0, hits: [], nearMisses: [] } },
        { role: "user", content: "<p>and?</p>", id: "m-3" }
      ] as ChatCompletionMessage[],
      { systemPrompt: async () => "s", additionalContext: async () => "" }
    )
    const request = buildStreamingRequest(provider, turn)
    assert.ok(!("id" in request))
    for (const message of request.messages) {
      assert.deepStrictEqual(Object.keys(message).sort(), ["content", "role"])
    }
  })
})

import * as assert from "assert"

import { API_PROVIDERS } from "../../common/constants"
import { ChatCompletionMessage } from "../../common/types"
import {
  buildBlockingRequest,
  buildStreamingRequest,
  cleanMessageHtml,
  getFluencyProvider,
  supportsStreaming,
  toApiMessage
} from "../../extension/chat/messages"

const provider = {
  id: "1",
  label: "Ollama",
  modelName: "llama3",
  provider: API_PROVIDERS.Ollama,
  type: "chat"
}

suite("Chat messages", () => {
  test("strips composer markup down to the text the user meant", () => {
    const html =
      "<p>Look at <span data-type=\"mention\">src/a.ts</span> &amp; fix &lt;T&gt; @workspace</p><img src=\"x\">"
    const text = cleanMessageHtml(html)
    assert.ok(text.includes("src/a.ts"))
    assert.ok(text.includes("& fix <T>"))
    assert.ok(!text.includes("@workspace"))
    assert.ok(!text.includes("<img"))
  })

  test("keeps a text-only message verbatim", () => {
    const message = toApiMessage({ role: "user", content: "<b>hi</b>" })
    assert.deepStrictEqual(message.content, [{ type: "text", text: "<b>hi</b>" }])
  })

  test("adds image parts and cleans the text when images are attached", () => {
    const message = toApiMessage({
      role: "user",
      content: "<p>what is this</p>",
      images: ["data:image/png;base64,AAA"]
    })
    const parts = message.content as unknown as { type: string; text?: string }[]
    assert.strictEqual(parts.length, 2)
    assert.strictEqual(parts[0].type, "text")
    assert.strictEqual(parts[1].type, "image_url")
    // Only images and mention spans are stripped; other markup is kept.
    assert.strictEqual(parts[0].text, "<p>what is this</p>")
  })

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
    const streaming = buildStreamingRequest(provider, messages, "conv-1")
    assert.strictEqual(streaming.messages.length, 2)
    assert.strictEqual(streaming.id, "conv-1")
    assert.strictEqual(streaming.stream, true)
  })
})

import * as assert from "assert"

import { ChatCompletionMessage } from "../../common/types"
import { buildChatTurn, ContextSource, TurnContext } from "../../extension/chat/turn"

type Part = { type: string; text?: string; image_url?: { url: string } }

const parts = (message: ChatCompletionMessage) => message.content as unknown as Part[]
const textOf = (message: ChatCompletionMessage) =>
  typeof message.content === "string" ? message.content : parts(message)[0].text

/** A context that records what it was asked and answers with `extra`. */
const fakeContext = (extra = "") => {
  const asked: { question: string; sources: Set<ContextSource>; history: ChatCompletionMessage[] }[] = []
  const context: TurnContext = {
    systemPrompt: async () => "You are twinny.",
    additionalContext: async (question, sources, history) => {
      asked.push({ question, sources, history })
      return extra
    }
  }
  return { context, asked }
}

suite("Chat turn", () => {
  test("a text-only user turn arrives as the plain text the user meant", async () => {
    const { context, asked } = fakeContext()
    const turn = await buildChatTurn(
      [
        {
          role: "user",
          content:
            "Look at <span class=\"mention\" data-type=\"mention\" data-id=\"src/a.ts\" data-label=\"a.ts\">@a.ts</span> " +
            "&amp; fix &lt;T&gt; <span data-type=\"mention\" data-id=\"workspace\">@workspace</span><br>then test it"
        }
      ],
      context
    )
    assert.strictEqual(turn[0].content, "You are twinny.")
    assert.strictEqual(textOf(turn[1]), "Look at @a.ts & fix <T>\nthen test it")
    assert.strictEqual(asked[0].question, "Look at @a.ts & fix <T>\nthen test it")
    assert.deepStrictEqual([...asked[0].sources], ["workspace"])
  })

  test("attached code keeps its angle brackets, with or without an image", async () => {
    const code = "Attached code:\n\n```ts\nfunction first<T>(xs: T[]): T { return xs[0] }\n```"
    for (const images of [undefined, ["data:image/png;base64,AAAA"]]) {
      const { context } = fakeContext(code)
      const turn = await buildChatTurn(
        [{ role: "user", content: "what does this do?", images }],
        context
      )
      const last = turn[turn.length - 1]
      assert.strictEqual(textOf(last), `what does this do?\n\n${code}`)
      assert.strictEqual(parts(last).length, images ? 2 : 1)
    }
  })

  test("history: user turns as text, replies verbatim, a feature's prompt in place of what it showed", async () => {
    const { context, asked } = fakeContext()
    const report = { stage: "done" as const, query: "q", threshold: 0, hits: [], nearMisses: [] }
    const turn = await buildChatTurn(
      [
        { role: "user", content: "Fix the failing command", prompt: "Why does it fail?\n\nAttached code:\n\na.ts" },
        { role: "assistant", content: "Use `Array<T>` here.", context: report },
        { role: "user", content: "<p>why <span data-type=\"mention\">@git</span>?</p>" },
        { role: "assistant", content: "Because." },
        { role: "user", content: "and <span data-type=\"mention\">@problems</span>" }
      ],
      context
    )
    assert.deepStrictEqual(turn.map(textOf), [
      "You are twinny.",
      "Why does it fail?\n\nAttached code:\n\na.ts",
      "Use `Array<T>` here.",
      "why ?",
      "Because.",
      "and"
    ])
    assert.deepStrictEqual([...asked[0].sources], ["problems"])
    // The search follows up on the history as the model sees it, sources included.
    assert.strictEqual(asked[0].history[2].content, "why ?")
    assert.strictEqual(asked[0].history[1].context, report)
  })

  test("the composer's code blocks become fenced code", async () => {
    const { context } = fakeContext()
    const turn = await buildChatTurn(
      [{ role: "user", content: "<p>Explain</p><pre><code>if (a &lt; b) {}\n</code></pre>" }],
      context
    )
    assert.strictEqual(textOf(turn[1]), "Explain\n\n```\nif (a < b) {}\n```")
  })
})

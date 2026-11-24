import * as assert from "assert"
import * as vscode from "vscode"

import { Conversation } from "../../common/types"
import { Chat } from "../../extension/chat"
import { ConversationHistory } from "../../extension/chat/conversation-history"
import { ExtensionBridge } from "../../extension/messaging/bridge"

const memento = () => {
  const values = new Map<string, unknown>()
  return {
    get: (key: string) => values.get(key),
    update: async (key: string, value: unknown) => {
      values.set(key, value)
    }
  }
}

const stubBridge = {
  handleAll: () => stubBridge,
  emit: () => undefined
} as unknown as ExtensionBridge

const stubChat = { replying: false } as unknown as Chat

/** One VS Code window: global state is shared, workspace state is its own. */
const openWindow = (globalState: ReturnType<typeof memento>) => {
  const context = {
    globalState,
    workspaceState: memento(),
    subscriptions: [] as vscode.Disposable[]
  } as unknown as vscode.ExtensionContext
  return new ConversationHistory(context, stubBridge, stubChat)
}

const conversation = (id: string, text: string): Conversation => ({
  id,
  title: id,
  messages: [
    { role: "user", content: text },
    { role: "assistant", content: `${text} answered` },
    { role: "user", content: `${text} again` }
  ]
})

suite("Conversation history", () => {
  test("each window keeps its own open conversation", async () => {
    const shared = memento()
    const first = openWindow(shared)
    const second = openWindow(shared)

    first.updateConversation(conversation("a", "project one"))
    second.updateConversation(conversation("b", "project two"))

    assert.strictEqual(first.getActiveConversation()?.id, "a")
    assert.strictEqual(second.getActiveConversation()?.id, "b")
  })

  test("a reply saved in one window does not land in another window's conversation", async () => {
    const shared = memento()
    const first = openWindow(shared)
    const second = openWindow(shared)

    first.updateConversation(conversation("a", "project one"))
    second.updateConversation(conversation("b", "project two"))

    const reply = conversation("a", "project one").messages.concat({
      role: "assistant",
      content: "changed project one"
    })
    await first.saveConversation({ messages: reply })

    const saved = first.getConversations() ?? {}
    assert.deepStrictEqual(saved.a.messages, reply)
    assert.deepStrictEqual(saved.b.messages, conversation("b", "project two").messages)
  })
})

import * as assert from "assert"
import * as vscode from "vscode"

import { EVENT_NAME } from "../../common/constants"
import { TwinnyProvider } from "../../common/types"
import { ChatGeneration } from "../../extension/chat/generation"
import { FileInteractionCache } from "../../extension/completion/file-interaction"
import { CompletionProvider } from "../../extension/completion/provider"
import { GenerationState, GenerationTracker } from "../../extension/generations"
import { InferenceClient, InferenceError } from "../../extension/inference"
import { ExtensionBridge } from "../../extension/messaging/bridge"
import { TemplateProvider } from "../../extension/templates/provider"

const provider = {
  id: "fake",
  label: "Fake",
  modelName: "fake-model",
  provider: "fake-chat",
  type: "chat"
} as TwinnyProvider

const stubBridge = () => {
  const emitted: string[] = []
  const bridge = { emit: (type: string) => emitted.push(type) } as unknown as ExtensionBridge
  return { bridge, emitted }
}

/** A chat that sends one chunk and then waits until it is stopped. */
const hangingChat = () => {
  let started!: () => void
  const running = new Promise<void>((resolve) => (started = resolve))
  const client = {
    async *chat(_request: unknown, options?: { signal?: AbortSignal }) {
      yield { content: "partial" }
      started()
      await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve))
      throw new InferenceError("cancelled", "The request was cancelled.")
    }
  } as unknown as InferenceClient
  return { client, running }
}

const request = { model: "m", messages: [{ role: "user" as const, content: "hi" }] }

suite("Generation tracker", () => {
  test("busy while any run is live; stoppable only for chat and edit", () => {
    const tracker = new GenerationTracker()
    const seen: GenerationState[] = []
    tracker.onDidChange((state) => seen.push(state))

    const completion = tracker.start("completion")
    assert.deepStrictEqual(tracker.state, { busy: true, stoppable: false })
    const chat = tracker.start("chat")
    assert.deepStrictEqual(tracker.state, { busy: true, stoppable: true })
    chat.finish()
    completion.finish()
    assert.deepStrictEqual(tracker.state, { busy: false, stoppable: false })
    assert.deepStrictEqual(seen, [
      { busy: true, stoppable: false },
      { busy: true, stoppable: true },
      { busy: true, stoppable: false },
      { busy: false, stoppable: false }
    ])
  })

  test("finishing a run twice ends only that run", () => {
    const tracker = new GenerationTracker()
    const chat = tracker.start("chat")
    const edit = tracker.start("edit")
    edit.finish()
    edit.finish()
    edit.abort()
    assert.deepStrictEqual(tracker.state, { busy: true, stoppable: true })
    chat.finish()
    assert.strictEqual(tracker.state.busy, false)
  })

  test("stopAll aborts every live run and is heard with nothing running", () => {
    const tracker = new GenerationTracker()
    let stops = 0
    tracker.onDidStop(() => stops++)
    const runs = [tracker.start("chat"), tracker.start("edit"), tracker.start("completion")]

    tracker.stopAll()
    assert.ok(runs.every((run) => run.signal.aborted))
    assert.strictEqual(tracker.state.busy, false)
    tracker.stopAll()
    assert.strictEqual(stops, 2)
  })

  test("a completion moving on leaves a running chat's spinner alone", async () => {
    const tracker = new GenerationTracker()
    const context = { globalState: { get: () => undefined } } as unknown as vscode.ExtensionContext
    const completion = new CompletionProvider(tracker, new FileInteractionCache(), new TemplateProvider(undefined), context)
    try {
      const chat = tracker.start("chat")
      // Every cursor move and every keystroke aborts the completion.
      for (let i = 0; i < 5; i++) completion.abortCompletion()
      assert.deepStrictEqual(tracker.state, { busy: true, stoppable: true })
      chat.finish()
      assert.strictEqual(tracker.state.busy, false)
    } finally {
      completion.dispose()
    }
  })

  test("the stop command stops a streaming chat, and the next part of a review", async () => {
    const tracker = new GenerationTracker()
    const { bridge, emitted } = stubBridge()
    const generation = new ChatGeneration(bridge, tracker)
    const { client, running } = hangingChat()
    try {
      const reply = generation.generate(client, request, provider)
      await running
      assert.strictEqual(tracker.state.stoppable, true)

      tracker.stopAll()
      assert.strictEqual(tracker.state.busy, false)
      assert.strictEqual(await reply, "partial")
      assert.ok(generation.cancelled)
      assert.ok(emitted.includes(EVENT_NAME.twinnyStopGeneration))
      // A later part does not start until the next request resets it.
      assert.strictEqual(await generation.generate(client, request, provider), "")
      assert.strictEqual(tracker.state.busy, false)
    } finally {
      generation.dispose()
    }
  })

  test("stopping one chat keeps the other's run", async () => {
    const tracker = new GenerationTracker()
    const sidebar = new ChatGeneration(stubBridge().bridge, tracker)
    const panel = new ChatGeneration(stubBridge().bridge, tracker)
    const first = hangingChat()
    const second = hangingChat()
    try {
      const sidebarReply = sidebar.generate(first.client, request, provider)
      const panelReply = panel.generate(second.client, request, provider)
      await Promise.all([first.running, second.running])

      sidebar.abort()
      await sidebarReply
      assert.deepStrictEqual(tracker.state, { busy: true, stoppable: true })
      panel.abort()
      await panelReply
      assert.strictEqual(tracker.state.busy, false)
    } finally {
      sidebar.dispose()
      panel.dispose()
    }
  })
})

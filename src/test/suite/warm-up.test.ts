import * as assert from "assert"

import { TwinnyProvider } from "../../common/types"
import { ModelWarmer, shouldWarm, WARM_INTERVAL_MS } from "../../extension/completion/warm-up"

const provider = (overrides: Partial<TwinnyProvider> = {}): TwinnyProvider => ({
  id: "p",
  label: "p",
  provider: "ollama",
  modelName: "qwen2.5-coder:1.5b",
  apiHostname: "localhost",
  apiPort: 11434,
  type: "fim",
  ...overrides
})

/** A warmer over a fake clock and a send that records what it was asked. */
const warmerFor = (active: TwinnyProvider | undefined, fail = false) => {
  const sent: string[] = []
  let now = 1_000_000
  const warmer = new ModelWarmer(
    () => active,
    () => "5m",
    async (target, keepAlive) => {
      sent.push(`${target.modelName}@${keepAlive}`)
      if (fail) throw new Error("connection refused")
    },
    () => now
  )
  return { warmer, sent, advance: (ms: number) => (now += ms) }
}

suite("Completion: model warm-up", () => {
  test("warms local model servers, never hosted APIs", () => {
    assert.ok(shouldWarm(provider()))
    assert.ok(shouldWarm(provider({ provider: "lmstudio" })))
    assert.ok(shouldWarm(provider({ provider: "ollama", apiHostname: "192.168.1.20" })))
    assert.ok(shouldWarm(provider({ provider: "openai-compatible", apiHostname: "127.0.0.1" })))
    assert.ok(!shouldWarm(provider({ provider: "openai-compatible", apiHostname: "api.example.com" })))
    assert.ok(!shouldWarm(provider({ provider: "mistral" })))
    assert.ok(!shouldWarm(provider({ provider: "deepseek" })))
  })

  test("sends one warm-up, then waits out the interval", async () => {
    const { warmer, sent, advance } = warmerFor(provider())
    await warmer.warm("startup")
    await warmer.warm("focus")
    assert.deepStrictEqual(sent, ["qwen2.5-coder:1.5b@5m"])
    advance(WARM_INTERVAL_MS)
    await warmer.warm("focus")
    assert.strictEqual(sent.length, 2)
  })

  test("a real completion request counts as warm", async () => {
    const active = provider()
    const { warmer, sent, advance } = warmerFor(active)
    warmer.touch(active)
    advance(WARM_INTERVAL_MS - 1)
    await warmer.warm("focus")
    assert.deepStrictEqual(sent, [])
  })

  test("does not send two at once", async () => {
    const { warmer, sent } = warmerFor(provider())
    await Promise.all([warmer.warm("a"), warmer.warm("b")])
    assert.strictEqual(sent.length, 1)
  })

  test("a failed warm-up is retried next time, quietly", async () => {
    const { warmer, sent } = warmerFor(provider(), true)
    await warmer.warm("startup")
    await warmer.warm("focus")
    assert.strictEqual(sent.length, 2)
  })

  test("does nothing without a model or for a hosted one", async () => {
    for (const active of [undefined, provider({ modelName: "" }), provider({ provider: "openai" })]) {
      const { warmer, sent } = warmerFor(active)
      await warmer.warm("startup")
      assert.deepStrictEqual(sent, [])
    }
  })
})

/**
 * The shared deadline: a signal that fires after its time or when its
 * parent does, with the reason the caller chose, and that stops holding
 * the clock once the caller says the work is over.
 */
import * as assert from "assert"

import { deadline, noAnswer, timeoutSignal } from "../../common/deadline"

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

suite("Deadline", () => {
  test("fires after its time with the platform's reason, or the caller's", async () => {
    const plain = deadline(10)
    assert.strictEqual(plain.signal.aborted, false)
    await tick(30)
    assert.strictEqual(plain.signal.aborted, true)
    assert.strictEqual((plain.signal.reason as { name?: string }).name, "AbortError")

    const named = deadline(10, { reason: () => noAnswer(10) })
    await tick(30)
    assert.strictEqual(named.signal.aborted, true)
    assert.strictEqual((named.signal.reason as Error).message, "No answer within 0.01 s.")
  })

  test("answered() stops the clock; the parent still cuts in until done()", async () => {
    const parent = new AbortController()
    const made = deadline(10, { parent: parent.signal })
    made.answered()
    await tick(30)
    assert.strictEqual(made.signal.aborted, false, "the clock stopped")
    parent.abort(new Error("stopped"))
    assert.strictEqual(made.signal.aborted, true, "the parent still counts")
    assert.strictEqual((made.signal.reason as Error).message, "stopped")

    const later = new AbortController()
    const finished = deadline(10, { parent: later.signal })
    finished.done()
    later.abort()
    await tick(30)
    assert.strictEqual(finished.signal.aborted, false, "after done() nothing reaches it")
  })

  test("a parent already aborted is forwarded at once, reason and all", () => {
    const parent = new AbortController()
    parent.abort(new Error("gone"))
    const made = deadline(1_000, { parent: parent.signal })
    assert.strictEqual(made.signal.aborted, true)
    assert.strictEqual((made.signal.reason as Error).message, "gone")
    made.done()
  })

  test("timeoutSignal tidies up after itself on either trigger", async () => {
    const parent = new AbortController()
    const byParent = timeoutSignal(1_000, { parent: parent.signal })
    parent.abort(new Error("plugin stopped"))
    assert.strictEqual(byParent.aborted, true)
    assert.strictEqual((byParent.reason as Error).message, "plugin stopped")

    const quiet = new AbortController()
    const byClock = timeoutSignal(10, { parent: quiet.signal, reason: () => noAnswer(10) })
    await tick(30)
    assert.strictEqual(byClock.aborted, true)
    assert.match((byClock.reason as Error).message, /No answer/)
    // It let go of the parent: aborting it now changes nothing and leaks no listener.
    quiet.abort(new Error("late"))
    assert.match((byClock.reason as Error).message, /No answer/)
  })
})

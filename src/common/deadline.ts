/**
 * A deadline on asynchronous work: an AbortSignal that fires after `ms`,
 * or when a parent signal does, whichever comes first. Pure; shared by
 * the extension, the protocol client and the gateway.
 *
 * Four copies of this used to live next to their callers, each with a
 * slightly different shape. This is the one.
 */

export interface Deadline {
  readonly signal: AbortSignal
  /** Stops the clock. The signal still follows the parent until `done()`. */
  answered(): void
  /** Stops the clock and stops following the parent. Call when the work is over. */
  done(): void
}

export interface DeadlineOptions {
  /** A signal whose abort is forwarded, reason and all. */
  parent?: AbortSignal
  /**
   * What the signal aborts with when time runs out. Without it the
   * platform's own AbortError, which `fetch` and friends classify as a
   * cancellation.
   */
  reason?: () => unknown
}

/** The reason a gateway request gives when a forge does not answer in time. */
export const noAnswer = (ms: number): Error =>
  new Error(`No answer within ${ms / 1000} s.`)

/**
 * A deadline the caller closes. Use this around a request whose end the
 * caller sees: `answered()` once the first byte is in, `done()` in a
 * `finally`.
 */
export const deadline = (ms: number, options: DeadlineOptions = {}): Deadline => {
  const { parent, reason } = options
  const controller = new AbortController()
  const forward = () => controller.abort(parent?.reason)
  if (parent?.aborted) forward()
  else parent?.addEventListener("abort", forward, { once: true })
  const timer = setTimeout(() => controller.abort(reason?.()), ms)
  // A clock that only cancels a request must not keep a process alive.
  ;(timer as { unref?: () => void }).unref?.()
  const answered = () => clearTimeout(timer)
  return {
    signal: controller.signal,
    answered,
    done: () => {
      answered()
      parent?.removeEventListener("abort", forward)
    }
  }
}

/**
 * A signal for work the caller does not follow to the end. It tidies up
 * after itself when it fires, or when the parent does.
 */
export const timeoutSignal = (ms: number, options: DeadlineOptions = {}): AbortSignal => {
  const made = deadline(ms, options)
  made.signal.addEventListener("abort", made.done, { once: true })
  return made.signal
}

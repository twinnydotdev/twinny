/**
 * The tool steps of the reply being written, as the chat shows them: each
 * call appears when it starts, fills in when it finishes, and a command
 * waits in it for the user's Run or Skip. The webview gets the whole list
 * each time something changes and keeps it with the reply.
 */
import { ToolStepView } from "../../common/types"
import { ToolStart, ToolStep } from "../tools/loop"

/**
 * Characters of a tool's output, and of each of its arguments, kept for
 * the user to read. The steps are saved with the conversation, so a
 * created file's whole content or a long diff is not kept in full; the
 * model's own copy is not cut here.
 */
const MAX_SHOWN_OUTPUT = 4000
const MAX_SHOWN_ARG = 2000
const MAX_ARG_IN_SUMMARY = 80
/** What a running command has printed is shown as its tail, refreshed this often. */
const MAX_LIVE_OUTPUT = 2000
const LIVE_EVERY_MS = 250

const shown = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text

const shownArgs = (args: Record<string, string>) =>
  Object.fromEntries(Object.entries(args).map(([name, value]) => [name, shown(value, MAX_SHOWN_ARG)]))

const firstArg = (args: Record<string, string>) => {
  const value = Object.values(args).find((v) => v.trim())?.trim() ?? ""
  const line = value.split("\n")[0]
  return line.length > MAX_ARG_IN_SUMMARY ? `${line.slice(0, MAX_ARG_IN_SUMMARY)}…` : line
}

/** What a call is doing, before it has a summary of its own. */
const startSummary = ({ name, args }: ToolStart) => {
  const what = firstArg(args)
  return what ? `${name} \`${what}\`` : name
}

export class ToolSteps {
  private _steps: ToolStepView[] = []
  private readonly _waiting = new Map<string, (run: boolean) => void>()
  private readonly _skipped = new Set<string>()
  private readonly _stoppers = new Map<string, () => void>()
  private readonly _stopped = new Set<string>()
  private _live: { id: string; output: string } | undefined
  private _liveTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly _emit: (steps: ToolStepView[]) => void) {}

  /** A new reply: forget the last one's steps and any command still waiting. */
  public reset() {
    this.cancelWaiting()
    this._steps = []
    this._skipped.clear()
    this._stoppers.clear()
    this._stopped.clear()
    clearTimeout(this._liveTimer)
    this._liveTimer = undefined
    this._live = undefined
  }

  public get steps(): ToolStepView[] {
    return this._steps
  }

  public start(start: ToolStart) {
    this._steps = [
      ...this._steps,
      { id: start.id, name: start.name, args: shownArgs(start.args), summary: startSummary(start), status: "running" }
    ]
    this.send()
  }

  public finish(step: ToolStep) {
    const output = shown(step.output, MAX_SHOWN_OUTPUT)
    this._stoppers.delete(step.id)
    const status = this._skipped.has(step.id)
      ? "skipped"
      : this._stopped.has(step.id)
        ? "stopped"
        : step.failed
          ? "failed"
          : "done"
    this.update(step.id, {
      summary: step.summary,
      output,
      status,
      command: undefined,
      approval: undefined,
      stoppable: undefined
    })
  }

  /** How to stop the running step's command alone; its step gets a stop button. */
  public stoppable(stop: () => void) {
    const step = [...this._steps].reverse().find((s) => s.status === "running")
    if (!step) return
    this._stoppers.set(step.id, stop)
    this.update(step.id, { stoppable: true })
  }

  /** The user's stop on a running step: that command ends, the reply goes on. */
  public stop(id: string) {
    const stop = this._stoppers.get(id)
    if (!stop) return
    this._stoppers.delete(id)
    this._stopped.add(id)
    this.update(id, { stoppable: undefined })
    stop()
  }

  /**
   * What the running step has printed so far (a command's output), sent
   * at most a few times a second; `finish` replaces it with the result.
   */
  public progress(output: string) {
    const step = [...this._steps].reverse().find((s) => s.status === "running")
    if (!step) return
    this._live = { id: step.id, output: output.slice(-MAX_LIVE_OUTPUT) }
    if (this._liveTimer) return
    this._liveTimer = setTimeout(() => {
      this._liveTimer = undefined
      const live = this._live
      if (!live || !this._steps.some((s) => s.id === live.id && s.status === "running")) return
      this.update(live.id, { output: live.output })
    }, LIVE_EVERY_MS)
  }

  /**
   * Hold the running step until the user answers in the chat: a command
   * to run, or a change to make that has no diff to review. Resolves
   * false if they skip it, stop the reply, or a new one starts.
   */
  public approve(detail: string, approval: "command" | "change" = "command"): Promise<boolean> {
    const step = [...this._steps].reverse().find((s) => s.status === "running")
    if (!step) return Promise.resolve(false)
    this.update(step.id, { status: "waiting", command: detail, approval })
    return new Promise((resolve) => {
      this._waiting.set(step.id, (run) => {
        if (!run) this._skipped.add(step.id)
        resolve(run)
      })
    })
  }

  /** The user's Run or Skip, from the webview. */
  public answer(id: string, run: boolean) {
    const resolve = this._waiting.get(id)
    if (!resolve) return
    this._waiting.delete(id)
    this.update(id, { status: "running", command: undefined, approval: undefined })
    resolve(run)
  }

  /** Stopping the reply skips whatever is waiting. */
  public cancelWaiting() {
    for (const id of [...this._waiting.keys()]) this.answer(id, false)
  }

  /**
   * The reply is over. A step still running or waiting was cut off by a
   * stop or a failure, and says so rather than spinning for ever in the
   * saved conversation.
   */
  public settle() {
    this.cancelWaiting()
    if (!this._steps.some((step) => step.status === "running" || step.status === "waiting")) return
    this._steps = this._steps.map((step) =>
      step.status === "running" || step.status === "waiting"
        ? { ...step, status: "stopped" as const, command: undefined, approval: undefined, stoppable: undefined }
        : step
    )
    this.send()
  }

  private update(id: string, change: Partial<ToolStepView>) {
    this._steps = this._steps.map((step) => (step.id === id ? { ...step, ...change } : step))
    this.send()
  }

  private send() {
    this._emit(this._steps)
  }
}

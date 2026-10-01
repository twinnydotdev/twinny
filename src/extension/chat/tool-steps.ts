/**
 * The tool steps of the reply being written, as the chat shows them: each
 * call appears when it starts, fills in when it finishes, and a command
 * waits in it for the user's Run or Skip. The webview gets the whole list
 * each time something changes and keeps it with the reply.
 */
import { ToolStepView } from "../../common/types"
import { ToolStart, ToolStep } from "../tools/loop"

/** Characters of a tool's output kept for the user to read (and saved with the conversation); the model's copy is not cut. */
const MAX_SHOWN_OUTPUT = 8_000
const MAX_ARG_IN_SUMMARY = 80

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

  constructor(private readonly _emit: (steps: ToolStepView[]) => void) {}

  /** A new reply: forget the last one's steps and any command still waiting. */
  public reset() {
    this.cancelWaiting()
    this._steps = []
    this._skipped.clear()
  }

  public get steps(): ToolStepView[] {
    return this._steps
  }

  public start(start: ToolStart) {
    this._steps = [
      ...this._steps,
      { id: start.id, name: start.name, args: start.args, summary: startSummary(start), status: "running" }
    ]
    this.send()
  }

  public finish(step: ToolStep) {
    const output =
      step.output.length > MAX_SHOWN_OUTPUT
        ? `${step.output.slice(0, MAX_SHOWN_OUTPUT)}\n… (${step.output.length - MAX_SHOWN_OUTPUT} more characters)`
        : step.output
    const status = this._skipped.has(step.id) ? "skipped" : step.failed ? "failed" : "done"
    this.update(step.id, { summary: step.summary, output, status, command: undefined, approval: undefined })
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

  private update(id: string, change: Partial<ToolStepView>) {
    this._steps = this._steps.map((step) => (step.id === id ? { ...step, ...change } : step))
    this.send()
  }

  private send() {
    this._emit(this._steps)
  }
}

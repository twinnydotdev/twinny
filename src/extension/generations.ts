/**
 * What a run is. Chat and inline edit are what the user waits on, so the
 * stop keybinding covers them; completions come and go with every keystroke
 * and only turn the spinner on.
 */
export type GenerationKind = "chat" | "edit" | "completion"

/** One request to a model, from the moment it starts until its owner is done. */
export interface GenerationRun {
  readonly kind: GenerationKind
  readonly signal: AbortSignal
  /** Stop the request. The run ends here, whatever its owner does next. */
  abort(reason?: unknown): void
  /** The owner is done with it. Safe to call more than once. */
  finish(): void
}

export interface GenerationState {
  /** Something is running: the status bar spins. */
  busy: boolean
  /** A chat or inline edit is running: the stop keybinding is live. */
  stoppable: boolean
}

type Listener<T> = (value: T) => void

const IDLE: GenerationState = { busy: false, stoppable: false }

/**
 * Every model request the extension makes, in one place. Features start a
 * run and finish it; the spinner, the stop keybinding's context flag and the
 * stop command all read from here, so one feature finishing can never end
 * another's spinner, and stop reaches everything that is running.
 */
export class GenerationTracker {
  private readonly _live = new Set<GenerationRun>()
  private readonly _changed = new Set<Listener<GenerationState>>()
  private readonly _stopped = new Set<Listener<void>>()
  private _state = IDLE

  public get state(): GenerationState {
    return this._state
  }

  public start(kind: GenerationKind): GenerationRun {
    const controller = new AbortController()
    let live = true
    const run: GenerationRun = {
      kind,
      signal: controller.signal,
      abort: (reason) => {
        controller.abort(reason)
        run.finish()
      },
      finish: () => {
        if (!live) return
        live = false
        this._live.delete(run)
        this.update()
      }
    }
    this._live.add(run)
    this.update()
    return run
  }

  /**
   * The user pressed stop: abort everything running and tell whoever
   * needs to know, even with nothing running (a multi-part review between
   * parts has to hear it too).
   */
  public stopAll() {
    for (const run of [...this._live]) run.abort()
    for (const listener of [...this._stopped]) listener()
  }

  public onDidChange(listener: Listener<GenerationState>) {
    return this.subscribe(this._changed, listener)
  }

  public onDidStop(listener: Listener<void>) {
    return this.subscribe(this._stopped, listener)
  }

  private subscribe<T>(listeners: Set<Listener<T>>, listener: Listener<T>) {
    listeners.add(listener)
    return { dispose: () => listeners.delete(listener) }
  }

  private update() {
    const runs = [...this._live]
    const next: GenerationState = {
      busy: runs.length > 0,
      stoppable: runs.some((run) => run.kind !== "completion")
    }
    if (next.busy === this._state.busy && next.stoppable === this._state.stoppable) {
      return
    }
    this._state = next
    for (const listener of [...this._changed]) listener(next)
  }
}

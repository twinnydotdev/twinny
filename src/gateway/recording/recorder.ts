/**
 * Recording: keeping the content of requests, when the admin has asked
 * for it and the licence allows it.
 *
 * The rules, in one place:
 *   - nothing is captured unless the route is switched on in the
 *     configuration AND the licence carries the `recording` feature;
 *   - what is switched on is disclosed to developers on the team route;
 *   - records are pruned by age, on a timer, like usage files.
 *
 * Settings can change while the gateway runs (the admin page saves them);
 * the store does not, since it is a file or a database opened at start.
 */
import { messageOf } from "../../common/errors"
import type { InferenceCapability } from "../../extension/inference/types"

import { newRecordingId, RecordingRecord, RecordingStore, RecordingUsage } from "./store"

export interface RecordingSettings {
  chat: boolean
  fim: boolean
  embeddings: boolean
  retentionDays: number
}

export const ROUTES: InferenceCapability[] = ["chat", "fim", "embeddings"]

/** What the handler hands over when capture was on. */
export interface Capture {
  request: unknown
  response: unknown
  model?: string
  provider?: string
}

export interface RecorderOptions {
  store: RecordingStore
  settings: RecordingSettings
  /** Whether the licence allows recording right now. Read on every decision. */
  licensed: () => boolean
  log?: (event: string, fields: Record<string, string | number>) => void
  /** How often the sweeper runs. */
  sweepEveryMs?: number
}

export interface RecorderSummary {
  settings: RecordingSettings
  /** Routes actually being recorded: switched on and licensed. */
  active: InferenceCapability[]
  licensed: boolean
  store: { kind: RecordingStore["kind"]; location: string; count: number }
}

export class Recorder {
  private _settings: RecordingSettings
  private _sweeper?: NodeJS.Timeout

  constructor(private readonly _options: RecorderOptions) {
    this._settings = { ..._options.settings }
  }

  public get store(): RecordingStore {
    return this._options.store
  }

  public get settings(): RecordingSettings {
    return { ...this._settings }
  }

  public update(settings: RecordingSettings): void {
    this._settings = { ...settings }
  }

  /** Whether content for this route should be captured now. */
  public enabled(route: InferenceCapability): boolean {
    return this._settings[route] === true && this._options.licensed()
  }

  /** The routes being recorded, for the disclosure sent to developers. */
  public active(): InferenceCapability[] {
    return ROUTES.filter((route) => this.enabled(route))
  }

  public record(input: {
    key: string
    route: InferenceCapability
    alias: string
    outcome: RecordingRecord["outcome"]
    ms: number
    usage?: RecordingUsage
    capture: Capture
    at?: Date
  }): RecordingRecord | undefined {
    if (!this.enabled(input.route)) return undefined
    const at = input.at ?? new Date()
    // Autocomplete clients stop reading once they have the lines they
    // want; the backend sees a cancellation, the developer saw a
    // completion. Keep it as what it was: a success ended by the client.
    const reply = input.capture.response as { text?: unknown } | undefined
    const clientStopped = input.route === "fim" && input.outcome === "cancelled" && typeof reply?.text === "string" && reply.text.length > 0
    const record: RecordingRecord = {
      id: newRecordingId(at),
      at: at.toISOString(),
      key: input.key,
      route: input.route,
      alias: input.alias,
      ...(input.capture.model ? { model: input.capture.model } : {}),
      ...(input.capture.provider ? { provider: input.capture.provider } : {}),
      outcome: clientStopped ? "ok" : input.outcome,
      ...(clientStopped ? { ended: "client" as const } : {}),
      ms: input.ms,
      ...(input.usage && (input.usage.promptTokens !== undefined || input.usage.completionTokens !== undefined) ? { usage: input.usage } : {}),
      request: input.capture.request,
      response: input.capture.response
    }
    try {
      this._options.store.append(record)
    } catch (error) {
      this._options.log?.("recording.failed", { route: input.route, reason: messageOf(error) })
      return undefined
    }
    return record
  }

  public summary(): RecorderSummary {
    const { store } = this._options
    return {
      settings: this.settings,
      active: this.active(),
      licensed: this._options.licensed(),
      store: { kind: store.kind, location: store.location, count: store.count() }
    }
  }

  public start(): void {
    this.sweep()
    this._sweeper = setInterval(() => this.sweep(), this._options.sweepEveryMs ?? 60 * 60_000)
    this._sweeper.unref()
  }

  public stop(): void {
    if (this._sweeper) clearInterval(this._sweeper)
    this._sweeper = undefined
    this._options.store.close()
  }

  public sweep(now = new Date()): number {
    const cutoff = new Date(now.getTime() - this._settings.retentionDays * 86_400_000)
    try {
      const removed = this._options.store.prune(cutoff)
      if (removed) this._options.log?.("recording.pruned", { removed })
      return removed
    } catch (error) {
      this._options.log?.("recording.prune-failed", { reason: messageOf(error) })
      return 0
    }
  }
}

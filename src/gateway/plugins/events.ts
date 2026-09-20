/**
 * How plugins tell each other what happened: a review finished, a pull
 * opened, a backup failed, a backend went down. Anything may emit; a
 * plugin that cares (Slack) listens. The bus keeps the last few hundred
 * for a page to show, and nothing is persisted.
 */

export type PluginEventLevel = "info" | "warn" | "error"

export interface PluginEvent {
  /** Dotted kind, e.g. `review.done`, `pull.opened`, `backup.failed`, `backend.down`. */
  type: string
  /** Which plugin (or `gateway`) said so. */
  source: string
  at: string
  level: PluginEventLevel
  /** One line, e.g. "Review of acme/widgets#209: request changes". */
  title: string
  /** A few lines more, plain text; may be empty. */
  text: string
  /** Where to look, when there is somewhere. */
  url?: string
  data?: Record<string, unknown>
}

/** What the catalogue calls an event type, for pages that let people pick. */
export interface PluginEventKind {
  type: string
  label: string
  description: string
}

export const EVENT_KINDS: PluginEventKind[] = [
  { type: "review.done", label: "Review finished", description: "A model finished reviewing a pull, whatever it concluded." },
  { type: "review.changes", label: "Review asks for changes", description: "A review's verdict was \"Request changes\"." },
  { type: "review.failed", label: "Review failed", description: "A review could not be made: no answer, or the model refused." },
  { type: "review.posted", label: "Review posted", description: "A review was posted to the host as a comment, a change request or an approval." },
  { type: "pull.opened", label: "Pull opened", description: "A new pull request appeared on a watched repository." },
  { type: "pull.checks-failed", label: "Checks failed", description: "A watched pull's checks went from passing or pending to failing." },
  { type: "backup.ok", label: "Backup made", description: "A backup was written to its destination." },
  { type: "backup.failed", label: "Backup failed", description: "A backup could not be made or stored." },
  { type: "backend.down", label: "Backend down", description: "A configured backend stopped answering." },
  { type: "backend.up", label: "Backend back", description: "A backend that was down answers again." },
  { type: "quota.warning", label: "Quota warning", description: "A key passed the warning share of its daily quota." },
  { type: "quota.reached", label: "Quota reached", description: "A key hit its daily quota and requests are being refused." },
  { type: "signin.sso", label: "SSO sign-in", description: "Someone signed in through the identity provider and got a key." }
]

export type PluginEventHandler = (event: PluginEvent) => void

const KEEP = 300

export class PluginEventBus {
  private readonly _handlers = new Set<PluginEventHandler>()
  private readonly _recent: PluginEvent[] = []

  constructor(private readonly _now: () => number = Date.now, private readonly _onError?: (error: unknown) => void) {}

  public emit(event: Omit<PluginEvent, "at"> & { at?: string }): PluginEvent {
    const full: PluginEvent = { ...event, at: event.at ?? new Date(this._now()).toISOString() }
    this._recent.push(full)
    if (this._recent.length > KEEP) this._recent.splice(0, this._recent.length - KEEP)
    for (const handler of [...this._handlers]) {
      try {
        handler(full)
      } catch (error) {
        this._onError?.(error)
      }
    }
    return full
  }

  /** Listens; the returned function stops listening. */
  public on(handler: PluginEventHandler): () => void {
    this._handlers.add(handler)
    return () => this._handlers.delete(handler)
  }

  public recent(limit = 50): PluginEvent[] {
    return this._recent.slice(-limit).reverse()
  }
}

/**
 * Prometheus metrics for the gateway, in the text exposition format, with
 * no dependency: counters and gauges kept in memory since the process
 * started, plus a latency histogram. Served at /metrics to admin keys.
 */
import type { UsageRecord } from "./usage"

const LATENCY_BUCKETS_S = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120]

type Labels = Record<string, string>

const labelKey = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((name) => `${name}="${String(labels[name]).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n")}"`)
    .join(",")

class Counter {
  private readonly _values = new Map<string, number>()
  constructor(
    public readonly name: string,
    public readonly help: string
  ) {}
  public inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels)
    this._values.set(key, (this._values.get(key) ?? 0) + by)
  }
  public render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`]
    for (const [key, value] of [...this._values.entries()].sort()) lines.push(`${this.name}${key ? `{${key}}` : ""} ${value}`)
    return lines.join("\n")
  }
}

class Gauge {
  private readonly _values = new Map<string, number>()
  constructor(
    public readonly name: string,
    public readonly help: string
  ) {}
  public set(labels: Labels, value: number): void {
    this._values.set(labelKey(labels), value)
  }
  public render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`]
    for (const [key, value] of [...this._values.entries()].sort()) lines.push(`${this.name}${key ? `{${key}}` : ""} ${value}`)
    return lines.join("\n")
  }
}

class Histogram {
  private readonly _buckets = new Map<string, number[]>()
  private readonly _sums = new Map<string, number>()
  private readonly _counts = new Map<string, number>()
  constructor(
    public readonly name: string,
    public readonly help: string,
    private readonly _bounds: number[]
  ) {}
  public observe(labels: Labels, value: number): void {
    const key = labelKey(labels)
    const buckets = this._buckets.get(key) ?? new Array<number>(this._bounds.length).fill(0)
    for (let i = 0; i < this._bounds.length; i++) if (value <= this._bounds[i]) buckets[i]++
    this._buckets.set(key, buckets)
    this._sums.set(key, (this._sums.get(key) ?? 0) + value)
    this._counts.set(key, (this._counts.get(key) ?? 0) + 1)
  }
  public render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`]
    for (const [key, buckets] of [...this._buckets.entries()].sort()) {
      const sep = key ? `${key},` : ""
      for (let i = 0; i < this._bounds.length; i++) lines.push(`${this.name}_bucket{${sep}le="${this._bounds[i]}"} ${buckets[i]}`)
      lines.push(`${this.name}_bucket{${sep}le="+Inf"} ${this._counts.get(key) ?? 0}`)
      lines.push(`${this.name}_sum${key ? `{${key}}` : ""} ${this._sums.get(key) ?? 0}`)
      lines.push(`${this.name}_count${key ? `{${key}}` : ""} ${this._counts.get(key) ?? 0}`)
    }
    return lines.join("\n")
  }
}

export class GatewayMetrics {
  private readonly _requests = new Counter("twinny_requests_total", "Inference requests finished, by route, alias and outcome.")
  private readonly _latency = new Histogram("twinny_request_duration_seconds", "Time from request start to end, by route.", LATENCY_BUCKETS_S)
  private readonly _tokens = new Counter("twinny_tokens_total", "Tokens the backends reported, by alias and direction.")
  private readonly _chunks = new Counter("twinny_chunks_total", "Streamed chunks delivered, by route.")
  private readonly _active = new Gauge("twinny_active_requests", "Inference requests in flight.")
  private readonly _backendUp = new Gauge("twinny_backend_up", "1 when the backend answered its last check, 0 when not.")
  private readonly _backendLatency = new Gauge("twinny_backend_check_seconds", "How long the backend's last check took.")
  private readonly _auth = new Counter("twinny_auth_rejected_total", "Requests refused for a bad or missing key.")
  private readonly _quota = new Counter("twinny_quota_refused_total", "Requests refused because a key was over its quota, by key.")
  private readonly _keys = new Gauge("twinny_keys_active", "Active access keys.")
  private readonly _seats = new Gauge("twinny_seats", "Seats the plan allows.")
  private readonly _plugins = new Counter("twinny_plugin_events_total", "Events plugins reported, by type.")
  private readonly _startedAt = Date.now()

  public request(record: Omit<UsageRecord, "ts">): void {
    const route = record.route
    const alias = record.alias ?? ""
    this._requests.inc({ route, alias, outcome: record.outcome })
    this._latency.observe({ route }, record.ms / 1000)
    if (record.chunks) this._chunks.inc({ route }, record.chunks)
    if (record.promptTokens) this._tokens.inc({ alias, direction: "prompt" }, record.promptTokens)
    if (record.completionTokens) this._tokens.inc({ alias, direction: "completion" }, record.completionTokens)
  }

  public active(count: number): void {
    this._active.set({}, count)
  }

  public backend(provider: string, ok: boolean, seconds: number): void {
    this._backendUp.set({ provider }, ok ? 1 : 0)
    this._backendLatency.set({ provider }, seconds)
  }

  public authRejected(): void {
    this._auth.inc()
  }

  public quotaRefused(key: string): void {
    this._quota.inc({ key })
  }

  public plan(keys: number, seats: number): void {
    this._keys.set({}, keys)
    this._seats.set({}, seats)
  }

  public pluginEvent(type: string): void {
    this._plugins.inc({ type })
  }

  public render(version: string): string {
    return [
      `# HELP twinny_info The gateway's version.\n# TYPE twinny_info gauge\ntwinny_info{version="${version}"} 1`,
      `# HELP twinny_uptime_seconds Seconds since the gateway started.\n# TYPE twinny_uptime_seconds gauge\ntwinny_uptime_seconds ${Math.round((Date.now() - this._startedAt) / 1000)}`,
      this._requests.render(),
      this._latency.render(),
      this._tokens.render(),
      this._chunks.render(),
      this._active.render(),
      this._backendUp.render(),
      this._backendLatency.render(),
      this._auth.render(),
      this._quota.render(),
      this._keys.render(),
      this._seats.render(),
      this._plugins.render(),
      ""
    ].join("\n")
  }
}

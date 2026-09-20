/**
 * Usage records: one JSON line per inference request, in a file per UTC
 * day, under a directory the operator owns. Fields are the request's
 * metadata and whatever token counts the backend reported. Never a prompt,
 * a reply or a header.
 *
 * Retention is by file age: on start and once a day, files older than the
 * configured number of days are deleted. A summary reads the files whose
 * day falls in the asked-for range, so the CLI can report without the
 * server's help and without a database.
 */
import fs from "node:fs"
import path from "node:path"

import { InferenceErrorKind } from "../extension/inference/errors"
import { InferenceUsage } from "../extension/inference/types"

import { RUN_GAP_MS } from "./runs"

export interface UsageRecord {
  /** ISO timestamp when the request finished. */
  ts: string
  /** The key name, or `shared` for the shared token. */
  key: string
  route: "fim" | "chat" | "embeddings"
  alias?: string
  outcome: "ok" | "error" | "cancelled"
  kind?: InferenceErrorKind
  status: number
  ms: number
  /** Chunks the client received before the stream ended (fim and chat). */
  chunks?: number
  /** Texts the request carried (embeddings). */
  inputs?: number
  promptTokens?: number
  completionTokens?: number
  /** `key@machine` of the teammate's computer that served it, for pooled aliases. */
  peer?: string
}

const FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const DAY_MS = 24 * 60 * 60 * 1000

export const dayOf = (date: Date): string => date.toISOString().slice(0, 10)

export class UsageRecorder {
  private _queue: Promise<void> = Promise.resolve()
  private _sweeper?: NodeJS.Timeout

  constructor(
    public readonly dir: string,
    public readonly retentionDays: number
  ) {}

  /** Makes the directory and drops files past retention; called at startup. */
  public start(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    this.sweep()
    this._sweeper = setInterval(() => this.sweep(), DAY_MS)
    this._sweeper.unref()
  }

  public stop(): Promise<void> {
    if (this._sweeper) clearInterval(this._sweeper)
    return this._queue
  }

  /** Appends one record; writes are serialised so lines never interleave. */
  public record(
    entry: Omit<UsageRecord, "ts"> & { usage?: InferenceUsage }
  ): void {
    const { usage, ...rest } = entry
    const record: UsageRecord = {
      ts: new Date().toISOString(),
      ...rest,
      ...(usage?.promptTokens !== undefined
        ? { promptTokens: usage.promptTokens }
        : {}),
      ...(usage?.completionTokens !== undefined
        ? { completionTokens: usage.completionTokens }
        : {})
    }
    const file = path.join(this.dir, `${record.ts.slice(0, 10)}.jsonl`)
    const line = `${JSON.stringify(record)}\n`
    this._queue = this._queue
      .then(() => fs.promises.appendFile(file, line, { mode: 0o600 }))
      .catch(() => undefined)
  }

  /** Deletes day files older than the retention. */
  public sweep(now = new Date()): string[] {
    const cutoff = now.getTime() - this.retentionDays * DAY_MS
    const removed: string[] = []
    for (const name of listDayFiles(this.dir)) {
      const day = new Date(`${name.slice(0, 10)}T00:00:00Z`).getTime()
      if (day + DAY_MS <= cutoff) {
        try {
          fs.unlinkSync(path.join(this.dir, name))
          removed.push(name)
        } catch {
          // Someone else's problem now; the next sweep will try again.
        }
      }
    }
    return removed
  }
}

const listDayFiles = (dir: string): string[] => {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => FILE_PATTERN.test(name))
      .sort()
  } catch {
    return []
  }
}

/* -------------------------------------------------------------------------- */
/*  Summaries                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Embedding calls, grouped. Indexing a workspace is hundreds of small
 * calls in a row; a developer's calls to one alias with no gap longer
 * than `RUN_GAP_MS` are one run, and a run counts as one request in the
 * totals so it does not drown the chat and autocomplete numbers.
 */
export interface IndexingTotals {
  runs: number
  calls: number
  /** Texts embedded, when the records say. */
  texts: number
}

export { RUN_GAP_MS }

export interface UsageTotals {
  /** Chat and autocomplete requests, plus one per indexing run. */
  requests: number
  ok: number
  failed: number
  cancelled: number
  promptTokens: number
  completionTokens: number
  /** How many requests carried any token count. */
  counted: number
  ms: number
  /** What the tokens cost at the configured prices; absent when no alias has a price. */
  cost?: number
  indexing: IndexingTotals
}

export interface UsageDay {
  /** `YYYY-MM-DD`, UTC. */
  day: string
  requests: number
  /** Requests that day per key. */
  byKey: Record<string, number>
}

/** Per million tokens, in the summary's currency. */
export interface AliasPrice {
  input: number
  output: number
}

export interface UsageSummary {
  since: Date
  until: Date
  /** Set when any alias has a price; costs are in it. */
  currency?: string
  total: UsageTotals
  byKey: Record<string, UsageTotals>
  byModel: Record<string, UsageTotals>
  byKeyAndModel: Record<string, Record<string, UsageTotals>>
  /** Requests served by teammates' computers, per `key@machine`. */
  byPeer: Record<string, UsageTotals>
  /** Only days with records, oldest first. */
  byDay: UsageDay[]
}

const emptyTotals = (): UsageTotals => ({
  requests: 0,
  ok: 0,
  failed: 0,
  cancelled: 0,
  promptTokens: 0,
  completionTokens: 0,
  counted: 0,
  ms: 0,
  indexing: { runs: 0, calls: 0, texts: 0 }
})

/** One bucket's open indexing runs, by `key|alias`: when the last call ended, whether one failed, whether one reported tokens. */
type Runs = Map<string, { last: number; failed: boolean; counted: boolean }>

/**
 * Adds a record to one bucket's totals. An embedding call joins the
 * bucket's open run for its key and alias, or starts one; the run is a
 * single request whose duration and tokens are its calls' added up and
 * which fails once any call does. Returns whether the record counts as
 * a request: always for chat and fim, for embeddings when a run starts.
 */
const add = (totals: UsageTotals, record: UsageRecord, runs: Runs, prices?: Record<string, AliasPrice>): boolean => {
  if (record.route === "embeddings") {
    const at = new Date(record.ts).getTime()
    const id = `${record.key}|${record.alias ?? ""}`
    let run = runs.get(id)
    const started = !run || at - run.last > RUN_GAP_MS
    if (started) {
      run = { last: at, failed: false, counted: false }
      runs.set(id, run)
      totals.requests++
      totals.ok++
      totals.indexing.runs++
    }
    run!.last = Math.max(run!.last, at)
    totals.indexing.calls++
    totals.indexing.texts += record.inputs ?? 0
    totals.ms += record.ms
    if (record.outcome === "error" && !run!.failed) {
      run!.failed = true
      totals.ok--
      totals.failed++
    }
    if (record.promptTokens !== undefined || record.completionTokens !== undefined) {
      totals.promptTokens += record.promptTokens ?? 0
      totals.completionTokens += record.completionTokens ?? 0
      addCost(totals, record, prices)
      if (!run!.counted) {
        run!.counted = true
        totals.counted++
      }
    }
    return started
  }
  totals.requests++
  if (record.outcome === "ok") totals.ok++
  else if (record.outcome === "cancelled") totals.cancelled++
  else totals.failed++
  totals.ms += record.ms
  if (
    record.promptTokens !== undefined ||
    record.completionTokens !== undefined
  ) {
    totals.counted++
    totals.promptTokens += record.promptTokens ?? 0
    totals.completionTokens += record.completionTokens ?? 0
    addCost(totals, record, prices)
  }
  return true
}

/** Every record in the directory within the range, oldest first. */
export const readUsage = (
  dir: string,
  since: Date,
  until: Date
): UsageRecord[] => {
  const records: UsageRecord[] = []
  const firstDay = dayOf(since)
  const lastDay = dayOf(until)
  for (const name of listDayFiles(dir)) {
    const day = name.slice(0, 10)
    if (day < firstDay || day > lastDay) continue
    let text: string
    try {
      text = fs.readFileSync(path.join(dir, name), "utf8")
    } catch {
      continue
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line) as UsageRecord
        const ts = new Date(record.ts).getTime()
        if (ts >= since.getTime() && ts <= until.getTime()) records.push(record)
      } catch {
        // A torn last line from a crash; nothing to do with it.
      }
    }
  }
  return records
}

/** Adds what a record's tokens cost, when its alias has a price. */
const addCost = (totals: UsageTotals, record: UsageRecord, prices?: Record<string, AliasPrice>): void => {
  const price = record.alias ? prices?.[record.alias] : undefined
  if (!price) return
  const cost = ((record.promptTokens ?? 0) / 1_000_000) * price.input + ((record.completionTokens ?? 0) / 1_000_000) * price.output
  totals.cost = (totals.cost ?? 0) + cost
}

export const summarizeUsage = (
  dir: string,
  since: Date,
  until = new Date(),
  pricing?: { currency: string; prices: Record<string, AliasPrice> }
): UsageSummary => {
  const prices = pricing && Object.keys(pricing.prices).length ? pricing.prices : undefined
  const summary: UsageSummary = {
    since,
    until,
    ...(prices ? { currency: pricing?.currency ?? "USD" } : {}),
    total: emptyTotals(),
    byKey: {},
    byModel: {},
    byKeyAndModel: {},
    byPeer: {},
    byDay: []
  }
  const days = new Map<string, UsageDay>()
  const runs = new Map<string, Runs>()
  const runsOf = (bucket: string): Runs => {
    let open = runs.get(bucket)
    if (!open) runs.set(bucket, (open = new Map()))
    return open
  }
  for (const record of readUsage(dir, since, until)) {
    const model = record.alias || "(none)"
    const counts = add(summary.total, record, runsOf("total"), prices)
    add((summary.byKey[record.key] ??= emptyTotals()), record, runsOf(`key:${record.key}`), prices)
    add((summary.byModel[model] ??= emptyTotals()), record, runsOf(`model:${model}`), prices)
    const perKey = (summary.byKeyAndModel[record.key] ??= {})
    add((perKey[model] ??= emptyTotals()), record, runsOf(`key-model:${record.key}|${model}`), prices)
    if (record.peer)
      add((summary.byPeer[record.peer] ??= emptyTotals()), record, runsOf(`peer:${record.peer}`), prices)
    if (!counts) continue
    const day = record.ts.slice(0, 10)
    const entry = days.get(day) ?? { day, requests: 0, byKey: {} }
    entry.requests++
    entry.byKey[record.key] = (entry.byKey[record.key] ?? 0) + 1
    days.set(day, entry)
  }
  summary.byDay = [...days.values()].sort((a, b) => a.day.localeCompare(b.day))
  return summary
}

/**
 * A period as the CLI accepts it: `7d`, `24h`, `30m`, or a date such as
 * `2026-09-01` (start of that day, UTC).
 */
export const parseSince = (value: string, now = new Date()): Date => {
  const relative = /^(\d+)([mhd])$/.exec(value.trim())
  if (relative) {
    const amount = Number(relative[1])
    const unit = { m: 60_000, h: 3_600_000, d: DAY_MS }[
      relative[2] as "m" | "h" | "d"
    ]
    return new Date(now.getTime() - amount * unit)
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    const date = new Date(`${value.trim()}T00:00:00Z`)
    if (!Number.isNaN(date.getTime())) return date
  }
  throw new Error(
    `"${value}" is not a period. Use 7d, 24h, 30m, or a date like 2026-09-01.`
  )
}

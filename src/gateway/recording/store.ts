/**
 * Where recorded requests live. One interface, two stores:
 *
 *   sqlite  one file, indexed, through Node's built-in `node:sqlite`
 *           (Node 22.5 or newer). The default where it exists.
 *   jsonl   one file per day, like the usage records. Works on every Node
 *           the gateway runs on, and is what the export format is anyway.
 *
 * A record is content: the prompt or conversation and the reply. Nothing
 * here decides whether to keep it; that is the recorder's job.
 */
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { InferenceCapability } from "../../extension/inference/types"

export type RecordingRoute = InferenceCapability

export interface RecordingUsage {
  promptTokens?: number
  completionTokens?: number
}

export interface RecordingRecord {
  /** Time-sortable: `<ms since epoch, zero-padded>-<random>`. */
  id: string
  at: string
  /** The key's name. */
  key: string
  route: RecordingRoute
  alias: string
  /** The backend model and provider name, when the route resolved. */
  model?: string
  provider?: string
  outcome: "ok" | "error" | "cancelled"
  /**
   * `client` when the client stopped reading once it had what it needed,
   * which is how an autocomplete normally ends; the text kept is what was
   * shown. Absent when the backend finished on its own.
   */
  ended?: "client"
  ms: number
  usage?: RecordingUsage
  /** The request as the protocol received it, minus the alias. */
  request: unknown
  /** The reply: `{ content }` for chat, `{ text }` for fim, `{ count, dimensions }` for embeddings. */
  response: unknown
}

/** A row in a list: everything but the content, plus a glimpse of it. */
export interface RecordingSummary {
  id: string
  at: string
  key: string
  route: RecordingRoute
  alias: string
  model?: string
  outcome: RecordingRecord["outcome"]
  ended?: "client"
  ms: number
  usage?: RecordingUsage
  preview: string
}

export interface RecordingQuery {
  route?: RecordingRoute
  key?: string
  outcome?: RecordingRecord["outcome"]
  since?: Date
  until?: Date
  /** Only records with an id before this one (older), for paging newest-first. */
  before?: string
  /** Substring of the request or reply text, case-insensitive. */
  search?: string
  limit?: number
}

export interface RecordingStore {
  readonly kind: "sqlite" | "jsonl"
  /** The file or directory. */
  readonly location: string
  append(record: RecordingRecord): void
  /** Newest first. */
  list(query?: RecordingQuery): { records: RecordingSummary[]; nextBefore?: string }
  get(id: string): RecordingRecord | undefined
  count(query?: RecordingQuery): number
  /** Every matching record, oldest first, for export. */
  each(query?: RecordingQuery): Iterable<RecordingRecord>
  /** Names of keys that have records. */
  keys(): string[]
  /** Removes records older than the instant. Returns how many. */
  prune(olderThan: Date): number
  close(): void
}

export const newRecordingId = (at = new Date()): string =>
  `${String(at.getTime()).padStart(14, "0")}-${randomBytes(4).toString("hex")}`

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

/** What a list row shows of the content: the last user turn, the prompt tail, or the inputs. */
export const previewOf = (record: RecordingRecord): string => {
  const request = record.request as Record<string, unknown> | undefined
  let text = ""
  if (record.route === "chat" && Array.isArray(request?.messages)) {
    const users = (request?.messages as Array<{ role?: string; content?: unknown }>).filter((m) => m.role === "user")
    const last = users[users.length - 1]
    text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "")
  } else if (record.route === "fim" && typeof request?.prompt === "string") {
    text = request.prompt.slice(-160)
  } else if (record.route === "embeddings") {
    const input = request?.input
    text = Array.isArray(input) ? input.map(String).join(" ⏎ ") : String(input ?? "")
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 160)
}

const textOf = (record: RecordingRecord): string =>
  `${JSON.stringify(record.request)}\n${JSON.stringify(record.response)}`.toLowerCase()

const matches = (record: RecordingRecord, query: RecordingQuery): boolean => {
  if (query.route && record.route !== query.route) return false
  if (query.key && record.key !== query.key) return false
  if (query.outcome && record.outcome !== query.outcome) return false
  if (query.since && Date.parse(record.at) < query.since.getTime()) return false
  if (query.until && Date.parse(record.at) >= query.until.getTime()) return false
  if (query.before && record.id >= query.before) return false
  if (query.search && !textOf(record).includes(query.search.toLowerCase())) return false
  return true
}

const summarize = (record: RecordingRecord): RecordingSummary => ({
  id: record.id,
  at: record.at,
  key: record.key,
  route: record.route,
  alias: record.alias,
  ...(record.model ? { model: record.model } : {}),
  outcome: record.outcome,
  ...(record.ended ? { ended: record.ended } : {}),
  ms: record.ms,
  ...(record.usage ? { usage: record.usage } : {}),
  preview: previewOf(record)
})

const clampLimit = (limit?: number) => Math.min(MAX_LIMIT, Math.max(1, limit ?? DEFAULT_LIMIT))

/* -------------------------------------------------------------------------- */
/*  JSONL: one file per day                                                   */
/* -------------------------------------------------------------------------- */

const dayOf = (iso: string) => iso.slice(0, 10)
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

export class JsonlRecordingStore implements RecordingStore {
  public readonly kind = "jsonl" as const

  constructor(public readonly location: string) {
    fs.mkdirSync(location, { recursive: true, mode: 0o700 })
  }

  public append(record: RecordingRecord): void {
    const file = path.join(this.location, `${dayOf(record.at)}.jsonl`)
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  }

  /** Day files, newest first, optionally bounded by the query's dates. */
  private days(query: RecordingQuery = {}): string[] {
    let names: string[]
    try {
      names = fs.readdirSync(this.location)
    } catch {
      return []
    }
    return names
      .map((name) => DAY_FILE.exec(name)?.[1])
      .filter((day): day is string => !!day)
      .filter((day) => (!query.since || day >= dayOf(query.since.toISOString())) && (!query.until || day <= dayOf(query.until.toISOString())))
      .sort()
      .reverse()
  }

  private *read(day: string): Iterable<RecordingRecord> {
    let text: string
    try {
      text = fs.readFileSync(path.join(this.location, `${day}.jsonl`), "utf8")
    } catch {
      return
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        yield JSON.parse(line) as RecordingRecord
      } catch {
        // A torn last line from a crash mid-write; nothing to do with it.
      }
    }
  }

  public list(query: RecordingQuery = {}): { records: RecordingSummary[]; nextBefore?: string } {
    const limit = clampLimit(query.limit)
    const records: RecordingSummary[] = []
    let nextBefore: string | undefined
    for (const day of this.days(query)) {
      const matching = [...this.read(day)].filter((record) => matches(record, query)).sort((a, b) => (a.id < b.id ? 1 : -1))
      for (const record of matching) {
        if (records.length === limit) {
          nextBefore = records[records.length - 1].id
          return { records, nextBefore }
        }
        records.push(summarize(record))
      }
    }
    return { records }
  }

  public get(id: string): RecordingRecord | undefined {
    const ms = Number(id.split("-")[0])
    if (!Number.isFinite(ms)) return undefined
    const day = dayOf(new Date(ms).toISOString())
    for (const record of this.read(day)) if (record.id === id) return record
    return undefined
  }

  public count(query: RecordingQuery = {}): number {
    let n = 0
    for (const day of this.days(query)) for (const record of this.read(day)) if (matches(record, query)) n++
    return n
  }

  public *each(query: RecordingQuery = {}): Iterable<RecordingRecord> {
    for (const day of this.days(query).reverse()) {
      const matching = [...this.read(day)].filter((record) => matches(record, query)).sort((a, b) => (a.id < b.id ? -1 : 1))
      yield* matching
    }
  }

  public keys(): string[] {
    const names = new Set<string>()
    for (const day of this.days()) for (const record of this.read(day)) names.add(record.key)
    return [...names].sort()
  }

  public prune(olderThan: Date): number {
    const cutoff = dayOf(olderThan.toISOString())
    let removed = 0
    for (const day of this.days()) {
      if (day >= cutoff) continue
      removed += [...this.read(day)].length
      fs.unlinkSync(path.join(this.location, `${day}.jsonl`))
    }
    return removed
  }

  public close(): void {
    // Nothing held open.
  }
}

/* -------------------------------------------------------------------------- */
/*  SQLite through node:sqlite                                                */
/* -------------------------------------------------------------------------- */

interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint }
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Record<string, unknown>[]
}

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

/** The built-in module, when this Node has it. */
export const loadSqlite = (): { DatabaseSync: new (file: string) => SqliteDatabase } | undefined => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const mod = require("node:sqlite") as { DatabaseSync: new (file: string) => SqliteDatabase }
    return typeof mod?.DatabaseSync === "function" ? mod : undefined
  } catch {
    return undefined
  }
}

export const sqliteAvailable = (): boolean => !!loadSqlite()

const SCHEMA = `
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  at TEXT NOT NULL,
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  alias TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  outcome TEXT NOT NULL,
  ended TEXT,
  ms INTEGER NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  request TEXT NOT NULL,
  response TEXT NOT NULL,
  preview TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recordings_ts ON recordings (ts);
CREATE INDEX IF NOT EXISTS recordings_key_ts ON recordings (key, ts);
CREATE INDEX IF NOT EXISTS recordings_route_ts ON recordings (route, ts);
`

export class SqliteRecordingStore implements RecordingStore {
  public readonly kind = "sqlite" as const
  private readonly _db: SqliteDatabase

  constructor(public readonly location: string) {
    const sqlite = loadSqlite()
    if (!sqlite) throw new Error("This Node has no built-in sqlite (node:sqlite needs Node 22.5 or newer).")
    fs.mkdirSync(path.dirname(location), { recursive: true, mode: 0o700 })
    const fresh = !fs.existsSync(location)
    this._db = new sqlite.DatabaseSync(location)
    this._db.exec("PRAGMA journal_mode = WAL")
    this._db.exec(SCHEMA)
    // Databases made before the column existed.
    try {
      this._db.exec("ALTER TABLE recordings ADD COLUMN ended TEXT")
    } catch {
      // Already there.
    }
    if (fresh) {
      try {
        fs.chmodSync(location, 0o600)
      } catch {
        // Best effort; the directory is already private.
      }
    }
  }

  public append(record: RecordingRecord): void {
    this._db
      .prepare(
        `INSERT INTO recordings (id, ts, at, key, route, alias, model, provider, outcome, ended, ms, prompt_tokens, completion_tokens, request, response, preview)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        Date.parse(record.at),
        record.at,
        record.key,
        record.route,
        record.alias,
        record.model ?? null,
        record.provider ?? null,
        record.outcome,
        record.ended ?? null,
        record.ms,
        record.usage?.promptTokens ?? null,
        record.usage?.completionTokens ?? null,
        JSON.stringify(record.request),
        JSON.stringify(record.response),
        previewOf(record)
      )
  }

  private where(query: RecordingQuery): { sql: string; params: unknown[] } {
    const clauses: string[] = []
    const params: unknown[] = []
    const add = (clause: string, value: unknown) => {
      clauses.push(clause)
      params.push(value)
    }
    if (query.route) add("route = ?", query.route)
    if (query.key) add("key = ?", query.key)
    if (query.outcome) add("outcome = ?", query.outcome)
    if (query.since) add("ts >= ?", query.since.getTime())
    if (query.until) add("ts < ?", query.until.getTime())
    if (query.before) add("id < ?", query.before)
    if (query.search) {
      const like = `%${query.search.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`
      clauses.push("(lower(request) LIKE ? ESCAPE '\\' OR lower(response) LIKE ? ESCAPE '\\')")
      params.push(like, like)
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params }
  }

  private toRecord(row: Record<string, unknown>): RecordingRecord {
    const usage: RecordingUsage = {}
    if (row.prompt_tokens !== null && row.prompt_tokens !== undefined) usage.promptTokens = Number(row.prompt_tokens)
    if (row.completion_tokens !== null && row.completion_tokens !== undefined) usage.completionTokens = Number(row.completion_tokens)
    return {
      id: String(row.id),
      at: String(row.at),
      key: String(row.key),
      route: String(row.route) as RecordingRoute,
      alias: String(row.alias),
      ...(row.model ? { model: String(row.model) } : {}),
      ...(row.provider ? { provider: String(row.provider) } : {}),
      outcome: String(row.outcome) as RecordingRecord["outcome"],
      ...(row.ended === "client" ? { ended: "client" as const } : {}),
      ms: Number(row.ms),
      ...(Object.keys(usage).length ? { usage } : {}),
      request: JSON.parse(String(row.request)),
      response: JSON.parse(String(row.response))
    }
  }

  public list(query: RecordingQuery = {}): { records: RecordingSummary[]; nextBefore?: string } {
    const limit = clampLimit(query.limit)
    const { sql, params } = this.where(query)
    const rows = this._db
      .prepare(`SELECT id, at, key, route, alias, model, outcome, ended, ms, prompt_tokens, completion_tokens, preview FROM recordings ${sql} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit + 1)
    const page = rows.slice(0, limit).map((row) => {
      const usage: RecordingUsage = {}
      if (row.prompt_tokens !== null) usage.promptTokens = Number(row.prompt_tokens)
      if (row.completion_tokens !== null) usage.completionTokens = Number(row.completion_tokens)
      return {
        id: String(row.id),
        at: String(row.at),
        key: String(row.key),
        route: String(row.route) as RecordingRoute,
        alias: String(row.alias),
        ...(row.model ? { model: String(row.model) } : {}),
        outcome: String(row.outcome) as RecordingRecord["outcome"],
        ...(row.ended === "client" ? { ended: "client" as const } : {}),
        ms: Number(row.ms),
        ...(Object.keys(usage).length ? { usage } : {}),
        preview: String(row.preview)
      }
    })
    return { records: page, ...(rows.length > limit ? { nextBefore: page[page.length - 1].id } : {}) }
  }

  public get(id: string): RecordingRecord | undefined {
    const row = this._db.prepare("SELECT * FROM recordings WHERE id = ?").get(id)
    return row ? this.toRecord(row) : undefined
  }

  public count(query: RecordingQuery = {}): number {
    const { sql, params } = this.where(query)
    const row = this._db.prepare(`SELECT count(*) AS n FROM recordings ${sql}`).get(...params)
    return Number(row?.n ?? 0)
  }

  public *each(query: RecordingQuery = {}): Iterable<RecordingRecord> {
    const { sql, params } = this.where(query)
    const rows = this._db.prepare(`SELECT * FROM recordings ${sql} ORDER BY id ASC`).all(...params)
    for (const row of rows) yield this.toRecord(row)
  }

  public keys(): string[] {
    return this._db.prepare("SELECT DISTINCT key FROM recordings ORDER BY key").all().map((row) => String(row.key))
  }

  public prune(olderThan: Date): number {
    const result = this._db.prepare("DELETE FROM recordings WHERE ts < ?").run(olderThan.getTime())
    return Number(result.changes)
  }

  public close(): void {
    this._db.close()
  }
}

/* -------------------------------------------------------------------------- */

export type RecordingStoreKind = "auto" | "sqlite" | "jsonl"

/**
 * Opens the store the configuration asks for. `auto` is sqlite when this
 * Node has it, else jsonl. Asking for sqlite where there is none is an
 * error the operator should see, not a silent downgrade.
 */
export const openRecordingStore = (kind: RecordingStoreKind, dir: string): RecordingStore => {
  const useSqlite = kind === "sqlite" || (kind === "auto" && sqliteAvailable())
  if (useSqlite) return new SqliteRecordingStore(path.join(dir, "recordings.sqlite"))
  return new JsonlRecordingStore(path.join(dir, "jsonl"))
}

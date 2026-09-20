/**
 * The audit log: who changed what on the gateway, kept where it cannot
 * be quietly edited. One JSON line per action in <dir>/YYYY-MM.jsonl;
 * every line carries the SHA-256 of the line before it, so removing or
 * altering one breaks the chain and `verify` says where.
 *
 * Recorded: keys made and revoked, invites, sign-in approvals, licence
 * changes, configuration saves, plugins switched, plugin writes, and
 * sign-ins. Never recorded: request content, secrets, tokens.
 */
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export interface AuditEntry {
  /** ISO time. */
  ts: string
  /** `admin.key-created`, `plugin.write`, `license.installed`… */
  action: string
  /** The admin key or principal that did it. */
  actor: string
  /** What it was done to: a key name, a plugin id, a route. */
  target?: string
  /** Short, never secret: e.g. `{ admin: true }`, `{ method: "PUT", path: "settings" }`. */
  details?: Record<string, string | number | boolean>
  /** The client address, when known. */
  from?: string
  /** SHA-256 hex of the previous line's full text; `genesis` for the first. */
  prev: string
}

export interface AuditQuery {
  since?: Date
  until?: Date
  actor?: string
  action?: string
  limit?: number
}

export interface AuditVerification {
  ok: boolean
  entries: number
  /** The first file and line that did not match, when not ok. */
  brokenAt?: { file: string; line: number; reason: string }
}

const FILE_PATTERN = /^(\d{4}-\d{2})\.jsonl$/
const GENESIS = "genesis"

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

/** The line's own hash covers its text; the next line's `prev` must equal it. */
const hashOf = (line: string): string => sha256(line)

const monthOf = (iso: string): string => iso.slice(0, 7)

export class AuditLog {
  /** The hash of the last line written, so the chain continues across calls. */
  private _last: string | undefined

  constructor(
    public readonly dir: string,
    private readonly _now: () => number = Date.now
  ) {}

  public static open(dir: string, now?: () => number): AuditLog {
    const log = new AuditLog(dir, now)
    log._last = log.lastHash()
    return log
  }

  private files(): string[] {
    let names: string[]
    try {
      names = fs.readdirSync(this.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    return names.filter((name) => FILE_PATTERN.test(name)).sort()
  }

  private lastHash(): string {
    const files = this.files()
    if (files.length === 0) return GENESIS
    const lines = fs.readFileSync(path.join(this.dir, files[files.length - 1]), "utf8").split("\n").filter(Boolean)
    return lines.length ? hashOf(lines[lines.length - 1]) : GENESIS
  }

  public record(entry: Omit<AuditEntry, "ts" | "prev"> & { ts?: string }): AuditEntry {
    const full: AuditEntry = {
      ts: entry.ts ?? new Date(this._now()).toISOString(),
      action: entry.action,
      actor: entry.actor,
      ...(entry.target ? { target: entry.target } : {}),
      ...(entry.details && Object.keys(entry.details).length ? { details: entry.details } : {}),
      ...(entry.from ? { from: entry.from } : {}),
      prev: this._last ?? this.lastHash()
    }
    const line = JSON.stringify(full)
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    fs.appendFileSync(path.join(this.dir, `${monthOf(full.ts)}.jsonl`), `${line}\n`, { mode: 0o600 })
    this._last = hashOf(line)
    return full
  }

  /** Newest first. */
  public query(query: AuditQuery = {}): AuditEntry[] {
    const limit = query.limit ?? 200
    const out: AuditEntry[] = []
    const files = this.files().reverse()
    for (const file of files) {
      const month = file.slice(0, 7)
      if (query.since && month < monthOf(query.since.toISOString())) break
      if (query.until && month > monthOf(query.until.toISOString())) continue
      const lines = fs.readFileSync(path.join(this.dir, file), "utf8").split("\n").filter(Boolean).reverse()
      for (const line of lines) {
        let entry: AuditEntry
        try {
          entry = JSON.parse(line) as AuditEntry
        } catch {
          continue
        }
        if (query.since && entry.ts < query.since.toISOString()) continue
        if (query.until && entry.ts > query.until.toISOString()) continue
        if (query.actor && entry.actor !== query.actor) continue
        if (query.action && !entry.action.startsWith(query.action)) continue
        out.push(entry)
        if (out.length >= limit) return out
      }
    }
    return out
  }

  /** Every line in order, as text, for an export. */
  public export(): string {
    return this.files()
      .map((file) => fs.readFileSync(path.join(this.dir, file), "utf8"))
      .join("")
  }

  /** Walks the chain from the first line; the first break is reported. */
  public verify(): AuditVerification {
    let prev = GENESIS
    let entries = 0
    for (const file of this.files()) {
      const lines = fs.readFileSync(path.join(this.dir, file), "utf8").split("\n").filter(Boolean)
      for (let i = 0; i < lines.length; i++) {
        let entry: AuditEntry
        try {
          entry = JSON.parse(lines[i]) as AuditEntry
        } catch {
          return { ok: false, entries, brokenAt: { file, line: i + 1, reason: "not JSON" } }
        }
        if (entry.prev !== prev)
          return { ok: false, entries, brokenAt: { file, line: i + 1, reason: "the previous line was changed or removed" } }
        prev = hashOf(lines[i])
        entries++
      }
    }
    return { ok: true, entries }
  }
}

/**
 * Issue triage: a model reads a new issue with the repository's labels
 * and the other open issues, and suggests labels, a duplicate if it sees
 * one, a priority and a first reply. Kept on the server until someone
 * posts the reply or applies the labels, or auto-triage does both.
 */
import fs from "node:fs"

import { messageOf } from "../../common/errors"
import { isRecord } from "../../common/guards"
import type { ChatMessage } from "../../extension/inference/types"
import { writePrivateJson } from "../private-file"

import { PluginError } from "./host"
import { type PluginInference, repoWorkspace } from "./inference"
import { stripThinking } from "./reviews"

export const TRIAGE_MAX_TOKENS = 1_200
export const TRIAGE_TIMEOUT_MS = 5 * 60_000
const BODY_BUDGET = 6_000
const OTHERS_SHOWN = 40
const MAX_TRIAGES = 2_000

export interface IssueSummary {
  repo: string
  number: number
  title: string
  author: string
  url: string
  createdAt: string
  updatedAt: string
  labels: string[]
  comments: number
}

export type TriagePriority = "low" | "medium" | "high"

export interface TriageRecord {
  repoId: string
  number: number
  alias: string
  requestedBy: string
  createdAt: string
  ms: number
  status: "done" | "failed"
  labels: string[]
  duplicateOf?: number
  priority?: TriagePriority
  reply: string
  /** The model's raw answer, for the curious. */
  text: string
  error?: string
  repliedAt?: string
  labeledAt?: string
}

export interface TriageBrief {
  createdAt: string
  status: TriageRecord["status"]
  labels: string[]
  duplicateOf?: number
  priority?: TriagePriority
  replied: boolean
  labeled: boolean
}

interface TriageFile {
  version: 1
  triages: TriageRecord[]
}

export class TriageStore {
  private _triages: TriageRecord[] = []

  constructor(public readonly file: string) {}

  public static open(file: string): TriageStore {
    const store = new TriageStore(file)
    store.reload()
    return store
  }

  public latest(repoId: string, number: number): TriageRecord | undefined {
    const mine = this._triages.filter((t) => t.repoId === repoId && t.number === number)
    return mine.length ? { ...mine[mine.length - 1] } : undefined
  }

  public brief(repoId: string, number: number): TriageBrief | undefined {
    const t = this.latest(repoId, number)
    return (
      t && {
        createdAt: t.createdAt,
        status: t.status,
        labels: t.labels,
        ...(t.duplicateOf !== undefined ? { duplicateOf: t.duplicateOf } : {}),
        ...(t.priority ? { priority: t.priority } : {}),
        replied: !!t.repliedAt,
        labeled: !!t.labeledAt
      }
    )
  }

  public put(record: TriageRecord): void {
    this._triages = this._triages.filter((t) => !(t.repoId === record.repoId && t.number === record.number))
    this._triages.push(record)
    if (this._triages.length > MAX_TRIAGES) this._triages = this._triages.slice(-MAX_TRIAGES)
    this.save()
  }

  public forgetRepo(repoId: string): void {
    const before = this._triages.length
    this._triages = this._triages.filter((t) => t.repoId !== repoId)
    if (this._triages.length !== before) this.save()
  }

  public reload(): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this._triages = []
        return
      }
      throw error
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.triages)) throw new Error(`${this.file} is not a twinny-server triage file.`)
    this._triages = parsed.triages.filter(
      (t): t is TriageRecord => isRecord(t) && typeof t.repoId === "string" && typeof t.number === "number" && (t.status === "done" || t.status === "failed")
    )
  }

  private save(): void {
    const content: TriageFile = { version: 1, triages: this._triages }
    writePrivateJson(this.file, content)
  }
}

const SYSTEM_PROMPT = `You triage issues for a software project's maintainers. You see one new issue, the labels the project uses, and the titles of the other open issues.

Answer with JSON only, no prose, no code fence, in exactly this shape:
{"labels": ["..."], "duplicateOf": null, "priority": "low" | "medium" | "high", "reply": "..."}

Rules:
- labels: only names from the project's list, the ones that fit; an empty list if none do.
- duplicateOf: the number of an open issue that reports the same thing, or null. Only when you are sure.
- priority: high for data loss, security, crashes for many users or a blocked release; low for cosmetics and ideas; medium otherwise.
- reply: two to five sentences to the reporter, in Markdown: thank them briefly, say what you understood, ask for anything missing (version, steps, logs), and if it is a duplicate point to the other issue. Do not promise a fix or a date. Do not invent facts about the project.`

export const triageMessages = (issue: IssueSummary, body: string, labels: string[], others: IssueSummary[]): ChatMessage[] => {
  const text = body.trim()
  const user = [
    `# Issue #${issue.number}: ${issue.title}`,
    `Opened by ${issue.author}. Labels already on it: ${issue.labels.length ? issue.labels.join(", ") : "none"}.`,
    "",
    "## Body",
    text ? (text.length > BODY_BUDGET ? `${text.slice(0, BODY_BUDGET)}\n\n[cut here]` : text) : "(empty)",
    "",
    "## Labels the project uses",
    labels.length ? labels.join(", ") : "(none)",
    "",
    "## Other open issues",
    ...others
      .filter((other) => other.number !== issue.number)
      .slice(0, OTHERS_SHOWN)
      .map((other) => `- #${other.number}: ${other.title}`),
    others.length <= 1 ? "(none)" : ""
  ].join("\n")
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user }
  ]
}

/** Reads the model's JSON, tolerating a code fence or prose around it. */
export const parseTriage = (
  text: string,
  knownLabels: string[]
): { labels: string[]; duplicateOf?: number; priority?: TriagePriority; reply: string } => {
  const cleaned = stripThinking(text)
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start === -1 || end <= start) throw new Error("The model did not answer with JSON.")
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    throw new Error("The model's JSON could not be read.")
  }
  if (!isRecord(parsed)) throw new Error("The model's answer was not an object.")
  const known = new Map(knownLabels.map((label) => [label.toLowerCase(), label]))
  const labels = (Array.isArray(parsed.labels) ? parsed.labels : [])
    .filter((label): label is string => typeof label === "string")
    .map((label) => known.get(label.trim().toLowerCase()))
    .filter((label): label is string => !!label)
  const duplicateOf = typeof parsed.duplicateOf === "number" && Number.isInteger(parsed.duplicateOf) && parsed.duplicateOf > 0 ? parsed.duplicateOf : undefined
  const priority = parsed.priority === "low" || parsed.priority === "medium" || parsed.priority === "high" ? parsed.priority : undefined
  const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : ""
  return { labels: [...new Set(labels)], ...(duplicateOf !== undefined ? { duplicateOf } : {}), ...(priority ? { priority } : {}), reply }
}

export interface TriageJob {
  repoId: string
  issue: IssueSummary
  body: () => Promise<string>
  labels: () => Promise<string[]>
  others: IssueSummary[]
  alias: string
  requestedBy: string
}

export class Triager {
  private readonly _running = new Set<string>()

  constructor(
    private readonly _store: TriageStore,
    private readonly _inference: PluginInference | undefined,
    private readonly _now: () => number = Date.now
  ) {}

  public isTriaging(repoId: string, number: number): boolean {
    return this._running.has(`${repoId}#${number}`)
  }

  public async triage(job: TriageJob, signal: AbortSignal): Promise<TriageRecord> {
    const inference = this._inference
    if (!inference) throw new PluginError("This gateway offers plugins no models, so triage is unavailable.", 503)
    const key = `${job.repoId}#${job.issue.number}`
    if (this._running.has(key)) throw new PluginError(`#${job.issue.number} is being triaged already.`, 409)
    if (!inference.chatAliases().includes(job.alias)) throw new PluginError(`No chat model is served as "${job.alias}".`, 409)
    this._running.add(key)
    const started = this._now()
    const base = { repoId: job.repoId, number: job.issue.number, alias: job.alias, requestedBy: job.requestedBy }
    try {
      const [body, labels] = await Promise.all([job.body(), job.labels()])
      let text = ""
      for await (const piece of inference.chat(job.alias, triageMessages(job.issue, body, labels, job.others), { signal, maxTokens: TRIAGE_MAX_TOKENS, temperature: 0.1, think: false, workspace: repoWorkspace(job.issue.repo) }))
        text += piece
      const parsed = parseTriage(text, labels)
      const record: TriageRecord = { ...base, createdAt: new Date(this._now()).toISOString(), ms: this._now() - started, status: "done", ...parsed, text: text.trim() }
      this._store.put(record)
      return record
    } catch (error) {
      const record: TriageRecord = {
        ...base,
        createdAt: new Date(this._now()).toISOString(),
        ms: this._now() - started,
        status: "failed",
        labels: [],
        reply: "",
        text: "",
        error: messageOf(error)
      }
      this._store.put(record)
      return record
    } finally {
      this._running.delete(key)
    }
  }
}

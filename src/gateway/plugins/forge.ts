/**
 * What a forge plugin is made of. A host ("forge") supplies how to talk
 * to its API and what a pull looks like there; this is the contract it
 * fills, the shapes the page reads, the watched-repository file with its
 * tokens, and the small helpers every host uses to read an answer.
 *
 * The plugin that drives a forge is in pulls.ts.
 */
import { randomBytes } from "node:crypto"
import fs from "node:fs"

import { messageOf } from "../../common/errors"
import { isRecord } from "../../common/guards"
import { writePrivateJson } from "../private-file"

import { PluginError, PluginRequest, PluginResponse } from "./host"
import type { ReviewBrief, ReviewPostAs, ReviewRecord } from "./reviews"
import type { IssueSummary, TriageBrief } from "./triage"

export type { ReviewPostAs } from "./reviews"
export type { IssueSummary } from "./triage"

/** Open pulls kept per repository; beyond that, the oldest are left out. */
export const MAX_PULLS_PER_REPO = 50
/** Watched repositories per plugin. */
export const MAX_REPOS = 100
/** Files shown for one pull; the rest are counted. */
export const MAX_FILES = 200
/** A patch longer than this is cut and marked so. */
export const MAX_PATCH_CHARS = 60_000
/** `owner/name`, or `group/sub/project` on GitLab. */
export const FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/


export type CheckState = "success" | "failure" | "pending" | "none"
export type MergeState = "mergeable" | "conflicting" | "blocked" | "unknown"
export type ReviewState =
  | "approved"
  | "changes-requested"
  | "review-required"
  | "none"

export interface PullCheck {
  name: string
  state: CheckState
  url?: string
}

/**
 * Who has said what on a pull: each reviewer's latest word counts once.
 * `required` is what the base branch demands before a merge, when the
 * host tells (branch protection, approval rules).
 */
export interface PullApprovals {
  /** Reviewers whose latest review approves. */
  approved: string[]
  /** Reviewers whose latest review asks for changes. */
  changes: string[]
  /** Reviewers asked who have not answered yet. */
  pending: string[]
  required?: number
}

/** One open pull request, the same shape whichever host it came from. */
export interface PullSummary {
  repo: string
  number: number
  title: string
  author: string
  url: string
  draft: boolean
  createdAt: string
  updatedAt: string
  headRef: string
  baseRef: string
  headSha: string
  additions?: number
  deletions?: number
  changedFiles?: number
  checks: CheckState
  checkRuns: PullCheck[]
  mergeable: MergeState
  review: ReviewState
  /** Missing when the host gives no per-reviewer detail. */
  approvals?: PullApprovals
  labels: string[]
}

export interface PullFile {
  path: string
  previousPath?: string
  status: "added" | "removed" | "modified" | "renamed"
  additions: number
  deletions: number
  patch?: string
  /** The patch was cut at MAX_PATCH_CHARS. */
  truncated?: boolean
}

export interface PullContent {
  body: string
  files: PullFile[]
  /** Files beyond MAX_FILES, not listed. */
  moreFiles: number
}

export interface RepoRecord {
  id: string
  fullName: string
  /** `token`: its own token. `app`: the host's app credentials (GitHub only). */
  auth: "token" | "app"
  token?: string
  addedAt: string
  addedBy: string
  /** Review new and updated pulls in the background while the models are idle. */
  autoReview?: boolean
  /** Post every finished review to the host as a comment, without anyone pressing the button. */
  autoPost?: boolean
  /** Triage new issues in the background while the models are idle; replies and labels still wait for a click. */
  autoTriage?: boolean
}

/** What the page sees: never the token. */
export interface RepoView {
  id: string
  fullName: string
  url: string
  auth: "token" | "app"
  addedAt: string
  addedBy: string
  autoReview: boolean
  autoPost: boolean
  autoTriage: boolean
  /** Whether this host has an issue tracker the plugin can read. */
  issuesSupported: boolean
  issues: IssueSummary[]
  issuesError?: string
  /** The latest triage per issue number, without the reply. */
  triage: Record<number, TriageBrief>
  syncing: boolean
  syncedAt?: string
  error?: string
  pulls: PullSummary[]
  /** The latest review per pull number, without its text. */
  reviews: Record<number, ReviewBrief>
}

export interface PullDetail extends PullContent {
  pull: PullSummary
}

/** What the page gets for one pull: the detail plus its review state. */
export interface PullPage extends PullDetail {
  review?: ReviewRecord
  reviewing: boolean
}

/** How a host is talked to. Instances live as long as the plugin runs. */
export interface Forge {
  /** "Pull request" or "Merge request", for prompts. */
  readonly noun: string
  /** The repository's web page. */
  repoUrl(fullName: string): string
  /** Whether repositories may be added without a token of their own. */
  hasAppAuth(): boolean
  /** Confirms the repository exists and is readable; returns its canonical name. */
  checkRepo(repo: RepoRecord, signal: AbortSignal): Promise<string>
  listPulls(repo: RepoRecord, signal: AbortSignal): Promise<PullSummary[]>
  /** The description and changed files; the summary comes from the last sync. */
  pullContent(
    repo: RepoRecord,
    number: number,
    signal: AbortSignal
  ): Promise<PullContent>
  /**
   * Posts a review to the host. `as` is what the host should record it
   * as; a host without that notion posts a comment. Returns where it
   * can be seen, when the host says.
   */
  postReview(repo: RepoRecord, pull: PullSummary, body: string, as: ReviewPostAs, signal: AbortSignal): Promise<{ url?: string }>
  /** The username the repository's token acts as; nothing for app credentials. */
  whoAmI?(repo: RepoRecord, signal: AbortSignal): Promise<string | undefined>
  /** Open issues, on hosts that have an issue tracker the plugin reads. */
  listIssues?(repo: RepoRecord, signal: AbortSignal): Promise<IssueSummary[]>
  issueBody?(repo: RepoRecord, number: number, signal: AbortSignal): Promise<string>
  listLabels?(repo: RepoRecord, signal: AbortSignal): Promise<string[]>
  commentIssue?(repo: RepoRecord, number: number, body: string, signal: AbortSignal): Promise<{ url?: string }>
  labelIssue?(repo: RepoRecord, number: number, labels: string[], signal: AbortSignal): Promise<void>
  /** Host-specific state for the page (e.g. the GitHub App), never secrets. */
  status(): unknown
  /** Host-specific routes under `api/`, after the shared ones did not match. */
  handle?(request: PluginRequest): Promise<PluginResponse | undefined>
}

interface ReposFile {
  version: 1
  repos: RepoRecord[]
  /** Host-specific settings, e.g. GitHub App credentials. */
  settings: Record<string, unknown>
}

const parseReposFile = (text: string, file: string): ReposFile => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON: ${messageOf(error)}`
    )
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.repos))
    throw new Error(`${file} is not a twinny-server repositories file.`)
  const repos: RepoRecord[] = []
  for (const entry of parsed.repos) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.fullName !== "string" ||
      (entry.auth !== "token" && entry.auth !== "app") ||
      typeof entry.addedAt !== "string" ||
      typeof entry.addedBy !== "string"
    )
      throw new Error(`${file} has a malformed repository entry.`)
    repos.push({
      id: entry.id,
      fullName: entry.fullName,
      auth: entry.auth,
      ...(typeof entry.token === "string" ? { token: entry.token } : {}),
      addedAt: entry.addedAt,
      addedBy: entry.addedBy,
      ...(entry.autoReview === true ? { autoReview: true } : {}),
      ...(entry.autoPost === true ? { autoPost: true } : {}),
      ...(entry.autoTriage === true ? { autoTriage: true } : {})
    })
  }
  return {
    version: 1,
    repos,
    settings: isRecord(parsed.settings) ? parsed.settings : {}
  }
}

/** The plugin's file: repositories, their tokens and the host's settings. */
export class RepoStore {
  private _repos: RepoRecord[] = []
  private _settings: Record<string, unknown> = {}

  constructor(public readonly file: string) {}

  public static open(file: string): RepoStore {
    const store = new RepoStore(file)
    store.reload()
    return store
  }

  public repos(): RepoRecord[] {
    return this._repos.map((repo) => ({ ...repo }))
  }

  public get(id: string): RepoRecord | undefined {
    const repo = this._repos.find((entry) => entry.id === id)
    return repo && { ...repo }
  }

  public byName(fullName: string): RepoRecord | undefined {
    const wanted = fullName.toLowerCase()
    const repo = this._repos.find(
      (entry) => entry.fullName.toLowerCase() === wanted
    )
    return repo && { ...repo }
  }

  public add(repo: Omit<RepoRecord, "id">): RepoRecord {
    if (this._repos.length >= MAX_REPOS)
      throw new PluginError(
        `This plugin watches at most ${MAX_REPOS} repositories.`,
        429
      )
    let id = randomBytes(4).toString("hex")
    while (this._repos.some((entry) => entry.id === id))
      id = randomBytes(4).toString("hex")
    const record: RepoRecord = { id, ...repo }
    this._repos.push(record)
    this.save()
    return { ...record }
  }

  public update(id: string, changes: Partial<Pick<RepoRecord, "autoReview" | "autoPost" | "autoTriage">>): RepoRecord {
    const repo = this._repos.find((entry) => entry.id === id)
    if (!repo) throw new PluginError("No such repository.", 404)
    if (changes.autoReview === true) repo.autoReview = true
    else if (changes.autoReview === false) delete repo.autoReview
    if (changes.autoPost === true) repo.autoPost = true
    else if (changes.autoPost === false) delete repo.autoPost
    if (changes.autoTriage === true) repo.autoTriage = true
    else if (changes.autoTriage === false) delete repo.autoTriage
    this.save()
    return { ...repo }
  }

  public remove(id: string): boolean {
    const before = this._repos.length
    this._repos = this._repos.filter((entry) => entry.id !== id)
    if (this._repos.length === before) return false
    this.save()
    return true
  }

  public settings(): Record<string, unknown> {
    return { ...this._settings }
  }

  public setSettings(settings: Record<string, unknown>): void {
    this._settings = { ...settings }
    this.save()
  }

  public reload(): void {
    try {
      const parsed = parseReposFile(fs.readFileSync(this.file, "utf8"), this.file)
      this._repos = parsed.repos
      this._settings = parsed.settings
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this._repos = []
        this._settings = {}
        return
      }
      throw error
    }
  }

  private save(): void {
    const content: ReposFile = {
      version: 1,
      repos: this._repos,
      settings: this._settings
    }
    writePrivateJson(this.file, content)
  }
}

export const cutPatch = (patch: string | undefined): Pick<PullFile, "patch" | "truncated"> => {
  if (patch === undefined) return {}
  if (patch.length <= MAX_PATCH_CHARS) return { patch }
  return { patch: patch.slice(0, MAX_PATCH_CHARS), truncated: true }
}

/** An `https://host` origin for a self-hosted instance; the path is dropped. */
export const cleanBaseUrl = (value: string): string => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PluginError(`"${value}" is not a URL.`, 400)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new PluginError("The host URL must start with https:// or http://.", 400)
  return url.origin
}

/** The origin a plugin talks to: its setting, or the public host. */
export const baseUrlOf = (store: RepoStore, fallback: string): string => {
  const set = store.settings().baseUrl
  return typeof set === "string" && set ? set : fallback
}

/** Reads a JSON answer, turning HTTP failures into a message the page can show. */
export const readJson = async (
  response: Response,
  what: string
): Promise<Record<string, unknown>> => {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = undefined
  }
  if (!response.ok) {
    const detail =
      isRecord(parsed) && typeof parsed.message === "string"
        ? parsed.message
        : isRecord(parsed) && typeof parsed.error === "string"
          ? parsed.error
          : ""
    const why =
      response.status === 401
        ? "the token was refused"
        : response.status === 403
          ? "the token is not allowed to read this (or the rate limit is hit)"
          : response.status === 404
            ? "not found, or the token cannot see it"
            : `status ${response.status}`
    throw new PluginError(
      `${what}: ${why}${detail ? ` (${detail})` : ""}.`,
      502
    )
  }
  if (!isRecord(parsed) && !Array.isArray(parsed))
    throw new PluginError(`${what}: the answer was not JSON.`, 502)
  return parsed as Record<string, unknown>
}

export const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback
export const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined
export const rec = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {}
export const arr = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : []

/**
 * A whole unified diff (as `git diff` or a host's `.diff` route gives it)
 * split into one entry per file, with counts, capped like everything else.
 */
export const splitUnifiedDiff = (text: string): { files: PullFile[]; moreFiles: number } => {
  const files: PullFile[] = []
  let moreFiles = 0
  const chunks = text.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "))
  for (const chunk of chunks) {
    if (files.length >= MAX_FILES) {
      moreFiles++
      continue
    }
    const lines = chunk.split("\n")
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(lines[0])
    const oldPath = header?.[1] ?? ""
    const newPath = header?.[2] ?? oldPath
    let status: PullFile["status"] = "modified"
    if (lines.some((line) => line.startsWith("new file mode"))) status = "added"
    else if (lines.some((line) => line.startsWith("deleted file mode"))) status = "removed"
    else if (lines.some((line) => line.startsWith("rename from")) || (oldPath && newPath && oldPath !== newPath)) status = "renamed"
    const bodyStart = lines.findIndex((line) => line.startsWith("@@"))
    const body = bodyStart === -1 ? "" : lines.slice(bodyStart).join("\n").replace(/\n$/, "")
    let additions = 0
    let deletions = 0
    for (const line of body.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++
    }
    files.push({
      path: status === "removed" ? oldPath : newPath,
      ...(status === "renamed" ? { previousPath: oldPath } : {}),
      status,
      additions,
      deletions,
      ...cutPatch(body || undefined)
    })
  }
  return { files, moreFiles }
}

/** One state for a set of checks: any failure fails, any pending pends. */
export const rollup = (checks: PullCheck[]): CheckState => {
  if (checks.length === 0) return "none"
  if (checks.some((check) => check.state === "failure")) return "failure"
  if (checks.some((check) => check.state === "pending")) return "pending"
  return "success"
}

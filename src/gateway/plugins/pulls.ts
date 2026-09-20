/**
 * What the GitHub and GitLab plugins share: a list of watched repositories
 * with their credentials, a sync loop that keeps each repository's open
 * pull requests in memory, and the admin routes the page uses.
 *
 *   GET    api/                        → repositories with their open pulls and sync state
 *   POST   api/repos { fullName, token? }
 *   DELETE api/repos/<id>
 *   POST   api/repos/<id>/sync
 *   POST   api/sync
 *   GET    api/repos/<id>/pulls/<n>    → one pull with its description and files
 *
 * A host ("forge") supplies what differs: how to talk to the API and what
 * a pull looks like there. Tokens are kept in the plugin's repos.json,
 * owner-readable only, and never leave the process: the listing shows
 * only whether a repository has one.
 */
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import {
  json,
  notFound,
  PluginContext,
  PluginError,
  PluginInstance,
  PluginRequest,
  PluginResponse
} from "./host"
import {
  REVIEW_TIMEOUT_MS,
  ReviewBrief,
  Reviewer,
  ReviewRecord,
  ReviewStore} from "./reviews"

export const SYNC_INTERVAL_MS = 5 * 60_000
/** How often a pending background review is retried while developers are busy. */
export const REVIEW_TICK_MS = 60_000
/** Open pulls kept per repository; beyond that, the oldest are left out. */
export const MAX_PULLS_PER_REPO = 50
/** Watched repositories per plugin. */
export const MAX_REPOS = 100
/** Files shown for one pull; the rest are counted. */
export const MAX_FILES = 200
/** A patch longer than this is cut and marked so. */
export const MAX_PATCH_CHARS = 60_000
const REQUEST_TIMEOUT_MS = 30_000
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseReposFile = (text: string, file: string): ReposFile => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
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
      ...(entry.autoReview === true ? { autoReview: true } : {})
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

  public update(id: string, changes: Partial<Pick<RepoRecord, "autoReview">>): RepoRecord {
    const repo = this._repos.find((entry) => entry.id === id)
    if (!repo) throw new PluginError("No such repository.", 404)
    if (changes.autoReview === true) repo.autoReview = true
    else if (changes.autoReview === false) delete repo.autoReview
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
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const content: ReposFile = {
      version: 1,
      repos: this._repos,
      settings: this._settings
    }
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, {
      mode: 0o600
    })
    fs.renameSync(tmp, this.file)
  }
}

interface SyncState {
  syncing: boolean
  syncedAt?: string
  error?: string
  pulls: PullSummary[]
}

/** A signal that fires on a timeout or when the plugin stops, whichever first. */
const withTimeout = (parent: AbortSignal, ms: number): AbortSignal => {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`No answer within ${ms / 1000} s.`)),
    ms
  )
  const onParent = () => controller.abort(parent.reason)
  if (parent.aborted) onParent()
  else parent.addEventListener("abort", onParent, { once: true })
  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer)
      parent.removeEventListener("abort", onParent)
    },
    { once: true }
  )
  return controller.signal
}

/** A signal that fires after `ms`, for one-off requests outside the sync loop. */
export const timeoutSignal = (ms: number): AbortSignal => {
  const controller = new AbortController()
  setTimeout(
    () => controller.abort(new Error(`No answer within ${ms / 1000} s.`)),
    ms
  ).unref()
  return controller.signal
}

export const cutPatch = (patch: string | undefined): Pick<PullFile, "patch" | "truncated"> => {
  if (patch === undefined) return {}
  if (patch.length <= MAX_PATCH_CHARS) return { patch }
  return { patch: patch.slice(0, MAX_PATCH_CHARS), truncated: true }
}

/** The plugin instance both hosts run; the forge is the only difference. */
export class PullsPlugin implements PluginInstance {
  public readonly store: RepoStore
  public readonly reviews: ReviewStore
  private readonly _reviewer: Reviewer
  private readonly _state = new Map<string, SyncState>()
  private readonly _stopped = new AbortController()
  private _timer: NodeJS.Timeout | undefined
  private _reviewTimer: NodeJS.Timeout | undefined
  private _syncing: Promise<void> | undefined
  private _autoReviewing: Promise<void> | undefined
  private readonly _forge: Forge

  constructor(
    private readonly _context: PluginContext,
    forge: (store: RepoStore, context: PluginContext) => Forge,
    /** For tests: run the loop faster, or not at all with 0. */
    private readonly _intervalMs = SYNC_INTERVAL_MS,
    /** Named as the source of the events it emits. */
    private readonly _pluginId = "pulls"
  ) {
    this.store = RepoStore.open(path.join(_context.dataDir, "repos.json"))
    this.reviews = ReviewStore.open(path.join(_context.dataDir, "reviews.json"))
    this._reviewer = new Reviewer(this.reviews, _context.inference, _context.now)
    this._forge = forge(this.store, _context)
  }

  public start(): void {
    void this.syncAll().then(() => this.autoReview())
    if (this._intervalMs > 0) {
      this._timer = setInterval(
        () => void this.syncAll().then(() => this.autoReview()),
        this._intervalMs
      )
      this._timer.unref()
      // Between syncs, a review that waited for the models to go idle gets its chance.
      this._reviewTimer = setInterval(
        () => void this.autoReview(),
        Math.min(REVIEW_TICK_MS, this._intervalMs)
      )
      this._reviewTimer.unref()
    }
  }

  public async stop(): Promise<void> {
    if (this._timer) clearInterval(this._timer)
    if (this._reviewTimer) clearInterval(this._reviewTimer)
    this._stopped.abort(new Error("The plugin stopped."))
    await this._syncing?.catch(() => undefined)
    await this._autoReviewing?.catch(() => undefined)
  }

  /** The alias reviews use: the setting, else the first chat alias the gateway serves. */
  public reviewAlias(): string | undefined {
    const set = this.store.settings().reviewAlias
    const aliases = this._reviewer.aliases()
    return typeof set === "string" && set ? set : aliases[0]
  }

  /**
   * One background review, if one is due and the models are idle: the
   * newest pull of an auto-review repository whose current commit has no
   * review yet. Drafts wait until they are not. Called after each sync
   * and once a minute; a call while one runs does nothing.
   */
  public autoReview(): Promise<void> {
    if (this._autoReviewing) return this._autoReviewing
    if (this._stopped.signal.aborted || !this._reviewer.available || !this._reviewer.idle())
      return Promise.resolve()
    const alias = this.reviewAlias()
    if (!alias) return Promise.resolve()
    const due = this.store
      .repos()
      .filter((repo) => repo.autoReview)
      .flatMap((repo) => (this._state.get(repo.id)?.pulls ?? []).map((pull) => ({ repo, pull })))
      .filter(({ repo, pull }) => !pull.draft && !this.reviews.hasCurrent(pull, repo.id) && !this._reviewer.isReviewing(repo.id, pull.number))
      .sort((a, b) => Date.parse(b.pull.updatedAt) - Date.parse(a.pull.updatedAt))
    const next = due[0]
    if (!next) return Promise.resolve()
    this._autoReviewing = this.runReview(next.repo, next.pull, alias, "auto")
      .then(() => undefined)
      .finally(() => {
        this._autoReviewing = undefined
      })
    return this._autoReviewing
  }

  private async runReview(
    repo: RepoRecord,
    pull: PullSummary,
    alias: string,
    requestedBy: string
  ): Promise<ReviewRecord> {
    const signal = withTimeout(this._stopped.signal, REVIEW_TIMEOUT_MS)
    const review = await this._reviewer.review(
      {
        repoId: repo.id,
        pull,
        alias,
        requestedBy,
        noun: this._forge.noun,
        detail: async () => ({
          pull,
          ...(await this._forge.pullContent(repo, pull.number, signal))
        })
      },
      signal
    )
    this._context.log.info({
      event: review.status === "done" ? "plugin.reviewed" : "plugin.review-failed",
      key: requestedBy,
      reason: `${repo.fullName}#${pull.number}`,
      alias,
      ms: review.ms,
      ...(review.error ? { message: review.error } : {})
    })
    const label = `${repo.fullName}${this._forge.noun === "Merge request" ? "!" : "#"}${pull.number}`
    if (review.status === "done") {
      const verdict = verdictOf(review.text)
      const changes = verdict === "request changes"
      this._context.events?.emit({
        type: changes ? "review.changes" : "review.done",
        source: this._pluginId,
        level: changes ? "warn" : "info",
        title: `Review of ${label}: ${verdict ?? "done"}`,
        text: `${pull.title} by ${pull.author}, reviewed by ${alias} in ${Math.round(review.ms / 1000)} s.\n${summaryOf(review.text)}`,
        url: pull.url,
        data: { repo: repo.fullName, number: pull.number, verdict, alias }
      })
    } else {
      this._context.events?.emit({
        type: "review.failed",
        source: this._pluginId,
        level: "error",
        title: `Review of ${label} failed`,
        text: review.error ?? "",
        url: pull.url,
        data: { repo: repo.fullName, number: pull.number, alias }
      })
    }
    return review
  }

  public views(): RepoView[] {
    return this.store.repos().map((repo) => this.view(repo))
  }

  private view(repo: RepoRecord): RepoView {
    const state = this._state.get(repo.id)
    return {
      id: repo.id,
      fullName: repo.fullName,
      url: this._forge.repoUrl(repo.fullName),
      auth: repo.auth,
      addedAt: repo.addedAt,
      addedBy: repo.addedBy,
      autoReview: repo.autoReview === true,
      syncing: state?.syncing ?? false,
      ...(state?.syncedAt ? { syncedAt: state.syncedAt } : {}),
      ...(state?.error ? { error: state.error } : {}),
      pulls: state?.pulls ?? [],
      reviews: Object.fromEntries(
        (state?.pulls ?? []).flatMap((pull) => {
          const brief = this.reviews.brief(repo.id, pull)
          return brief ? [[pull.number, brief]] : []
        })
      )
    }
  }

  /** Syncs every repository, one after another; a second call while one runs waits for it. */
  public syncAll(): Promise<void> {
    if (this._syncing) return this._syncing
    this._syncing = (async () => {
      for (const repo of this.store.repos()) {
        if (this._stopped.signal.aborted) return
        await this.syncOne(repo)
      }
    })().finally(() => {
      this._syncing = undefined
    })
    return this._syncing
  }

  public async syncOne(repo: RepoRecord): Promise<void> {
    const state: SyncState = this._state.get(repo.id) ?? {
      syncing: false,
      pulls: []
    }
    if (state.syncing) return
    state.syncing = true
    this._state.set(repo.id, state)
    try {
      const pulls = await this._forge.listPulls(
        repo,
        withTimeout(this._stopped.signal, REQUEST_TIMEOUT_MS)
      )
      const before = state.syncedAt ? state.pulls : undefined
      state.pulls = pulls
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, MAX_PULLS_PER_REPO)
      state.syncedAt = new Date(this._context.now()).toISOString()
      delete state.error
      if (before) this.announce(repo, before, state.pulls)
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
      this._context.log.warn({
        event: "plugin.sync-failed",
        reason: repo.fullName,
        message: state.error
      })
    } finally {
      state.syncing = false
    }
  }

  public async handle(request: PluginRequest): Promise<PluginResponse> {
    const { method, path: route } = request
    if (route === "") {
      if (method !== "GET") return notFound()
      return json({
        repos: this.views(),
        appAuth: this._forge.hasAppAuth(),
        host: this._forge.status(),
        review: {
          available: this._reviewer.available,
          aliases: this._reviewer.aliases(),
          alias: this.reviewAlias(),
          busy: this._reviewer.busy
        }
      })
    }
    if (route === "sync" && method === "POST") {
      await this.syncAll()
      return json({ repos: this.views() })
    }
    if (route === "repos" && method === "POST") return this.addRepo(request)
    const repoMatch = /^repos\/([0-9a-f]{8})(?:\/(.*))?$/.exec(route)
    if (repoMatch) {
      const repo = this.store.get(repoMatch[1])
      if (!repo) return notFound("No such repository.")
      const rest = repoMatch[2] ?? ""
      if (rest === "" && method === "PUT") {
        const body = await request.body()
        if (typeof body.autoReview !== "boolean")
          throw new PluginError("Send { autoReview: true | false }.", 400)
        const updated = this.store.update(repo.id, { autoReview: body.autoReview })
        this._context.log.info({
          event: "plugin.repo-updated",
          key: request.principal,
          reason: `${repo.fullName} autoReview=${body.autoReview}`
        })
        if (body.autoReview) void this.autoReview()
        return json({ repo: this.view(updated) })
      }
      if (rest === "" && method === "DELETE") {
        this.store.remove(repo.id)
        this._state.delete(repo.id)
        this.reviews.forgetRepo(repo.id)
        this._context.log.info({
          event: "plugin.repo-removed",
          key: request.principal,
          reason: repo.fullName
        })
        return json({ id: repo.id, status: "removed" })
      }
      if (rest === "sync" && method === "POST") {
        await this.syncOne(repo)
        return json({ repo: this.view(repo) })
      }
      const pullMatch = /^pulls\/([1-9][0-9]{0,8})(\/review)?$/.exec(rest)
      if (pullMatch) {
        const number = Number(pullMatch[1])
        const wantsReview = pullMatch[2] !== undefined
        if (wantsReview ? method !== "POST" : method !== "GET") return notFound()
        let pull = this.pull(repo.id, number)
        if (!pull) {
          await this.syncOne(repo)
          pull = this.pull(repo.id, number)
        }
        if (!pull) return notFound(`${repo.fullName} has no open pull ${number}.`)
        if (wantsReview) {
          const alias = this.reviewAlias()
          if (!alias)
            throw new PluginError(
              this._reviewer.available
                ? "The gateway serves no chat model, so nothing can review."
                : "This gateway offers plugins no models, so reviews are unavailable.",
              503
            )
          const review = await this.runReview(repo, pull, alias, request.principal)
          return json({ review, reviewing: false })
        }
        const content = await this._forge.pullContent(
          repo,
          number,
          withTimeout(this._stopped.signal, REQUEST_TIMEOUT_MS)
        )
        const page: PullPage = {
          pull,
          ...content,
          reviewing: this._reviewer.isReviewing(repo.id, number)
        }
        const review = this.reviews.latest(repo.id, number)
        if (review) page.review = review
        return json(page)
      }
      return notFound()
    }
    if (route === "settings" && method === "PUT") {
      const body = await request.body()
      const settings = this.store.settings()
      let hostChanged = false
      if ("baseUrl" in body) {
        const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : ""
        if (baseUrl) settings.baseUrl = cleanBaseUrl(baseUrl)
        else delete settings.baseUrl
        hostChanged = true
      }
      if ("reviewAlias" in body) {
        const alias = typeof body.reviewAlias === "string" ? body.reviewAlias.trim() : ""
        if (alias && !this._reviewer.aliases().includes(alias))
          throw new PluginError(`No chat model is served as "${alias}".`, 400)
        if (alias) settings.reviewAlias = alias
        else delete settings.reviewAlias
      }
      this.store.setSettings(settings)
      if (hostChanged) {
        this._state.clear()
        void this.syncAll()
      }
      return json({
        host: this._forge.status(),
        review: {
          available: this._reviewer.available,
          aliases: this._reviewer.aliases(),
          alias: this.reviewAlias(),
          busy: this._reviewer.busy
        }
      })
    }
    const answered = await this._forge.handle?.(request)
    return answered ?? notFound()
  }

  /** After a sync: what is new and what started failing, for whoever listens. */
  private announce(repo: RepoRecord, before: PullSummary[], after: PullSummary[]): void {
    const events = this._context.events
    if (!events) return
    const hash = this._forge.noun === "Merge request" ? "!" : "#"
    for (const pull of after) {
      const old = before.find((entry) => entry.number === pull.number)
      if (!old) {
        events.emit({
          type: "pull.opened",
          source: this._pluginId,
          level: "info",
          title: `${repo.fullName}${hash}${pull.number} opened: ${pull.title}`,
          text: `By ${pull.author}, ${pull.headRef} into ${pull.baseRef}${pull.draft ? " (draft)" : ""}.`,
          url: pull.url,
          data: { repo: repo.fullName, number: pull.number }
        })
      } else if (pull.checks === "failure" && old.checks !== "failure") {
        const failing = pull.checkRuns.filter((check) => check.state === "failure").map((check) => check.name)
        events.emit({
          type: "pull.checks-failed",
          source: this._pluginId,
          level: "warn",
          title: `Checks failed on ${repo.fullName}${hash}${pull.number}: ${pull.title}`,
          text: `${failing.length ? `Failing: ${failing.join(", ")}. ` : ""}By ${pull.author}.`,
          url: pull.url,
          data: { repo: repo.fullName, number: pull.number, failing }
        })
      }
    }
  }

  private pull(repoId: string, number: number): PullSummary | undefined {
    return this._state.get(repoId)?.pulls.find((pull) => pull.number === number)
  }

  private async addRepo(request: PluginRequest): Promise<PluginResponse> {
    const body = await request.body()
    const fullName =
      typeof body.fullName === "string"
        ? body.fullName.trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")
        : ""
    if (!FULL_NAME_PATTERN.test(fullName))
      throw new PluginError(
        "Give the repository as owner/name, as it appears in its URL.",
        400
      )
    if (this.store.byName(fullName))
      throw new PluginError(`${fullName} is already watched.`, 409)
    const token = typeof body.token === "string" ? body.token.trim() : ""
    if (!token && !this._forge.hasAppAuth())
      throw new PluginError(
        "Give an access token for this repository: nothing else can read it.",
        400
      )
    const candidate: Omit<RepoRecord, "id"> = {
      fullName,
      auth: token ? "token" : "app",
      ...(token ? { token } : {}),
      addedAt: new Date(this._context.now()).toISOString(),
      addedBy: request.principal
    }
    const canonical = await this._forge.checkRepo(
      { id: "", ...candidate },
      withTimeout(this._stopped.signal, REQUEST_TIMEOUT_MS)
    )
    if (canonical !== fullName && this.store.byName(canonical))
      throw new PluginError(`${canonical} is already watched.`, 409)
    const repo = this.store.add({ ...candidate, fullName: canonical })
    this._context.log.info({
      event: "plugin.repo-added",
      key: request.principal,
      reason: repo.fullName
    })
    await this.syncOne(repo)
    return json({ repo: this.view(repo) }, 201)
  }
}

/** The verdict line of a review, lower-cased: "approve", "request changes", "comment", or nothing found. */
export const verdictOf = (text: string): string | undefined => {
  const section = /##\s*Verdict\s*\n+([^\n]+)/i.exec(text)?.[1] ?? ""
  const line = section.replace(/[*_`]/g, "").trim().toLowerCase()
  if (line.startsWith("approve")) return "approve"
  if (line.startsWith("request changes")) return "request changes"
  if (line.startsWith("comment")) return "comment"
  return undefined
}

/** The summary section of a review, one paragraph, for a notification. */
export const summaryOf = (text: string): string => {
  const section = /##\s*Summary\s*\n+([\s\S]*?)(?:\n##|$)/i.exec(text)?.[1] ?? ""
  return section.replace(/\s+/g, " ").trim().slice(0, 400)
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

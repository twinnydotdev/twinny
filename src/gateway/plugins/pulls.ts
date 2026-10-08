/**
 * What the GitHub and GitLab plugins share: a list of watched repositories
 * with their credentials, a sync loop that keeps each repository's open
 * pull requests in memory, and the admin routes the page uses.
 *
 *   GET    api/                        → repositories with their open pulls and sync state, and the saved tokens
 *   POST   api/repos { fullName, tokenId? | token? }   → no token named: the only saved one, else the host's app
 *   PUT    api/repos/<id> { autoReview?, autoPost?, autoTriage?, tokenId? }   → tokenId null reads through the app
 *   DELETE api/repos/<id>
 *   POST   api/tokens { token, label? }               → saved once, for any number of repositories
 *   PUT    api/tokens/<id> { token?, label? }         → a new value moves every repository on it along
 *   DELETE api/tokens/<id>                            → only once nothing reads with it
 *   GET    api/tokens/<id>/repos                      → what the token can read, for picking
 *   POST   api/repos/<id>/sync
 *   POST   api/sync
 *   GET    api/repos/<id>/pulls/<n>    → one pull with its description and files
 *   POST   api/repos/<id>/pulls/<n>/review        → review it with the gateway's model
 *   POST   api/repos/<id>/pulls/<n>/review/post   { as }
 *   POST   api/repos/<id>/pulls/<n>/review/ask    { question } → an answer kept on the review's thread
 *   GET    api/repos/<id>/issues/<n>              → one issue with its body and triage
 *   POST   api/repos/<id>/issues/<n>/triage[/post]
 *   PUT    api/settings { baseUrl?, me?, reviewAlias? }
 *   PUT    api/me { me }                          → who the caller is on the host, for them alone
 *
 * Shared with a developer, the plugin answers them on MEMBER_ROUTES: they
 * read, sync, review, ask and triage like an admin, and set who they are
 * on the host. What they post speaks as the repository's token, so they
 * post a review as a comment, once, and apply only the labels the model
 * suggested; repositories, tokens and settings stay the admin's.
 *
 * A host ("forge") supplies what differs: how to talk to the API and what
 * a pull looks like there; that contract and the shapes it fills are in
 * forge.ts. Tokens are kept in the plugin's repos.json,
 * owner-readable only, and never leave the process: the listing shows
 * which saved token a repository reads with, by id and label.
 */
import path from "node:path"

import { noAnswer, timeoutSignal } from "../../common/deadline"
import { messageOf } from "../../common/errors"

import type { MemberRoute } from "./access"
import {
  cleanBaseUrl,
  Forge,
  FULL_NAME_PATTERN,
  isTokenRefused,
  MAX_PULLS_PER_REPO,
  PullPage,
  PullSummary,
  RepoRecord,
  RepoStore,
  RepoView,
  tokenProbe,
  TokenView
} from "./forge"
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
  ASK_TIMEOUT_MS,
  REVIEW_TIMEOUT_MS,
  Reviewer,
  ReviewPostAs,
  ReviewRecord,
  ReviewStore
} from "./reviews"
import { IssueSummary, TRIAGE_TIMEOUT_MS, Triager, TriageRecord, TriageStore } from "./triage"

export const SYNC_INTERVAL_MS = 5 * 60_000
/** How often a pending background review is retried while developers are busy. */
export const REVIEW_TICK_MS = 60_000
const REQUEST_TIMEOUT_MS = 30_000

const REPO = "repos/[0-9a-f]{8}"
const NUMBER = "[1-9][0-9]{0,8}"

/** What a developer may do on a pull-request plugin shared with them; see the header. */
export const MEMBER_ROUTES: readonly MemberRoute[] = [
  { method: "GET", path: /^$/ },
  { method: "POST", path: /^sync$/ },
  { method: "PUT", path: /^me$/ },
  { method: "POST", path: new RegExp(`^${REPO}/sync$`) },
  { method: "GET", path: new RegExp(`^${REPO}/pulls/${NUMBER}$`) },
  { method: "POST", path: new RegExp(`^${REPO}/pulls/${NUMBER}/review(?:/post|/ask)?$`) },
  { method: "GET", path: new RegExp(`^${REPO}/issues/${NUMBER}$`) },
  { method: "POST", path: new RegExp(`^${REPO}/issues/${NUMBER}/triage(?:/post)?$`) }
]

/** How long a token's label may be. */
const MAX_LABEL = 80
/** Longer than any host's tokens; anything this long was pasted by mistake. */
const MAX_TOKEN_CHARS = 4096

/** A token as pasted: trimmed, one line. */
const cleanToken = (value: unknown): string => {
  const token = typeof value === "string" ? value.trim() : ""
  if (!token) throw new PluginError("Paste the token.", 400)
  if (token.length > MAX_TOKEN_CHARS || /\s/.test(token)) throw new PluginError("That does not look like a token: it has spaces or is far too long.", 400)
  return token
}

const cleanLabel = (value: unknown): string => {
  const label = typeof value === "string" ? value.trim() : ""
  if (label.length > MAX_LABEL) throw new PluginError("That label is too long.", 400)
  return label
}

/** How long a username on a host may be; longer is a mistake. */
const MAX_USERNAME = 100

/** A username as typed: trimmed, without the @; refused when too long. */
const cleanUsername = (value: unknown): string => {
  const name = typeof value === "string" ? value.trim().replace(/^@/, "") : ""
  if (name.length > MAX_USERNAME) throw new PluginError("That username is too long.", 400)
  return name
}

interface SyncState {
  syncing: boolean
  syncedAt?: string
  error?: string
  pulls: PullSummary[]
  issues?: IssueSummary[]
  issuesError?: string
  /** The last sync failed because the host refused the token. */
  refused?: boolean
}

/** A signal that fires on a timeout or when the plugin stops, whichever first. */
const withTimeout = (parent: AbortSignal, ms: number): AbortSignal =>
  timeoutSignal(ms, { parent, reason: () => noAnswer(ms) })

/** The plugin instance both hosts run; the forge is the only difference. */
export class PullsPlugin implements PluginInstance {
  public readonly store: RepoStore
  public readonly reviews: ReviewStore
  public readonly triage: TriageStore
  private readonly _triager: Triager
  private readonly _reviewer: Reviewer
  /** The username a token said it was, when no name is set by hand. */
  private _detectedMe?: string
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
    this.triage = TriageStore.open(path.join(_context.dataDir, "triage.json"))
    this._triager = new Triager(this.triage, _context.inference, _context.now)
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

  /**
   * Who the caller is on the host. Admins share one name: the setting,
   * else what a token said. A developer's name is only ever their own,
   * set with `PUT me`: the token belongs to whoever set the repository
   * up, not to them.
   */
  public me(caller?: { principal: string; member?: boolean }): { name?: string; detected?: string } {
    if (caller?.member) {
      const own = this.people()[caller.principal]
      return own ? { name: own } : {}
    }
    const set = this.store.settings().me
    const name = typeof set === "string" && set ? set : this._detectedMe
    return { ...(name ? { name } : {}), ...(this._detectedMe ? { detected: this._detectedMe } : {}) }
  }

  /** Each person's own name on the host, by key name. */
  private people(): Record<string, string> {
    const people = this.store.settings().people
    if (typeof people !== "object" || people === null || Array.isArray(people)) return {}
    return Object.fromEntries(Object.entries(people).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
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
    if (next) {
      this._autoReviewing = this.runReview(next.repo, next.pull, alias, "auto")
        .then(() => undefined)
        .finally(() => {
          this._autoReviewing = undefined
        })
      return this._autoReviewing
    }
    // No review due: an untriaged issue of an auto-triage repository, newest first.
    const issueDue = this.store
      .repos()
      .filter((repo) => repo.autoTriage)
      .flatMap((repo) => (this._state.get(repo.id)?.issues ?? []).map((issue) => ({ repo, issue })))
      .filter(({ repo, issue }) => !this.triage.latest(repo.id, issue.number) && !this._triager.isTriaging(repo.id, issue.number))
      .sort((a, b) => Date.parse(b.issue.updatedAt) - Date.parse(a.issue.updatedAt))[0]
    if (!issueDue) return Promise.resolve()
    this._autoReviewing = this.runTriage(issueDue.repo, issueDue.issue, alias, "auto")
      .then(() => undefined)
      .finally(() => {
        this._autoReviewing = undefined
      })
    return this._autoReviewing
  }

  private async runTriage(repo: RepoRecord, issue: IssueSummary, alias: string, requestedBy: string): Promise<TriageRecord> {
    const forge = this._forge
    if (!forge.listIssues || !forge.issueBody || !forge.listLabels) throw new PluginError("This host has no issue tracker the plugin can read.", 404)
    const signal = withTimeout(this._stopped.signal, TRIAGE_TIMEOUT_MS)
    const record = await this._triager.triage(
      {
        repoId: repo.id,
        issue,
        alias,
        requestedBy,
        others: this._state.get(repo.id)?.issues ?? [],
        body: () => forge.issueBody!(repo, issue.number, signal),
        labels: () => forge.listLabels!(repo, signal)
      },
      signal
    )
    this._context.log.info({
      event: record.status === "done" ? "plugin.triaged" : "plugin.triage-failed",
      key: requestedBy,
      reason: `${repo.fullName}#${issue.number}`,
      alias,
      ms: record.ms,
      ...(record.error ? { message: record.error } : {})
    })
    if (record.status === "done")
      this._context.events?.emit({
        type: "issue.triaged",
        source: this._pluginId,
        level: record.priority === "high" ? "warn" : "info",
        title: `Triaged ${repo.fullName}#${issue.number}: ${record.priority ?? "no"} priority${record.duplicateOf ? `, duplicate of #${record.duplicateOf}` : ""}`,
        text: `${issue.title} by ${issue.author}.${record.labels.length ? ` Suggested labels: ${record.labels.join(", ")}.` : ""}`,
        url: issue.url,
        data: { repo: repo.fullName, number: issue.number, priority: record.priority ?? null, labels: record.labels }
      })
    return record
  }

  private async runReview(
    repo: RepoRecord,
    pull: PullSummary,
    alias: string,
    requestedBy: string
  ): Promise<ReviewRecord> {
    const signal = withTimeout(this._stopped.signal, REVIEW_TIMEOUT_MS)
    let review = await this._reviewer.review(
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
    if (review.status === "done" && repo.autoPost) {
      // Straight to the host as a comment; a failure stays on the review, not on the review run.
      review = await this.postReview(repo, pull, review, "comment", "auto").catch(() => review)
    }
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

  /** A question about the pull's latest review, answered by the model that reviews. */
  private async askReview(repo: RepoRecord, pull: PullSummary, question: string, requestedBy: string): Promise<ReviewRecord> {
    const alias = this.reviewAlias()
    if (!alias)
      throw new PluginError(
        this._reviewer.available
          ? "The gateway serves no chat model, so nothing can answer."
          : "This gateway offers plugins no models, so reviews are unavailable.",
        503
      )
    const signal = withTimeout(this._stopped.signal, ASK_TIMEOUT_MS)
    const started = this._context.now()
    const review = await this._reviewer.ask(
      {
        repoId: repo.id,
        pull,
        alias,
        requestedBy,
        noun: this._forge.noun,
        detail: async () => ({ pull, ...(await this._forge.pullContent(repo, pull.number, signal)) })
      },
      question,
      signal
    )
    this._context.log.info({
      event: "plugin.review-asked",
      key: requestedBy,
      reason: `${repo.fullName}#${pull.number}`,
      alias,
      ms: this._context.now() - started
    })
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
      ...(repo.tokenId ? { tokenId: repo.tokenId } : {}),
      ...(state?.refused ? { tokenRefused: true } : {}),
      addedAt: repo.addedAt,
      addedBy: repo.addedBy,
      autoReview: repo.autoReview === true,
      autoPost: repo.autoPost === true,
      autoTriage: repo.autoTriage === true,
      issuesSupported: !!this._forge.listIssues,
      issues: state?.issues ?? [],
      ...(state?.issuesError ? { issuesError: state.issuesError } : {}),
      triage: Object.fromEntries(
        (state?.issues ?? []).flatMap((issue) => {
          const brief = this.triage.brief(repo.id, issue.number)
          return brief ? [[issue.number, brief]] : []
        })
      ),
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

  /** The saved tokens as the page sees them: never a value. */
  public tokenViews(): TokenView[] {
    const repos = this.store.repos()
    return this.store.tokens().map((token) => {
      const users = repos.filter((repo) => repo.tokenId === token.id)
      const kind = this._forge.tokenKind?.(token.token)
      return {
        id: token.id,
        ...(token.label ? { label: token.label } : {}),
        ...(token.login ? { login: token.login } : {}),
        ...(kind ? { kind } : {}),
        addedAt: token.addedAt,
        addedBy: token.addedBy,
        ...(token.replacedAt ? { replacedAt: token.replacedAt } : {}),
        repos: users.length,
        refused: users.filter((repo) => this._state.get(repo.id)?.refused).length
      }
    })
  }

  /**
   * Asks the host who a token is. A token the host refuses outright is
   * turned away; one that may read repositories but not say whose it is
   * (a scoped token) is taken at its word, and the first sync tells.
   */
  private async checkToken(token: string): Promise<string | undefined> {
    if (!this._forge.whoAmI) return undefined
    try {
      return await this._forge.whoAmI(tokenProbe(token), withTimeout(this._stopped.signal, REQUEST_TIMEOUT_MS))
    } catch (error) {
      // The host refusing a pasted token is the caller's mistake, not a bad gateway.
      if (isTokenRefused(error)) throw new PluginError(messageOf(error), 400)
      return undefined
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
      delete state.refused
      if (before) this.announce(repo, before, state.pulls)
      if (!this._detectedMe && repo.auth === "token" && this._forge.whoAmI) {
        // Best effort: a token that cannot say who it is changes nothing.
        this._detectedMe = await this._forge.whoAmI(repo, withTimeout(this._stopped.signal, REQUEST_TIMEOUT_MS)).catch(() => undefined)
      }
      if (this._forge.listIssues) {
        try {
          state.issues = (await this._forge.listIssues(repo, withTimeout(this._stopped.signal, REQUEST_TIMEOUT_MS)))
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
            .slice(0, MAX_PULLS_PER_REPO)
          delete state.issuesError
        } catch (error) {
          state.issuesError = messageOf(error)
        }
      }
    } catch (error) {
      state.error = messageOf(error)
      if (isTokenRefused(error)) state.refused = true
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
        // A developer reads with the admin's tokens but is never shown them.
        tokens: request.member ? [] : this.tokenViews(),
        canListRepos: !!this._forge.listRepos,
        appAuth: this._forge.hasAppAuth(),
        host: this._forge.status(),
        me: this.me(request),
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
    if (route === "me" && method === "PUT") {
      if (!request.member) throw new PluginError("Admins share one name on the host: set it with PUT settings { me }.", 400)
      const name = cleanUsername((await request.body()).me)
      const others = Object.fromEntries(Object.entries(this.people()).filter(([person]) => person !== request.principal))
      this.store.setSettings({ ...this.store.settings(), people: name ? { ...others, [request.principal]: name } : others })
      return json({ me: this.me(request) })
    }
    if (route === "repos" && method === "POST") return this.addRepo(request)
    if (route === "tokens" && method === "POST") return this.addToken(request)
    const tokenMatch = /^tokens\/([0-9a-f]{8})(\/repos)?$/.exec(route)
    if (tokenMatch) {
      const saved = this.store.token(tokenMatch[1])
      if (!saved) return notFound("No such token.")
      if (tokenMatch[2] && method === "GET") {
        if (!this._forge.listRepos) throw new PluginError("This host cannot list what a token reads.", 400)
        const names = await this._forge.listRepos(saved.token, withTimeout(this._stopped.signal, REQUEST_TIMEOUT_MS))
        const watched = new Set(this.store.repos().map((repo) => repo.fullName.toLowerCase()))
        return json({ repositories: names.map((fullName) => ({ fullName, watched: watched.has(fullName.toLowerCase()) })) })
      }
      if (tokenMatch[2]) return notFound()
      if (method === "PUT") return this.updateToken(request, saved.id)
      if (method === "DELETE") {
        this.store.removeToken(saved.id)
        this._context.log.info({ event: "plugin.token-removed", key: request.principal, reason: saved.label ?? saved.id })
        return json({ tokens: this.tokenViews() })
      }
      return notFound()
    }
    const repoMatch = /^repos\/([0-9a-f]{8})(?:\/(.*))?$/.exec(route)
    if (repoMatch) {
      const repo = this.store.get(repoMatch[1])
      if (!repo) return notFound("No such repository.")
      const rest = repoMatch[2] ?? ""
      if (rest === "" && method === "PUT") {
        const body = await request.body()
        if ("tokenId" in body) return this.moveRepo(request, repo, body.tokenId)
        if (typeof body.autoReview !== "boolean" && typeof body.autoPost !== "boolean" && typeof body.autoTriage !== "boolean")
          throw new PluginError("Send { autoReview }, { autoPost } and/or { autoTriage } as true or false, or { tokenId }.", 400)
        const updated = this.store.update(repo.id, {
          ...(typeof body.autoReview === "boolean" ? { autoReview: body.autoReview } : {}),
          ...(typeof body.autoPost === "boolean" ? { autoPost: body.autoPost } : {}),
          ...(typeof body.autoTriage === "boolean" ? { autoTriage: body.autoTriage } : {})
        })
        this._context.log.info({
          event: "plugin.repo-updated",
          key: request.principal,
          reason: `${repo.fullName} autoReview=${updated.autoReview === true} autoPost=${updated.autoPost === true}`
        })
        if (body.autoReview === true || body.autoTriage === true) void this.autoReview()
        return json({ repo: this.view(updated) })
      }
      const issueMatch = /^issues\/([1-9][0-9]{0,8})(\/triage(?:\/post)?)?$/.exec(rest)
      if (issueMatch) {
        const number = Number(issueMatch[1])
        const issue = (this._state.get(repo.id)?.issues ?? []).find((entry) => entry.number === number)
        if (!issue) return notFound(`${repo.fullName} has no open issue ${number}.`)
        if (issueMatch[2] === undefined && method === "GET") {
          const body = this._forge.issueBody ? await this._forge.issueBody(repo, number, withTimeout(this._stopped.signal, REQUEST_TIMEOUT_MS)) : ""
          return json({ issue, body, triage: this.triage.latest(repo.id, number) ?? null, triaging: this._triager.isTriaging(repo.id, number) })
        }
        if (issueMatch[2] === "/triage" && method === "POST") {
          const alias = this.reviewAlias()
          if (!alias) throw new PluginError("The gateway serves no chat model, so nothing can triage.", 503)
          return json({ triage: await this.runTriage(repo, issue, alias, request.principal) })
        }
        if (issueMatch[2] === "/triage/post" && method === "POST") {
          const body = await request.body()
          const record = this.triage.latest(repo.id, number)
          if (!record || record.status !== "done") throw new PluginError("There is no finished triage to post.", 409)
          const signal = withTimeout(this._stopped.signal, REQUEST_TIMEOUT_MS)
          let updated: TriageRecord = { ...record }
          if (body.reply !== false && record.reply && this._forge.commentIssue) {
            const text = typeof body.replyText === "string" && body.replyText.trim() ? body.replyText.trim() : record.reply
            await this._forge.commentIssue(repo, number, `${text}\n\n---\n_Triaged by twinny-server with \`${record.alias}\`._`, signal)
            updated = { ...updated, reply: text, repliedAt: new Date(this._context.now()).toISOString() }
          }
          if (body.labels !== false && record.labels.length && this._forge.labelIssue) {
            const chosen = Array.isArray(body.labelNames) ? body.labelNames.filter((l): l is string => typeof l === "string") : record.labels
            // A developer applies the model's suggestions, not labels of their own that may drive the host's automation.
            const labels = request.member ? chosen.filter((label) => record.labels.includes(label)) : chosen
            if (labels.length) await this._forge.labelIssue(repo, number, labels, signal)
            updated = { ...updated, labels, labeledAt: new Date(this._context.now()).toISOString() }
          }
          if (updated.repliedAt !== record.repliedAt || updated.labeledAt !== record.labeledAt) updated = { ...updated, postedBy: request.principal }
          this.triage.put(updated)
          this._context.log.info({ event: "plugin.triage-posted", key: request.principal, reason: `${repo.fullName}#${number}` })
          return json({ triage: updated })
        }
        return notFound()
      }
      if (rest === "" && method === "DELETE") {
        this.store.remove(repo.id)
        this._state.delete(repo.id)
        this.reviews.forgetRepo(repo.id)
        this.triage.forgetRepo(repo.id)
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
      const pullMatch = /^pulls\/([1-9][0-9]{0,8})(\/review(?:\/post|\/ask)?|\/approve)?$/.exec(rest)
      if (pullMatch) {
        const number = Number(pullMatch[1])
        const wantsReview = pullMatch[2] === "/review"
        const wantsPost = pullMatch[2] === "/review/post"
        const wantsAsk = pullMatch[2] === "/review/ask"
        const wantsApprove = pullMatch[2] === "/approve"
        if (wantsReview || wantsPost || wantsAsk || wantsApprove ? method !== "POST" : method !== "GET") return notFound()
        let pull = this.pull(repo.id, number)
        if (!pull) {
          await this.syncOne(repo)
          pull = this.pull(repo.id, number)
        }
        if (!pull) return notFound(`${repo.fullName} has no open pull ${number}.`)
        if (wantsPost) {
          const body = await request.body()
          const as: ReviewPostAs = body.as === "request-changes" || body.as === "approve" ? body.as : "comment"
          const review = this.reviews.latest(repo.id, number)
          if (!review || review.status !== "done") throw new PluginError("There is no finished review to post.", 409)
          // The token's account may count towards branch protection: a developer posts comments, once.
          if (request.member && as !== "comment") throw new PluginError("Only an admin can post a review as an approval or a change request.", 403)
          if (request.member && review.postedAt) throw new PluginError("This review is already on the host.", 409)
          const posted = await this.postReview(repo, pull, review, as, request.principal)
          return json({ review: posted })
        }
        if (wantsApprove) {
          await this.approvePull(repo, pull, request.principal)
          await this.syncOne(repo)
          return json({ pull: this.pull(repo.id, number) ?? pull })
        }
        if (wantsAsk) {
          const body = await request.body()
          const question = typeof body.question === "string" ? body.question : ""
          const review = await this.askReview(repo, pull, question, request.principal)
          return json({ review })
        }
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
      if ("me" in body) {
        const me = cleanUsername(body.me)
        if (me) settings.me = me
        else delete settings.me
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
        me: this.me(request),
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

  /** Sends a finished review to the host and remembers where it went. */
  private async postReview(repo: RepoRecord, pull: PullSummary, review: ReviewRecord, as: ReviewPostAs, by: string): Promise<ReviewRecord> {
    const hash = this._forge.noun === "Merge request" ? "!" : "#"
    const body = `${review.text.trim()}\n\n---\n_Reviewed by twinny-server with \`${review.alias}\`${review.headSha ? ` at ${review.headSha.slice(0, 7)}` : ""}._`
    try {
      const posted = await this._forge.postReview(repo, pull, body, as, withTimeout(this._stopped.signal, REQUEST_TIMEOUT_MS))
      const updated: ReviewRecord = { ...review, postedAt: new Date(this._context.now()).toISOString(), postedAs: as, postedBy: by, ...(posted.url ? { postedUrl: posted.url } : {}) }
      this.reviews.put(updated)
      this._context.log.info({ event: "plugin.review-posted", key: by, reason: `${repo.fullName}${hash}${pull.number}`, message: as })
      this._context.events?.emit({
        type: "review.posted",
        source: this._pluginId,
        level: "info",
        title: `Review of ${repo.fullName}${hash}${pull.number} posted as ${as.replace("-", " ")}`,
        text: `${pull.title} by ${pull.author}; reviewed by ${review.alias}.`,
        url: posted.url ?? pull.url,
        data: { repo: repo.fullName, number: pull.number, as }
      })
      return updated
    } catch (error) {
      const message = messageOf(error)
      this._context.log.warn({ event: "plugin.review-post-failed", key: by, reason: `${repo.fullName}${hash}${pull.number}`, message })
      throw error instanceof PluginError ? error : new PluginError(`Posting to the host failed: ${message}`, 502)
    }
  }

  /** Approves the pull on the host, with no review text. */
  private async approvePull(repo: RepoRecord, pull: PullSummary, by: string): Promise<void> {
    const label = `${repo.fullName}${this._forge.noun === "Merge request" ? "!" : "#"}${pull.number}`
    try {
      await this._forge.approvePull(repo, pull, withTimeout(this._stopped.signal, REQUEST_TIMEOUT_MS))
    } catch (error) {
      const message = messageOf(error)
      this._context.log.warn({ event: "plugin.approve-failed", key: by, reason: label, message })
      throw error instanceof PluginError ? error : new PluginError(`Approving on the host failed: ${message}`, 502)
    }
    this._context.log.info({ event: "plugin.approved", key: by, reason: label })
    this._context.events?.emit({
      type: "pull.approved",
      source: this._pluginId,
      level: "info",
      title: `${label} approved by ${by}`,
      text: `${pull.title} by ${pull.author}.`,
      url: pull.url,
      data: { repo: repo.fullName, number: pull.number }
    })
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
    const pasted = typeof body.token === "string" && body.token.trim() ? cleanToken(body.token) : ""
    let tokenId = typeof body.tokenId === "string" && body.tokenId ? body.tokenId : undefined
    if (tokenId && !this.store.token(tokenId)) throw new PluginError("No such token.", 404)
    // Nothing named: the one saved token is the obvious choice; with several, which is the caller's to say.
    const saved = this.store.tokens()
    if (!pasted && !tokenId && !this._forge.hasAppAuth()) {
      if (saved.length === 1) tokenId = saved[0].id
      else
        throw new PluginError(
          saved.length ? "Choose which saved token reads this repository, or paste a new one." : "Give an access token for this repository: nothing else can read it.",
          400
        )
    }
    const value = pasted || (tokenId ? this.store.token(tokenId)?.token : undefined)
    const candidate: RepoRecord = {
      id: "",
      fullName,
      auth: value ? "token" : "app",
      ...(value ? { token: value } : {}),
      addedAt: new Date(this._context.now()).toISOString(),
      addedBy: request.principal
    }
    const canonical = await this._forge.checkRepo(
      candidate,
      withTimeout(this._stopped.signal, REQUEST_TIMEOUT_MS)
    )
    if (canonical !== fullName && this.store.byName(canonical))
      throw new PluginError(`${canonical} is already watched.`, 409)
    if (pasted) {
      // Saved only once it has read something; the same value pasted again is the token already saved.
      const { token, existed } = this.store.addToken({ token: pasted, addedAt: candidate.addedAt, addedBy: request.principal })
      tokenId = token.id
      if (!existed) this._context.log.info({ event: "plugin.token-added", key: request.principal, reason: token.id })
    }
    const repo = this.store.add({
      fullName: canonical,
      auth: candidate.auth,
      ...(tokenId && value ? { tokenId } : {}),
      addedAt: candidate.addedAt,
      addedBy: candidate.addedBy
    })
    this._context.log.info({
      event: "plugin.repo-added",
      key: request.principal,
      reason: repo.fullName
    })
    await this.syncOne(repo)
    return json({ repo: this.view(repo) }, 201)
  }

  /** Switches the token a repository reads with, once the new one reads it; null reads through the app. */
  private async moveRepo(request: PluginRequest, repo: RepoRecord, tokenId: unknown): Promise<PluginResponse> {
    if (tokenId !== null && typeof tokenId !== "string") throw new PluginError("Send { tokenId } as a saved token's id, or null for the app.", 400)
    if (tokenId === null && !this._forge.hasAppAuth()) throw new PluginError("There is no app to read through: choose a token.", 400)
    const token = tokenId === null ? undefined : this.store.token(tokenId)
    if (tokenId !== null && !token) throw new PluginError("No such token.", 404)
    await this._forge.checkRepo(
      { ...repo, auth: token ? "token" : "app", ...(token ? { token: token.token } : { token: undefined }) },
      withTimeout(this._stopped.signal, REQUEST_TIMEOUT_MS)
    )
    const updated = this.store.update(repo.id, { tokenId })
    this._context.log.info({ event: "plugin.repo-token-changed", key: request.principal, reason: `${repo.fullName} → ${token ? (token.label ?? token.id) : "app"}` })
    this._state.delete(repo.id)
    await this.syncOne(updated)
    return json({ repo: this.view(updated) })
  }

  private async addToken(request: PluginRequest): Promise<PluginResponse> {
    const body = await request.body()
    const value = cleanToken(body.token)
    const label = cleanLabel(body.label)
    const login = await this.checkToken(value)
    const { token, existed } = this.store.addToken({
      token: value,
      ...(label ? { label } : {}),
      ...(login ? { login } : {}),
      addedAt: new Date(this._context.now()).toISOString(),
      addedBy: request.principal
    })
    if (!existed) this._context.log.info({ event: "plugin.token-added", key: request.principal, reason: label || token.id })
    return json({ token: this.tokenViews().find((view) => view.id === token.id), existed }, existed ? 200 : 201)
  }

  /**
   * A label, or a new value for every repository on the token: the value
   * is checked with the host first, then each repository syncs with it.
   */
  private async updateToken(request: PluginRequest, id: string): Promise<PluginResponse> {
    const body = await request.body()
    if (!("token" in body) && !("label" in body)) throw new PluginError("Send { token } and/or { label }.", 400)
    const value = "token" in body ? cleanToken(body.token) : undefined
    const label = "label" in body ? cleanLabel(body.label) : undefined
    const login = value ? await this.checkToken(value) : undefined
    if (value) {
      // The value must read what it is about to be used for: one repository on it proves that before all move.
      const [first] = this.store.usersOf(id)
      if (first)
        await this._forge.checkRepo({ ...first, token: value }, withTimeout(this._stopped.signal, REQUEST_TIMEOUT_MS)).catch((error: unknown) => {
          throw new PluginError(`Not replaced: ${messageOf(error)}`, isTokenRefused(error) ? 400 : 409)
        })
    }
    const token = this.store.updateToken(id, {
      ...(value ? { token: value, replacedAt: new Date(this._context.now()).toISOString() } : {}),
      ...(login ? { login } : {}),
      ...(label !== undefined ? { label } : {})
    })
    if (value) {
      const users = this.store.usersOf(id)
      this._context.log.info({ event: "plugin.token-replaced", key: request.principal, reason: `${token.label ?? token.id} for ${users.length} repositories` })
      for (const repo of users) {
        const state = this._state.get(repo.id)
        if (state) delete state.refused
      }
      // Whoever the old token said it was may not be who the new one is.
      this._detectedMe = undefined
      void (async () => {
        for (const repo of users) {
          if (this._stopped.signal.aborted) return
          await this.syncOne(repo)
        }
      })()
    } else this._context.log.info({ event: "plugin.token-labelled", key: request.principal, reason: `${token.id}: ${token.label ?? ""}` })
    return json({ token: this.tokenViews().find((view) => view.id === id), repos: this.views() })
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

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
 *   POST   api/repos/<id>/pulls/<n>/review        → review it with the gateway's model
 *   POST   api/repos/<id>/pulls/<n>/review/post   { as }
 *   POST   api/repos/<id>/pulls/<n>/review/ask    { question } → an answer kept on the review's thread
 *
 * A host ("forge") supplies what differs: how to talk to the API and what
 * a pull looks like there; that contract and the shapes it fills are in
 * forge.ts. Tokens are kept in the plugin's repos.json,
 * owner-readable only, and never leave the process: the listing shows
 * only whether a repository has one.
 */
import path from "node:path"

import { noAnswer, timeoutSignal } from "../../common/deadline"
import { messageOf } from "../../common/errors"

import {
  cleanBaseUrl,
  Forge,
  FULL_NAME_PATTERN,
  MAX_PULLS_PER_REPO,
  PullPage,
  PullSummary,
  RepoRecord,
  RepoStore,
  RepoView
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

interface SyncState {
  syncing: boolean
  syncedAt?: string
  error?: string
  pulls: PullSummary[]
  issues?: IssueSummary[]
  issuesError?: string
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

  /** The alias reviews use: the setting, else the first chat alias the gateway serves. */
  /** Who the operator is on the host: the setting, else what a token said. */
  public me(): { name?: string; detected?: string } {
    const set = this.store.settings().me
    return { ...(typeof set === "string" && set ? { name: set } : this._detectedMe ? { name: this._detectedMe } : {}), ...(this._detectedMe ? { detected: this._detectedMe } : {}) }
  }

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
        me: this.me(),
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
        if (typeof body.autoReview !== "boolean" && typeof body.autoPost !== "boolean" && typeof body.autoTriage !== "boolean")
          throw new PluginError("Send { autoReview }, { autoPost } and/or { autoTriage } as true or false.", 400)
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
            const labels = Array.isArray(body.labelNames) ? body.labelNames.filter((l): l is string => typeof l === "string") : record.labels
            if (labels.length) await this._forge.labelIssue(repo, number, labels, signal)
            updated = { ...updated, labels, labeledAt: new Date(this._context.now()).toISOString() }
          }
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
      const pullMatch = /^pulls\/([1-9][0-9]{0,8})(\/review(?:\/post|\/ask)?)?$/.exec(rest)
      if (pullMatch) {
        const number = Number(pullMatch[1])
        const wantsReview = pullMatch[2] === "/review"
        const wantsPost = pullMatch[2] === "/review/post"
        const wantsAsk = pullMatch[2] === "/review/ask"
        if (wantsReview || wantsPost || wantsAsk ? method !== "POST" : method !== "GET") return notFound()
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
          const posted = await this.postReview(repo, pull, review, as, request.principal)
          return json({ review: posted })
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
        const me = typeof body.me === "string" ? body.me.trim().replace(/^@/, "") : ""
        if (me.length > 100) throw new PluginError("That username is too long.", 400)
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
        me: this.me(),
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

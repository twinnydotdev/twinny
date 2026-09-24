/**
 * The GitHub plugin: open pull requests of watched repositories, read
 * with a repository token or, once one is set up, a GitHub App.
 *
 * A GitHub App is the tidier way for a team: install it on the
 * repositories once, paste its App ID and private key here, and every
 * repository it can see may be watched with no token of its own. The
 * gateway signs a short JWT with the key, swaps it for an installation
 * token (an hour, cached) and reads with that. Tokens work too, per
 * repository, for a quick start or a personal account.
 *
 * Host-specific routes under api/:
 *   PUT    app { appId, privateKey }  → checks the key against GitHub, keeps it
 *   DELETE app
 *   GET    app/repositories           → everything the App is installed on
 *
 * Reading uses GraphQL for the list (one call per repository, checks and
 * review decision included) and REST for a pull's files.
 */
import { createSign } from "node:crypto"

import { noAnswer, timeoutSignal } from "../../common/deadline"
import { messageOf } from "../../common/errors"

import {
  GatewayPlugin,
  json,
  PluginContext,
  PluginError,
  PluginRequest,
  PluginResponse
} from "./host"
import {
  arr,
  baseUrlOf,
  CheckState,
  cutPatch,
  Forge,
  IssueSummary,
  MAX_FILES,
  MAX_PULLS_PER_REPO,
  MergeState,
  num,
  PullApprovals,
  PullCheck,
  PullContent,
  PullFile,
  PullsPlugin,
  PullSummary,
  readJson,
  rec,
  RepoRecord,
  RepoStore,
  ReviewPostAs,
  ReviewState,
  rollup,
  str
} from "./pulls"

export const GITHUB_URL = "https://github.com"
const USER_AGENT = "twinny-server"
/** GitHub caps a JWT at ten minutes; a little slack covers clock skew. */
const JWT_TTL_S = 9 * 60
/** Installation tokens live an hour; renew this long before the end. */
const TOKEN_MARGIN_MS = 5 * 60_000

/**
 * The pulls query, with or without the reviewer detail. The detail asks
 * only for fields a plain `repo` token can read (no team names: those
 * need an org scope); should a host still refuse it, the plain query
 * is used for that repository from then on.
 */
const pullsQuery = (detail: boolean): string => `query($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequests(states: OPEN, first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title url isDraft createdAt updatedAt additions deletions changedFiles mergeable reviewDecision
        author { login }
        headRefName baseRefName headRefOid
        ${
          detail
            ? `latestOpinionatedReviews(first: 50) { nodes { state author { login } } }
        reviewRequests(first: 30) { nodes { requestedReviewer { __typename ... on User { login } } } }
        baseRef { branchProtectionRule { requiredApprovingReviewCount } }`
            : ""
        }
        labels(first: 20) { nodes { name } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion detailsUrl }
          ... on StatusContext { context state targetUrl }
        } } } } } }
      }
    }
  }
}`

interface AppSettings {
  appId: string
  privateKey: string
  slug?: string
  name?: string
}

/** What the page sees of the App: never the key. */
export interface GitHubAppStatus {
  appId: string
  slug?: string
  name?: string
  /** Where to install it on more repositories. */
  installUrl?: string
}

export interface GitHubStatus {
  baseUrl: string
  app: GitHubAppStatus | null
}

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url")

/** The JWT GitHub wants from an App: RS256, issued by the App ID. */
export const appJwt = (
  appId: string,
  privateKey: string,
  nowMs: number
): string => {
  const now = Math.floor(nowMs / 1000)
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + JWT_TTL_S, iss: appId })
  )
  const signer = createSign("RSA-SHA256")
  signer.update(`${header}.${payload}`)
  let signature: Buffer
  try {
    signature = signer.sign(privateKey)
  } catch (error) {
    throw new PluginError(
      `The private key cannot sign: ${messageOf(error)}`,
      400
    )
  }
  return `${header}.${payload}.${base64url(signature)}`
}

const checkStateOfRun = (status: string, conclusion: string): CheckState => {
  if (status !== "COMPLETED") return "pending"
  return conclusion === "SUCCESS" ||
    conclusion === "NEUTRAL" ||
    conclusion === "SKIPPED"
    ? "success"
    : "failure"
}

const checkStateOfContext = (state: string): CheckState =>
  state === "SUCCESS"
    ? "success"
    : state === "PENDING" || state === "EXPECTED"
      ? "pending"
      : "failure"

const mergeState = (value: string): MergeState =>
  value === "MERGEABLE"
    ? "mergeable"
    : value === "CONFLICTING"
      ? "conflicting"
      : "unknown"

const reviewState = (value: string): ReviewState =>
  value === "APPROVED"
    ? "approved"
    : value === "CHANGES_REQUESTED"
      ? "changes-requested"
      : value === "REVIEW_REQUIRED"
        ? "review-required"
        : "none"

const fileStatus = (value: string): PullFile["status"] =>
  value === "added"
    ? "added"
    : value === "removed"
      ? "removed"
      : value === "renamed" || value === "copied"
        ? "renamed"
        : "modified"

/** One pull from the GraphQL answer. Missing fields degrade to "unknown", never throw. */
const toPull = (repo: string, node: Record<string, unknown>): PullSummary => {
  const commit = rec(rec(arr(rec(node.commits).nodes)[0]).commit)
  const rollupNode = rec(commit.statusCheckRollup)
  const checkRuns: PullCheck[] = arr(rec(rollupNode.contexts).nodes).map(
    (entry) => {
      const context = rec(entry)
      return context.__typename === "CheckRun"
        ? {
            name: str(context.name, "check"),
            state: checkStateOfRun(str(context.status), str(context.conclusion)),
            ...(context.detailsUrl ? { url: str(context.detailsUrl) } : {})
          }
        : {
            name: str(context.context, "status"),
            state: checkStateOfContext(str(context.state)),
            ...(context.targetUrl ? { url: str(context.targetUrl) } : {})
          }
    }
  )
  return {
    repo,
    number: num(node.number) ?? 0,
    title: str(node.title),
    author: str(rec(node.author).login, "ghost"),
    url: str(node.url),
    draft: node.isDraft === true,
    createdAt: str(node.createdAt),
    updatedAt: str(node.updatedAt),
    headRef: str(node.headRefName),
    baseRef: str(node.baseRefName),
    headSha: str(node.headRefOid),
    additions: num(node.additions),
    deletions: num(node.deletions),
    changedFiles: num(node.changedFiles),
    checks: rollup(checkRuns),
    checkRuns,
    mergeable: mergeState(str(node.mergeable)),
    review: reviewState(str(node.reviewDecision)),
    ...(node.latestOpinionatedReviews !== undefined ? { approvals: approvalsOf(node) } : {}),
    labels: arr(rec(node.labels).nodes).map((label) => str(rec(label).name))
  }
}

/** Each reviewer's latest approve/request-changes, whoever is still asked, and the branch's rule. */
const approvalsOf = (node: Record<string, unknown>): PullApprovals => {
  const approved: string[] = []
  const changes: string[] = []
  for (const entry of arr(rec(node.latestOpinionatedReviews).nodes)) {
    const review = rec(entry)
    const login = str(rec(review.author).login)
    if (!login) continue
    if (review.state === "APPROVED") approved.push(login)
    else if (review.state === "CHANGES_REQUESTED") changes.push(login)
  }
  const pending = arr(rec(node.reviewRequests).nodes)
    .map((entry) => {
      const who = rec(rec(entry).requestedReviewer)
      return who.__typename === "Team" ? "a team" : str(who.login)
    })
    .filter(Boolean)
  const required = num(rec(rec(node.baseRef).branchProtectionRule).requiredApprovingReviewCount)
  return { approved, changes, pending, ...(required !== undefined && required > 0 ? { required } : {}) }
}

interface CachedToken {
  token: string
  expiresAt: number
}

export class GitHubForge implements Forge {
  private readonly _installations = new Map<string, number>()
  private readonly _tokens = new Map<number, CachedToken>()
  /** Repositories whose host refused the reviewer detail; listed plainly from then on. */
  private readonly _plainListing = new Set<string>()

  public readonly noun = "Pull request"

  constructor(
    private readonly _store: RepoStore,
    private readonly _context: PluginContext
  ) {}

  private get baseUrl(): string {
    return baseUrlOf(this._store, GITHUB_URL)
  }

  /** api.github.com for the public site; `<host>/api/v3` on GitHub Enterprise. */
  private get restUrl(): string {
    return this.baseUrl === GITHUB_URL
      ? "https://api.github.com"
      : `${this.baseUrl}/api/v3`
  }

  private get graphqlUrl(): string {
    return this.baseUrl === GITHUB_URL
      ? "https://api.github.com/graphql"
      : `${this.baseUrl}/api/graphql`
  }

  public repoUrl(fullName: string): string {
    return `${this.baseUrl}/${fullName}`
  }

  private app(): AppSettings | undefined {
    const app = rec(this._store.settings().app)
    return typeof app.appId === "string" && typeof app.privateKey === "string"
      ? {
          appId: app.appId,
          privateKey: app.privateKey,
          ...(typeof app.slug === "string" ? { slug: app.slug } : {}),
          ...(typeof app.name === "string" ? { name: app.name } : {})
        }
      : undefined
  }

  public hasAppAuth(): boolean {
    return this.app() !== undefined
  }

  public status(): GitHubStatus {
    const app = this.app()
    return {
      baseUrl: this.baseUrl,
      app: app
        ? {
            appId: app.appId,
            ...(app.slug ? { slug: app.slug } : {}),
            ...(app.name ? { name: app.name } : {}),
            ...(app.slug
              ? { installUrl: `${this.baseUrl}/apps/${app.slug}/installations/new` }
              : {})
          }
        : null
    }
  }

  private async rest(
    route: string,
    token: string,
    signal: AbortSignal,
    what: string,
    init: { method?: string } = {}
  ): Promise<Record<string, unknown>> {
    const response = await this._context.fetch(`${this.restUrl}${route}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT
      },
      signal
    })
    return readJson(response, what)
  }

  private async graphql(
    query: string,
    variables: Record<string, unknown>,
    token: string,
    signal: AbortSignal,
    what: string
  ): Promise<Record<string, unknown>> {
    const response = await this._context.fetch(this.graphqlUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT
      },
      body: JSON.stringify({ query, variables }),
      signal
    })
    const answer = await readJson(response, what)
    const errors = arr(answer.errors)
    const data = rec(answer.data)
    // A field the token may not read (branch protection needs admin) comes
    // back null beside an error; only a missing repository is a failure.
    const empty = Object.values(data).every((value) => value === null || value === undefined)
    if (errors.length > 0 && empty)
      throw new PluginError(
        `${what}: ${errors.map((error) => str(rec(error).message, "error")).join("; ")}.`,
        502
      )
    return data
  }

  /** The token to read a repository with: its own, or the App's for its installation. */
  private async tokenFor(repo: RepoRecord, signal: AbortSignal): Promise<string> {
    if (repo.auth === "token") {
      if (!repo.token)
        throw new PluginError(`${repo.fullName} has no token.`, 409)
      return repo.token
    }
    const app = this.app()
    if (!app)
      throw new PluginError(
        `${repo.fullName} reads through the GitHub App, which is no longer set up.`,
        409
      )
    let installation = this._installations.get(repo.fullName.toLowerCase())
    if (installation === undefined) {
      const answer = await this.rest(
        `/repos/${repo.fullName}/installation`,
        appJwt(app.appId, app.privateKey, this._context.now()),
        signal,
        `Finding the App installation for ${repo.fullName}`
      )
      installation = num(answer.id)
      if (installation === undefined)
        throw new PluginError(
          `The GitHub App is not installed on ${repo.fullName}.`,
          409
        )
      this._installations.set(repo.fullName.toLowerCase(), installation)
    }
    return this.installationToken(app, installation, signal)
  }

  private async installationToken(
    app: AppSettings,
    installation: number,
    signal: AbortSignal
  ): Promise<string> {
    const cached = this._tokens.get(installation)
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > this._context.now())
      return cached.token
    const answer = await this.rest(
      `/app/installations/${installation}/access_tokens`,
      appJwt(app.appId, app.privateKey, this._context.now()),
      signal,
      "Getting an installation token",
      { method: "POST" }
    )
    const token = str(answer.token)
    if (!token)
      throw new PluginError("GitHub returned no installation token.", 502)
    const expiresAt = Date.parse(str(answer.expires_at))
    this._tokens.set(installation, {
      token,
      expiresAt: Number.isFinite(expiresAt)
        ? expiresAt
        : this._context.now() + 60 * 60_000
    })
    return token
  }

  public async whoAmI(repo: RepoRecord, signal: AbortSignal): Promise<string | undefined> {
    if (repo.auth !== "token" || !repo.token) return undefined
    return str(rec(await this.rest("/user", repo.token, signal, "Asking GitHub who the token is")).login) || undefined
  }

  public async checkRepo(repo: RepoRecord, signal: AbortSignal): Promise<string> {
    const token = await this.tokenFor(repo, signal)
    const answer = await this.rest(
      `/repos/${repo.fullName}`,
      token,
      signal,
      `Reading ${repo.fullName}`
    )
    return str(answer.full_name, repo.fullName)
  }

  public async listPulls(
    repo: RepoRecord,
    signal: AbortSignal
  ): Promise<PullSummary[]> {
    const [owner, ...rest] = repo.fullName.split("/")
    const token = await this.tokenFor(repo, signal)
    const what = `Listing pulls of ${repo.fullName}`
    const variables = { owner, name: rest.join("/"), first: MAX_PULLS_PER_REPO }
    let data: Record<string, unknown>
    if (this._plainListing.has(repo.id)) {
      data = await this.graphql(pullsQuery(false), variables, token, signal, what)
    } else {
      try {
        data = await this.graphql(pullsQuery(true), variables, token, signal, what)
      } catch (error) {
        if (signal.aborted || !(error instanceof PluginError) || error.status !== 502) throw error
        // The host would not answer the richer query (scopes, an older
        // Enterprise); take what it gives and stop asking for more.
        this._context.log.warn({ event: "plugin.github-plain-listing", reason: repo.fullName, message: error.message })
        this._plainListing.add(repo.id)
        data = await this.graphql(pullsQuery(false), variables, token, signal, what)
      }
    }
    const repository = rec(data.repository)
    if (!repository.nameWithOwner)
      throw new PluginError(
        `Listing pulls of ${repo.fullName}: not found, or the token cannot see it.`,
        502
      )
    return arr(rec(repository.pullRequests).nodes).map((node) =>
      toPull(repo.fullName, rec(node))
    )
  }

  public async pullContent(
    repo: RepoRecord,
    number: number,
    signal: AbortSignal
  ): Promise<PullContent> {
    const token = await this.tokenFor(repo, signal)
    const what = `Reading ${repo.fullName}#${number}`
    const pull = await this.rest(
      `/repos/${repo.fullName}/pulls/${number}`,
      token,
      signal,
      what
    )
    const files: PullFile[] = []
    let moreFiles = 0
    for (let page = 1; page <= Math.ceil(MAX_FILES / 100); page++) {
      const answer = await this._context.fetch(
        `${this.restUrl}/repos/${repo.fullName}/pulls/${number}/files?per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": USER_AGENT
          },
          signal
        }
      )
      const entries = arr(await readJson(answer, `${what} (files)`))
      for (const entry of entries) {
        const file = rec(entry)
        if (files.length >= MAX_FILES) {
          moreFiles++
          continue
        }
        files.push({
          path: str(file.filename),
          ...(file.previous_filename
            ? { previousPath: str(file.previous_filename) }
            : {}),
          status: fileStatus(str(file.status)),
          additions: num(file.additions) ?? 0,
          deletions: num(file.deletions) ?? 0,
          ...cutPatch(typeof file.patch === "string" ? file.patch : undefined)
        })
      }
      if (entries.length < 100) break
    }
    const total = num(pull.changed_files)
    if (total !== undefined && total > files.length)
      moreFiles = total - files.length
    return { body: str(pull.body), files, moreFiles }
  }

  public async listIssues(repo: RepoRecord, signal: AbortSignal): Promise<IssueSummary[]> {
    const token = await this.tokenFor(repo, signal)
    const answer = await this._context.fetch(`${this.restUrl}/repos/${repo.fullName}/issues?state=open&per_page=${MAX_PULLS_PER_REPO}&sort=updated`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": USER_AGENT },
      signal
    })
    return arr(await readJson(answer, `Listing issues of ${repo.fullName}`))
      .map((entry) => rec(entry))
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        repo: repo.fullName,
        number: num(issue.number) ?? 0,
        title: str(issue.title),
        author: str(rec(issue.user).login, "ghost"),
        url: str(issue.html_url),
        createdAt: str(issue.created_at),
        updatedAt: str(issue.updated_at),
        labels: arr(issue.labels).map((label) => (typeof label === "string" ? label : str(rec(label).name))),
        comments: num(issue.comments) ?? 0
      }))
  }

  public async issueBody(repo: RepoRecord, number: number, signal: AbortSignal): Promise<string> {
    const token = await this.tokenFor(repo, signal)
    const issue = await this.rest(`/repos/${repo.fullName}/issues/${number}`, token, signal, `Reading ${repo.fullName}#${number}`)
    return str(issue.body)
  }

  public async listLabels(repo: RepoRecord, signal: AbortSignal): Promise<string[]> {
    const token = await this.tokenFor(repo, signal)
    const answer = await this._context.fetch(`${this.restUrl}/repos/${repo.fullName}/labels?per_page=100`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": USER_AGENT },
      signal
    })
    return arr(await readJson(answer, `Listing labels of ${repo.fullName}`)).map((label) => str(rec(label).name)).filter(Boolean)
  }

  public async commentIssue(repo: RepoRecord, number: number, body: string, signal: AbortSignal): Promise<{ url?: string }> {
    const token = await this.tokenFor(repo, signal)
    const answer = await readJson(
      await this._context.fetch(`${this.restUrl}/repos/${repo.fullName}/issues/${number}/comments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": USER_AGENT, "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
        signal
      }),
      `Replying on ${repo.fullName}#${number}`
    )
    return { url: str(answer.html_url) || undefined }
  }

  public async labelIssue(repo: RepoRecord, number: number, labels: string[], signal: AbortSignal): Promise<void> {
    const token = await this.tokenFor(repo, signal)
    await readJson(
      await this._context.fetch(`${this.restUrl}/repos/${repo.fullName}/issues/${number}/labels`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": USER_AGENT, "Content-Type": "application/json" },
        body: JSON.stringify({ labels }),
        signal
      }),
      `Labelling ${repo.fullName}#${number}`
    )
  }

  public async postReview(repo: RepoRecord, pull: PullSummary, body: string, as: ReviewPostAs, signal: AbortSignal): Promise<{ url?: string }> {
    const token = await this.tokenFor(repo, signal)
    const response = await this._context.fetch(`${this.restUrl}/repos/${repo.fullName}/pulls/${pull.number}/reviews`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": USER_AGENT, "Content-Type": "application/json" },
      body: JSON.stringify({ body, event: as === "approve" ? "APPROVE" : as === "request-changes" ? "REQUEST_CHANGES" : "COMMENT" }),
      signal
    })
    const answer = await readJson(response, `Posting the review on ${repo.fullName}#${pull.number}`)
    return { url: str(answer.html_url, pull.url) }
  }

  public async handle(
    request: PluginRequest
  ): Promise<PluginResponse | undefined> {
    const { method, path } = request
    if (path === "app" && method === "PUT") {
      const body = await request.body()
      const appId = str(body.appId).trim()
      const privateKey = str(body.privateKey).trim()
      if (!/^[0-9]{1,12}$/.test(appId))
        throw new PluginError("The App ID is the number GitHub shows on the App's page.", 400)
      if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey))
        throw new PluginError(
          "Paste the whole private key file (.pem), from BEGIN to END.",
          400
        )
      const signal = timeoutSignal(20_000, { reason: () => noAnswer(20_000) })
      const app = await this.rest(
        "/app",
        appJwt(appId, privateKey, this._context.now()),
        signal,
        "Checking the App with GitHub"
      )
      const settings: AppSettings = {
        appId,
        privateKey: `${privateKey}\n`,
        ...(app.slug ? { slug: str(app.slug) } : {}),
        ...(app.name ? { name: str(app.name) } : {})
      }
      this._store.setSettings({ ...this._store.settings(), app: settings })
      this._installations.clear()
      this._tokens.clear()
      this._context.log.info({
        event: "plugin.github-app-set",
        key: request.principal,
        reason: str(app.slug, appId)
      })
      return json({ host: this.status() })
    }
    if (path === "app" && method === "DELETE") {
      const settings = this._store.settings()
      delete settings.app
      this._store.setSettings(settings)
      this._installations.clear()
      this._tokens.clear()
      this._context.log.info({
        event: "plugin.github-app-removed",
        key: request.principal
      })
      return json({ host: this.status() })
    }
    if (path === "app/repositories" && method === "GET") {
      const app = this.app()
      if (!app) throw new PluginError("No GitHub App is set up.", 409)
      const signal = timeoutSignal(20_000, { reason: () => noAnswer(20_000) })
      const installations = arr(
        await this.rest(
          "/app/installations?per_page=100",
          appJwt(app.appId, app.privateKey, this._context.now()),
          signal,
          "Listing the App's installations"
        )
      )
      const repositories: Array<{ fullName: string; account: string }> = []
      for (const entry of installations) {
        const installation = rec(entry)
        const id = num(installation.id)
        if (id === undefined) continue
        const token = await this.installationToken(app, id, signal)
        const answer = await this.rest(
          "/installation/repositories?per_page=100",
          token,
          signal,
          "Listing the App's repositories"
        )
        for (const repo of arr(answer.repositories)) {
          const fullName = str(rec(repo).full_name)
          if (fullName)
            repositories.push({
              fullName,
              account: str(rec(installation.account).login)
            })
        }
      }
      repositories.sort((a, b) => a.fullName.localeCompare(b.fullName))
      return json({ repositories })
    }
    return undefined
  }
}

export const githubPlugin: GatewayPlugin = {
  id: "github",
  name: "GitHub",
  description:
    "Watch repositories on GitHub (or GitHub Enterprise) and see their open pull requests, checks and review state. Reads with a GitHub App or a token.",
  create: (context) =>
    new PullsPlugin(context, (store, ctx) => new GitHubForge(store, ctx), undefined, "github")
}

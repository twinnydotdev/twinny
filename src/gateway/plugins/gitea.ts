/**
 * The Gitea plugin, which is also the Forgejo and Codeberg plugin: the
 * same API on every one of them. Open pulls of watched repositories,
 * read with an access token (scope: read on repository). Statuses and
 * reviews come from their own routes; a pull's changes from its `.diff`.
 */
import { arr, baseUrlOf, CheckState, Forge, IssueSummary, MAX_PULLS_PER_REPO, num, PullCheck, PullContent, PullSummary, readJson, rec, RepoRecord, RepoStore, ReviewPostAs, ReviewState, rollup, splitUnifiedDiff, str } from "./forge"
import { GatewayPlugin, PluginContext, PluginError } from "./host"
import { PullsPlugin } from "./pulls"

/** Codeberg runs Forgejo and is where most public Gitea-family repositories live. */
export const GITEA_URL = "https://codeberg.org"
const USER_AGENT = "twinny-server"

const statusState = (value: string): CheckState =>
  value === "success"
    ? "success"
    : value === "pending"
      ? "pending"
      : value === "" || value === "skipped"
        ? "none"
        : "failure"

export class GiteaForge implements Forge {
  public readonly noun = "Pull request"

  constructor(
    private readonly _store: RepoStore,
    private readonly _context: PluginContext
  ) {}

  private get baseUrl(): string {
    return baseUrlOf(this._store, GITEA_URL)
  }

  public repoUrl(fullName: string): string {
    return `${this.baseUrl}/${fullName}`
  }

  public hasAppAuth(): boolean {
    return false
  }

  public status() {
    return { baseUrl: this.baseUrl }
  }

  private headers(repo: RepoRecord, accept = "application/json"): Record<string, string> {
    if (!repo.token) throw new PluginError(`${repo.fullName} has no token.`, 409)
    return { Authorization: `token ${repo.token}`, Accept: accept, "User-Agent": USER_AGENT }
  }

  private api(repo: RepoRecord, route: string): string {
    return `${this.baseUrl}/api/v1/repos/${repo.fullName}${route}`
  }

  private async get(repo: RepoRecord, route: string, signal: AbortSignal, what: string): Promise<Record<string, unknown>> {
    return readJson(await this._context.fetch(this.api(repo, route), { headers: this.headers(repo), signal }), what)
  }

  public async whoAmI(repo: RepoRecord, signal: AbortSignal): Promise<string | undefined> {
    const answer = await readJson(await this._context.fetch(`${this.baseUrl}/api/v1/user`, { headers: this.headers(repo), signal }), "Asking the host who the token is")
    return str(answer.login) || undefined
  }

  public async checkRepo(repo: RepoRecord, signal: AbortSignal): Promise<string> {
    const answer = await this.get(repo, "", signal, `Reading ${repo.fullName}`)
    return str(answer.full_name, repo.fullName)
  }

  public async listPulls(repo: RepoRecord, signal: AbortSignal): Promise<PullSummary[]> {
    const what = `Listing pulls of ${repo.fullName}`
    const pulls = arr(await this.get(repo, `/pulls?state=open&sort=recentupdate&limit=${MAX_PULLS_PER_REPO}`, signal, what))
    const out: PullSummary[] = []
    /** Required approvals per base branch; the route needs admin rights, so a refusal means "unknown". */
    const rules = new Map<string, Promise<number | undefined>>()
    const requiredFor = (branch: string): Promise<number | undefined> => {
      let rule = rules.get(branch)
      if (!rule) {
        rule = this.get(repo, `/branch_protections/${encodeURIComponent(branch)}`, signal, `${what} (branch protection)`)
          .then((answer) => {
            const required = num(rec(answer).required_approvals)
            return required !== undefined && required > 0 ? required : undefined
          })
          .catch(() => undefined)
        rules.set(branch, rule)
      }
      return rule
    }
    for (const entry of pulls) {
      const pull = rec(entry)
      const number = num(pull.number) ?? 0
      const sha = str(rec(pull.head).sha)
      let checkRuns: PullCheck[] = []
      let review: ReviewState = "none"
      const approved: string[] = []
      const changes: string[] = []
      const pending = arr(pull.requested_reviewers).map((r) => str(rec(r).login)).filter(Boolean)
      if (sha) {
        // Combined status of the head commit, and the reviews, are their own calls.
        const [status, reviews] = await Promise.all([
          this.get(repo, `/commits/${sha}/status`, signal, `${what} (statuses)`).catch(() => ({})),
          this.get(repo, `/pulls/${number}/reviews`, signal, `${what} (reviews)`).catch(() => [] as unknown)
        ])
        checkRuns = arr(rec(status).statuses).map((s) => ({
          name: str(rec(s).context, "status"),
          state: statusState(str(rec(s).status)),
          ...(rec(s).target_url ? { url: str(rec(s).target_url) } : {})
        }))
        const latest = new Map<string, string>()
        for (const r of arr(reviews)) {
          const login = str(rec(rec(r).user).login)
          const state = str(rec(r).state)
          if (login && (state === "APPROVED" || state === "REQUEST_CHANGES")) latest.set(login, state)
        }
        const states = [...latest.values()]
        review = states.includes("REQUEST_CHANGES") ? "changes-requested" : states.includes("APPROVED") ? "approved" : "none"
        for (const [login, state] of latest) (state === "APPROVED" ? approved : changes).push(login)
      }
      const required = await requiredFor(str(rec(pull.base).ref))
      out.push({
        repo: repo.fullName,
        number,
        title: str(pull.title),
        author: str(rec(pull.user).login, "unknown"),
        url: str(pull.html_url, `${this.repoUrl(repo.fullName)}/pulls/${number}`),
        draft: pull.draft === true,
        createdAt: str(pull.created_at),
        updatedAt: str(pull.updated_at),
        headRef: str(rec(pull.head).ref),
        baseRef: str(rec(pull.base).ref),
        headSha: sha,
        additions: num(pull.additions),
        deletions: num(pull.deletions),
        changedFiles: num(pull.changed_files),
        checks: rollup(checkRuns),
        checkRuns,
        mergeable: pull.mergeable === true ? "mergeable" : pull.mergeable === false ? "conflicting" : "unknown",
        review,
        approvals: { approved, changes, pending: pending.filter((login) => !approved.includes(login) && !changes.includes(login)), ...(required !== undefined ? { required } : {}) },
        labels: arr(pull.labels).map((label) => str(rec(label).name))
      })
    }
    return out
  }

  public async listIssues(repo: RepoRecord, signal: AbortSignal): Promise<IssueSummary[]> {
    const answer = await this.get(repo, `/issues?type=issues&state=open&limit=${MAX_PULLS_PER_REPO}`, signal, `Listing issues of ${repo.fullName}`)
    return arr(answer).map((entry) => {
      const issue = rec(entry)
      return {
        repo: repo.fullName,
        number: num(issue.number) ?? 0,
        title: str(issue.title),
        author: str(rec(issue.user).login, "unknown"),
        url: str(issue.html_url),
        createdAt: str(issue.created_at),
        updatedAt: str(issue.updated_at),
        labels: arr(issue.labels).map((label) => str(rec(label).name)),
        comments: num(issue.comments) ?? 0
      }
    })
  }

  public async issueBody(repo: RepoRecord, number: number, signal: AbortSignal): Promise<string> {
    const issue = await this.get(repo, `/issues/${number}`, signal, `Reading ${repo.fullName}#${number}`)
    return str(issue.body)
  }

  public async listLabels(repo: RepoRecord, signal: AbortSignal): Promise<string[]> {
    return arr(await this.get(repo, "/labels?limit=100", signal, `Listing labels of ${repo.fullName}`)).map((label) => str(rec(label).name)).filter(Boolean)
  }

  public async commentIssue(repo: RepoRecord, number: number, body: string, signal: AbortSignal): Promise<{ url?: string }> {
    const answer = await readJson(
      await this._context.fetch(this.api(repo, `/issues/${number}/comments`), { method: "POST", headers: { ...this.headers(repo), "Content-Type": "application/json" }, body: JSON.stringify({ body }), signal }),
      `Replying on ${repo.fullName}#${number}`
    )
    return { url: str(answer.html_url) || undefined }
  }

  public async labelIssue(repo: RepoRecord, number: number, labels: string[], signal: AbortSignal): Promise<void> {
    // Gitea labels by id, so the names are looked up first.
    const all = arr(await this.get(repo, "/labels?limit=100", signal, `Listing labels of ${repo.fullName}`)).map((label) => rec(label))
    const ids = labels.map((name) => num(all.find((label) => str(label.name) === name)?.id)).filter((id): id is number => id !== undefined)
    await readJson(
      await this._context.fetch(this.api(repo, `/issues/${number}/labels`), { method: "POST", headers: { ...this.headers(repo), "Content-Type": "application/json" }, body: JSON.stringify({ labels: ids }), signal }),
      `Labelling ${repo.fullName}#${number}`
    )
  }

  public async postReview(repo: RepoRecord, pull: PullSummary, body: string, as: ReviewPostAs, signal: AbortSignal): Promise<{ url?: string }> {
    const answer = await readJson(
      await this._context.fetch(this.api(repo, `/pulls/${pull.number}/reviews`), {
        method: "POST",
        headers: { ...this.headers(repo), "Content-Type": "application/json" },
        body: JSON.stringify({ body, event: as === "approve" ? "APPROVED" : as === "request-changes" ? "REQUEST_CHANGES" : "COMMENT" }),
        signal
      }),
      `Posting the review on ${repo.fullName}#${pull.number}`
    )
    return { url: str(answer.html_url, pull.url) }
  }

  public async pullContent(repo: RepoRecord, number: number, signal: AbortSignal): Promise<PullContent> {
    const what = `Reading ${repo.fullName}#${number}`
    const pull = await this.get(repo, `/pulls/${number}`, signal, what)
    const response = await this._context.fetch(this.api(repo, `/pulls/${number}.diff`), {
      headers: this.headers(repo, "text/plain"),
      signal
    })
    if (!response.ok) throw new PluginError(`${what} (diff): status ${response.status}.`, 502)
    const { files, moreFiles } = splitUnifiedDiff(await response.text())
    return { body: str(pull.body), files, moreFiles }
  }
}

export const giteaPlugin: GatewayPlugin = {
  id: "gitea",
  name: "Gitea / Forgejo",
  description:
    "Watch repositories on your own Gitea or Forgejo (or Codeberg) and see their open pull requests, statuses and reviews. Reads with an access token per repository.",
  create: (context) => new PullsPlugin(context, (store, ctx) => new GiteaForge(store, ctx), undefined, "gitea")
}

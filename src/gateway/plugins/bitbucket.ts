/**
 * The Bitbucket plugin (Bitbucket Cloud): open pull requests of watched
 * repositories, read with an app password (`user:app-password`, sent as
 * Basic auth) or an API token (Bearer). Build statuses come from the
 * head commit, approvals from the pull's participants, the diff from
 * the pull's own diff route.
 */
import { arr, baseUrlOf, CheckState, Forge, MAX_PULLS_PER_REPO, num, PullCheck, PullContent, PullSummary, readJson, rec, RepoRecord, RepoStore, ReviewPostAs, ReviewState, rollup, splitUnifiedDiff, str } from "./forge"
import { GatewayPlugin, PluginContext, PluginError } from "./host"
import { PullsPlugin } from "./pulls"

export const BITBUCKET_URL = "https://bitbucket.org"
const USER_AGENT = "twinny-server"

const statusState = (value: string): CheckState =>
  value === "SUCCESSFUL" ? "success" : value === "INPROGRESS" ? "pending" : value === "" ? "none" : "failure"

export class BitbucketForge implements Forge {
  public readonly noun = "Pull request"

  constructor(
    private readonly _store: RepoStore,
    private readonly _context: PluginContext
  ) {}

  private get baseUrl(): string {
    return baseUrlOf(this._store, BITBUCKET_URL)
  }

  /** api.bitbucket.org for the cloud; `<host>/rest/api`-style servers are not supported. */
  private get apiUrl(): string {
    return this.baseUrl === BITBUCKET_URL ? "https://api.bitbucket.org/2.0" : `${this.baseUrl}/2.0`
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

  private headers(repo: RepoRecord): Record<string, string> {
    if (!repo.token) throw new PluginError(`${repo.fullName} has no token.`, 409)
    // `user:app-password` is Basic; anything else is taken as an API token.
    const auth = repo.token.includes(":")
      ? `Basic ${Buffer.from(repo.token, "utf8").toString("base64")}`
      : `Bearer ${repo.token}`
    return { Authorization: auth, Accept: "application/json", "User-Agent": USER_AGENT }
  }

  private api(repo: RepoRecord, route: string): string {
    return `${this.apiUrl}/repositories/${repo.fullName}${route}`
  }

  private async get(repo: RepoRecord, route: string, signal: AbortSignal, what: string): Promise<Record<string, unknown>> {
    return readJson(await this._context.fetch(this.api(repo, route), { headers: this.headers(repo), signal }), what)
  }

  public async whoAmI(repo: RepoRecord, signal: AbortSignal): Promise<string | undefined> {
    const answer = await readJson(await this._context.fetch(`${this.apiUrl}/user`, { headers: this.headers(repo), signal }), "Asking Bitbucket who the token is")
    return str(answer.nickname, str(answer.display_name)) || undefined
  }

  public async checkRepo(repo: RepoRecord, signal: AbortSignal): Promise<string> {
    const answer = await this.get(repo, "", signal, `Reading ${repo.fullName}`)
    return str(answer.full_name, repo.fullName)
  }

  public async listPulls(repo: RepoRecord, signal: AbortSignal): Promise<PullSummary[]> {
    const what = `Listing pulls of ${repo.fullName}`
    const answer = await this.get(
      repo,
      `/pullrequests?state=OPEN&pagelen=${MAX_PULLS_PER_REPO}&sort=-updated_on&fields=${encodeURIComponent("values.id,values.title,values.draft,values.created_on,values.updated_on,values.links.html.href,values.author.nickname,values.author.display_name,values.source.branch.name,values.source.commit.hash,values.destination.branch.name,values.participants.approved,values.participants.state,values.participants.role,values.participants.user.nickname,values.participants.user.display_name")}`,
      signal,
      what
    )
    const out: PullSummary[] = []
    for (const entry of arr(answer.values)) {
      const pull = rec(entry)
      const number = num(pull.id) ?? 0
      const sha = str(rec(rec(pull.source).commit).hash)
      let checkRuns: PullCheck[] = []
      if (sha) {
        const statuses = await this.get(repo, `/commit/${sha}/statuses?pagelen=100`, signal, `${what} (statuses)`).catch(() => ({}))
        checkRuns = arr(rec(statuses).values).map((s) => ({
          name: str(rec(s).name, str(rec(s).key, "build")),
          state: statusState(str(rec(s).state)),
          ...(rec(s).url ? { url: str(rec(s).url) } : {})
        }))
      }
      const participants = arr(pull.participants).map((p) => rec(p))
      const review: ReviewState = participants.some((p) => p.state === "changes_requested")
        ? "changes-requested"
        : participants.some((p) => p.approved === true)
          ? "approved"
          : "none"
      const reviewers = participants.filter((p) => p.role === "REVIEWER")
      const nameOf = (p: Record<string, unknown>): string => str(rec(p.user).nickname, str(rec(p.user).display_name))
      const approvals = {
        approved: reviewers.filter((p) => p.approved === true).map(nameOf).filter(Boolean),
        changes: reviewers.filter((p) => p.state === "changes_requested").map(nameOf).filter(Boolean),
        pending: reviewers.filter((p) => p.approved !== true && p.state !== "changes_requested").map(nameOf).filter(Boolean)
      }
      const author = rec(pull.author)
      out.push({
        repo: repo.fullName,
        number,
        title: str(pull.title),
        author: str(author.nickname, str(author.display_name, "unknown")),
        url: str(rec(rec(pull.links).html).href, `${this.repoUrl(repo.fullName)}/pull-requests/${number}`),
        draft: pull.draft === true,
        createdAt: str(pull.created_on),
        updatedAt: str(pull.updated_on),
        headRef: str(rec(rec(pull.source).branch).name),
        baseRef: str(rec(rec(pull.destination).branch).name),
        headSha: sha,
        checks: rollup(checkRuns),
        checkRuns,
        mergeable: "unknown",
        review,
        approvals,
        labels: []
      })
    }
    return out
  }

  public async postReview(repo: RepoRecord, pull: PullSummary, body: string, as: ReviewPostAs, signal: AbortSignal): Promise<{ url?: string }> {
    const what = `Posting the review on ${repo.fullName}#${pull.number}`
    const comment = await readJson(
      await this._context.fetch(this.api(repo, `/pullrequests/${pull.number}/comments`), {
        method: "POST",
        headers: { ...this.headers(repo), "Content-Type": "application/json" },
        body: JSON.stringify({ content: { raw: body } }),
        signal
      }),
      what
    )
    if (as !== "comment") {
      const response = await this._context.fetch(this.api(repo, `/pullrequests/${pull.number}/${as === "approve" ? "approve" : "request-changes"}`), { method: "POST", headers: this.headers(repo), signal })
      if (!response.ok) await readJson(response, `${what} (${as})`)
    }
    return { url: str(rec(rec(comment.links).html).href, pull.url) }
  }

  public async pullContent(repo: RepoRecord, number: number, signal: AbortSignal): Promise<PullContent> {
    const what = `Reading ${repo.fullName}#${number}`
    const pull = await this.get(repo, `/pullrequests/${number}`, signal, what)
    const response = await this._context.fetch(this.api(repo, `/pullrequests/${number}/diff`), {
      headers: { ...this.headers(repo), Accept: "text/plain" },
      signal
    })
    if (!response.ok) throw new PluginError(`${what} (diff): status ${response.status}.`, 502)
    const { files, moreFiles } = splitUnifiedDiff(await response.text())
    return { body: str(rec(pull.summary).raw, str(pull.description)), files, moreFiles }
  }
}

export const bitbucketPlugin: GatewayPlugin = {
  id: "bitbucket",
  name: "Bitbucket",
  description:
    "Watch repositories on Bitbucket Cloud and see their open pull requests, build statuses and approvals. Reads with an app password or API token per repository.",
  create: (context) => new PullsPlugin(context, (store, ctx) => new BitbucketForge(store, ctx), undefined, "bitbucket")
}

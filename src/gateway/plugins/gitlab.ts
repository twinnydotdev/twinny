/**
 * The GitLab plugin: open merge requests of watched projects, on
 * gitlab.com or a self-managed instance, read with a project, group or
 * personal access token (scope `read_api`).
 *
 * The list comes from GraphQL (one call per project, pipeline and
 * approval state included); a merge request's description and diffs
 * from the REST API. GitLab has no app install to lean on, so every
 * project brings a token; a group token pasted for each project works.
 */
import { arr, baseUrlOf, CheckState, cutPatch, Forge, IssueSummary, MAX_FILES, MAX_PULLS_PER_REPO, MergeState, num, PullApprovals, PullCheck, PullContent, PullFile, PullSummary, readJson, rec, RepoRecord, RepoStore, ReviewPostAs, ReviewState, rollup, str } from "./forge"
import {
  GatewayPlugin,
  PluginContext,
  PluginError
} from "./host"
import { PullsPlugin } from "./pulls"

export const GITLAB_URL = "https://gitlab.com"
const USER_AGENT = "twinny-server"

const PULLS_QUERY = `query($path: ID!, $first: Int!) {
  project(fullPath: $path) {
    fullPath
    mergeRequests(state: opened, first: $first, sort: UPDATED_DESC) {
      nodes {
        iid title webUrl draft createdAt updatedAt sourceBranch targetBranch diffHeadSha
        conflicts detailedMergeStatus approved approvalsLeft approvalsRequired
        approvedBy { nodes { username } }
        reviewers { nodes { username mergeRequestInteraction { reviewState } } }
        author { username }
        labels { nodes { title } }
        diffStatsSummary { additions deletions fileCount }
        headPipeline { status path jobs(first: 50) { nodes { name status webPath } } }
      }
    }
  }
}`

export interface GitLabStatus {
  baseUrl: string
}

const jobState = (status: string): CheckState => {
  switch (status) {
    case "SUCCESS":
    case "SKIPPED":
    case "MANUAL":
      return "success"
    case "FAILED":
    case "CANCELED":
      return "failure"
    case "":
      return "none"
    default:
      return "pending"
  }
}

const mergeState = (node: Record<string, unknown>): MergeState => {
  if (node.conflicts === true) return "conflicting"
  switch (str(node.detailedMergeStatus)) {
    case "MERGEABLE":
      return "mergeable"
    case "CONFLICT":
      return "conflicting"
    case "":
    case "UNCHECKED":
    case "CHECKING":
      return "unknown"
    default:
      return "blocked"
  }
}

const reviewState = (node: Record<string, unknown>): ReviewState => {
  if (node.approved === true) return "approved"
  const left = num(node.approvalsLeft) ?? 0
  return left > 0 || str(node.detailedMergeStatus) === "NOT_APPROVED"
    ? "review-required"
    : "none"
}

const toPull = (
  repo: string,
  baseUrl: string,
  node: Record<string, unknown>
): PullSummary => {
  const pipeline = rec(node.headPipeline)
  const jobs = arr(rec(pipeline.jobs).nodes)
  const checkRuns: PullCheck[] =
    jobs.length > 0
      ? jobs.map((entry) => {
          const job = rec(entry)
          return {
            name: str(job.name, "job"),
            state: jobState(str(job.status)),
            ...(job.webPath ? { url: `${baseUrl}${str(job.webPath)}` } : {})
          }
        })
      : pipeline.status
        ? [
            {
              name: "pipeline",
              state: jobState(str(pipeline.status)),
              ...(pipeline.path ? { url: `${baseUrl}${str(pipeline.path)}` } : {})
            }
          ]
        : []
  const stats = rec(node.diffStatsSummary)
  return {
    repo,
    number: num(node.iid) ?? (Number(str(node.iid)) || 0),
    title: str(node.title),
    author: str(rec(node.author).username, "unknown"),
    url: str(node.webUrl),
    draft: node.draft === true,
    createdAt: str(node.createdAt),
    updatedAt: str(node.updatedAt),
    headRef: str(node.sourceBranch),
    baseRef: str(node.targetBranch),
    headSha: str(node.diffHeadSha),
    additions: num(stats.additions),
    deletions: num(stats.deletions),
    changedFiles: num(stats.fileCount),
    checks: rollup(checkRuns),
    checkRuns,
    mergeable: mergeState(node),
    review: reviewState(node),
    approvals: approvalsOf(node),
    labels: arr(rec(node.labels).nodes).map((label) => str(rec(label).title))
  }
}

/** Who approved, which reviewers asked for changes or have not answered, and the approval rule. */
const approvalsOf = (node: Record<string, unknown>): PullApprovals => {
  const approved = arr(rec(node.approvedBy).nodes).map((entry) => str(rec(entry).username)).filter(Boolean)
  const changes: string[] = []
  const pending: string[] = []
  for (const entry of arr(rec(node.reviewers).nodes)) {
    const reviewer = rec(entry)
    const name = str(reviewer.username)
    if (!name || approved.includes(name)) continue
    const state = str(rec(reviewer.mergeRequestInteraction).reviewState)
    if (state === "REQUESTED_CHANGES") changes.push(name)
    else if (state !== "REVIEWED" && state !== "APPROVED") pending.push(name)
  }
  const required = num(node.approvalsRequired)
  return { approved, changes, pending, ...(required !== undefined && required > 0 ? { required } : {}) }
}

/** Lines added and removed in a unified diff body. */
const countDiff = (diff: string): { additions: number; deletions: number } => {
  let additions = 0
  let deletions = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++
  }
  return { additions, deletions }
}

export class GitLabForge implements Forge {
  public readonly noun = "Merge request"

  constructor(
    private readonly _store: RepoStore,
    private readonly _context: PluginContext
  ) {}

  private get baseUrl(): string {
    return baseUrlOf(this._store, GITLAB_URL)
  }

  public repoUrl(fullName: string): string {
    return `${this.baseUrl}/${fullName}`
  }

  public hasAppAuth(): boolean {
    return false
  }

  public status(): GitLabStatus {
    return { baseUrl: this.baseUrl }
  }

  private token(repo: RepoRecord): string {
    if (!repo.token) throw new PluginError(`${repo.fullName} has no token.`, 409)
    return repo.token
  }

  private headers(repo: RepoRecord): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token(repo)}`,
      "User-Agent": USER_AGENT
    }
  }

  private project(repo: RepoRecord): string {
    return `${this.baseUrl}/api/v4/projects/${encodeURIComponent(repo.fullName)}`
  }

  public async whoAmI(repo: RepoRecord, signal: AbortSignal): Promise<string | undefined> {
    const response = await this._context.fetch(`${this.baseUrl}/api/v4/user`, { headers: this.headers(repo), signal })
    return str((await readJson(response, "Asking GitLab who the token is")).username) || undefined
  }

  public async checkRepo(repo: RepoRecord, signal: AbortSignal): Promise<string> {
    const response = await this._context.fetch(this.project(repo), {
      headers: this.headers(repo),
      signal
    })
    const answer = await readJson(response, `Reading ${repo.fullName}`)
    return str(answer.path_with_namespace, repo.fullName)
  }

  public async listPulls(
    repo: RepoRecord,
    signal: AbortSignal
  ): Promise<PullSummary[]> {
    const what = `Listing merge requests of ${repo.fullName}`
    const response = await this._context.fetch(`${this.baseUrl}/api/graphql`, {
      method: "POST",
      headers: { ...this.headers(repo), "Content-Type": "application/json" },
      body: JSON.stringify({
        query: PULLS_QUERY,
        variables: { path: repo.fullName, first: MAX_PULLS_PER_REPO }
      }),
      signal
    })
    const answer = await readJson(response, what)
    const errors = arr(answer.errors)
    if (errors.length > 0)
      throw new PluginError(
        `${what}: ${errors.map((error) => str(rec(error).message, "error")).join("; ")}.`,
        502
      )
    const project = rec(rec(answer.data).project)
    if (!project.fullPath)
      throw new PluginError(
        `${what}: not found, or the token cannot see it.`,
        502
      )
    return arr(rec(project.mergeRequests).nodes).map((node) =>
      toPull(repo.fullName, this.baseUrl, rec(node))
    )
  }

  public async listIssues(repo: RepoRecord, signal: AbortSignal): Promise<IssueSummary[]> {
    const answer = await readJson(
      await this._context.fetch(`${this.project(repo)}/issues?state=opened&per_page=${MAX_PULLS_PER_REPO}&order_by=updated_at`, { headers: this.headers(repo), signal }),
      `Listing issues of ${repo.fullName}`
    )
    return arr(answer).map((entry) => {
      const issue = rec(entry)
      return {
        repo: repo.fullName,
        number: num(issue.iid) ?? 0,
        title: str(issue.title),
        author: str(rec(issue.author).username, "unknown"),
        url: str(issue.web_url),
        createdAt: str(issue.created_at),
        updatedAt: str(issue.updated_at),
        labels: arr(issue.labels).map((label) => (typeof label === "string" ? label : str(rec(label).name))),
        comments: num(issue.user_notes_count) ?? 0
      }
    })
  }

  public async issueBody(repo: RepoRecord, number: number, signal: AbortSignal): Promise<string> {
    const issue = await readJson(await this._context.fetch(`${this.project(repo)}/issues/${number}`, { headers: this.headers(repo), signal }), `Reading ${repo.fullName}#${number}`)
    return str(issue.description)
  }

  public async listLabels(repo: RepoRecord, signal: AbortSignal): Promise<string[]> {
    const answer = await readJson(await this._context.fetch(`${this.project(repo)}/labels?per_page=100`, { headers: this.headers(repo), signal }), `Listing labels of ${repo.fullName}`)
    return arr(answer).map((label) => str(rec(label).name)).filter(Boolean)
  }

  public async commentIssue(repo: RepoRecord, number: number, body: string, signal: AbortSignal): Promise<{ url?: string }> {
    const note = await readJson(
      await this._context.fetch(`${this.project(repo)}/issues/${number}/notes`, { method: "POST", headers: { ...this.headers(repo), "Content-Type": "application/json" }, body: JSON.stringify({ body }), signal }),
      `Replying on ${repo.fullName}#${number}`
    )
    const id = num(note.id)
    return { url: id !== undefined ? `${this.repoUrl(repo.fullName)}/-/issues/${number}#note_${id}` : undefined }
  }

  public async labelIssue(repo: RepoRecord, number: number, labels: string[], signal: AbortSignal): Promise<void> {
    await readJson(
      await this._context.fetch(`${this.project(repo)}/issues/${number}`, { method: "PUT", headers: { ...this.headers(repo), "Content-Type": "application/json" }, body: JSON.stringify({ add_labels: labels.join(",") }), signal }),
      `Labelling ${repo.fullName}#${number}`
    )
  }

  public async postReview(repo: RepoRecord, pull: PullSummary, body: string, as: ReviewPostAs, signal: AbortSignal): Promise<{ url?: string }> {
    const what = `Posting the review on ${repo.fullName}!${pull.number}`
    const note = await readJson(
      await this._context.fetch(`${this.project(repo)}/merge_requests/${pull.number}/notes`, {
        method: "POST",
        headers: { ...this.headers(repo), "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
        signal
      }),
      what
    )
    // GitLab has approvals but no "request changes": that stays a note.
    if (as === "approve")
      await readJson(await this._context.fetch(`${this.project(repo)}/merge_requests/${pull.number}/approve`, { method: "POST", headers: this.headers(repo), signal }), `${what} (approve)`)
    const id = num(note.id)
    return { url: id !== undefined ? `${pull.url}#note_${id}` : pull.url }
  }

  public async pullContent(
    repo: RepoRecord,
    number: number,
    signal: AbortSignal
  ): Promise<PullContent> {
    const what = `Reading ${repo.fullName}!${number}`
    const detail = await readJson(
      await this._context.fetch(`${this.project(repo)}/merge_requests/${number}`, {
        headers: this.headers(repo),
        signal
      }),
      what
    )
    const files: PullFile[] = []
    let moreFiles = 0
    for (let page = 1; page <= Math.ceil(MAX_FILES / 100); page++) {
      const entries = arr(
        await readJson(
          await this._context.fetch(
            `${this.project(repo)}/merge_requests/${number}/diffs?per_page=100&page=${page}`,
            { headers: this.headers(repo), signal }
          ),
          `${what} (diffs)`
        )
      )
      for (const entry of entries) {
        const file = rec(entry)
        if (files.length >= MAX_FILES) {
          moreFiles++
          continue
        }
        const diff = str(file.diff)
        const renamed = file.renamed_file === true
        files.push({
          path: str(file.new_path),
          ...(renamed ? { previousPath: str(file.old_path) } : {}),
          status:
            file.new_file === true
              ? "added"
              : file.deleted_file === true
                ? "removed"
                : renamed
                  ? "renamed"
                  : "modified",
          ...countDiff(diff),
          ...cutPatch(diff || undefined)
        })
      }
      if (entries.length < 100) break
    }
    return { body: str(detail.description), files, moreFiles }
  }
}

export const gitlabPlugin: GatewayPlugin = {
  id: "gitlab",
  name: "GitLab",
  description:
    "Watch projects on gitlab.com or a self-managed GitLab and see their open merge requests, pipelines and approvals. Reads with an access token per project.",
  create: (context) =>
    new PullsPlugin(context, (store, ctx) => new GitLabForge(store, ctx), undefined, "gitlab")
}

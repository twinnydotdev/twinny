/**
 * The page of a pull-request plugin (GitHub, GitLab): the watched
 * repositories with their sync state, the open pulls across them with
 * checks, mergeability and review state, and one pull opened with its
 * description and diffs. Talks only to the plugin's own routes.
 */
import React, { FormEvent, useCallback, useEffect, useMemo, useState } from "react"

import { messageOf } from "../../common/errors"
import type { PullPage, PullSummary, RepoView, TokenView } from "../plugins/forge"
import type { GitHubStatus } from "../plugins/github"
import type { ReviewBrief, ReviewRecord } from "../plugins/reviews"
import type { TriageBrief, TriagePriority, TriageRecord } from "../plugins/triage"

import { api, ApiError } from "./api"
import { fmt, plural, timeAgo } from "./format"
import { forgetHostName, hostNameHint, isGitHubDotCom } from "./host-names"
import { Age, AGE_OPTIONS, distinct, FilterSelect, Sort, SortHeader, sortRows, toggleSort, useStoredState, withinAge } from "./listing"
import { DiffBlock, MarkdownView } from "./markdown"
import { PageSkeleton, PluginIcon } from "./plugins"

export type PullsHost = "github" | "gitlab" | "gitea" | "bitbucket"

const HOST_NAMES: Record<PullsHost, string> = { github: "GitHub", gitlab: "GitLab", gitea: "Gitea / Forgejo", bitbucket: "Bitbucket" }

interface HostWords {
  noun: string
  nouns: string
  /** The `#12` / `!12` prefix the host uses. */
  hash: string
  repoNoun: string
  tokenHint: string
  fullNameHint: string
}

const WORDS: Record<PullsHost, HostWords> = {
  github: {
    noun: "pull request",
    nouns: "pull requests",
    hash: "#",
    repoNoun: "repository",
    tokenHint: "A classic token with repo scope reads every repository you can; a fine-grained one (Pull requests, Contents, Checks and Commit statuses: read) only those it was given.",
    fullNameHint: "owner/name"
  },
  gitlab: {
    noun: "merge request",
    nouns: "merge requests",
    hash: "!",
    repoNoun: "project",
    tokenHint: "A project, group or personal access token with the read_api scope.",
    fullNameHint: "group/project"
  },
  gitea: {
    noun: "pull request",
    nouns: "pull requests",
    hash: "#",
    repoNoun: "repository",
    tokenHint: "An access token from Settings → Applications with read access to repositories. Set your instance's URL below; codeberg.org is the default.",
    fullNameHint: "owner/name"
  },
  bitbucket: {
    noun: "pull request",
    nouns: "pull requests",
    hash: "#",
    repoNoun: "repository",
    tokenHint: "An app password as user:app-password (Repositories and Pull requests: read), or an API token.",
    fullNameHint: "workspace/repo-slug"
  }
}

interface ReviewSetup {
  available: boolean
  aliases: string[]
  alias?: string
  busy: boolean
}

interface Overview {
  repos: RepoView[]
  /** Saved tokens; empty for a developer. */
  tokens: TokenView[]
  /** Whether the host can list what a token reads. */
  canListRepos: boolean
  appAuth: boolean
  host: { baseUrl: string } & Partial<GitHubStatus>
  /** Who the operator is on the host: set by hand, or what a token said. */
  me: { name?: string; detected?: string }
  review: ReviewSetup
}

/** The one-click views of the pulls table. */
type Quick = "all" | "mine" | "ready" | "failing" | "conflicts" | "review" | "approved" | "drafts" | "unreviewed"

const QUICK_LABEL: Record<Quick, string> = {
  all: "all",
  mine: "waiting for me",
  ready: "ready to merge",
  failing: "failing",
  conflicts: "conflicts",
  review: "needs review",
  approved: "approved",
  drafts: "drafts",
  unreviewed: "no model review"
}
const QUICK_TITLE: Partial<Record<Quick, string>> = {
  mine: "Not yours, not a draft, and without your approval",
  ready: "Not a draft, checks green or absent, no conflicts, approved or needing no review",
  review: "Waiting for a reviewer, or with changes requested",
  unreviewed: "Never reviewed by a model, or the review is for an earlier commit or failed"
}
const QUICKS = Object.keys(QUICK_LABEL) as Quick[]

type PullSortKey = "updated" | "created" | "title" | "author" | "checks" | "merge" | "review" | "approvals" | "size" | "number"

const PULL_SORTS: Array<{ key: PullSortKey; label: string; natural: "asc" | "desc" }> = [
  { key: "updated", label: "last updated", natural: "desc" },
  { key: "created", label: "opened", natural: "desc" },
  { key: "number", label: "number", natural: "desc" },
  { key: "title", label: "title", natural: "asc" },
  { key: "author", label: "author", natural: "asc" },
  { key: "size", label: "size of change", natural: "desc" },
  { key: "checks", label: "checks", natural: "asc" },
  { key: "merge", label: "merge state", natural: "asc" },
  { key: "review", label: "review state", natural: "asc" },
  { key: "approvals", label: "approvals", natural: "desc" }
]
const naturalOf = <K extends string>(sorts: Array<{ key: K; natural: "asc" | "desc" }>, key: K): "asc" | "desc" => sorts.find((sort) => sort.key === key)?.natural ?? "asc"

/** Worst first, so an ascending sort surfaces what needs a hand. */
const CHECK_RANK: Record<PullSummary["checks"], number> = { failure: 0, pending: 1, none: 2, success: 3 }
const MERGE_RANK: Record<PullSummary["mergeable"], number> = { conflicting: 0, blocked: 1, unknown: 2, mergeable: 3 }
const REVIEW_RANK: Record<PullSummary["review"], number> = { "changes-requested": 0, "review-required": 1, none: 2, approved: 3 }

interface PullFilters {
  quick: Quick
  repo: string
  author: string
  label: string
  base: string
  age: Age
  /** Drafts stay out of the list until switched on; the "drafts" view shows them regardless. */
  drafts: boolean
  sort: Sort<PullSortKey>
}

const DEFAULT_PULL_FILTERS: PullFilters = { quick: "all", repo: "", author: "", label: "", base: "", age: "", drafts: false, sort: { key: "updated", dir: "desc" } }

const isPullFilters = (value: unknown): value is PullFilters => {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  const sort = v.sort as Record<string, unknown> | undefined
  return (
    QUICKS.includes(v.quick as Quick) &&
    ["repo", "author", "label", "base", "age"].every((field) => typeof v[field] === "string") &&
    typeof v.drafts === "boolean" &&
    sort !== undefined &&
    PULL_SORTS.some((entry) => entry.key === sort.key) &&
    (sort.dir === "asc" || sort.dir === "desc")
  )
}

const CHECK_LABEL: Record<PullSummary["checks"], string> = {
  success: "checks pass",
  failure: "checks fail",
  pending: "checks running",
  none: "no checks"
}
const CHECK_TONE: Record<PullSummary["checks"], string> = {
  success: "ok",
  failure: "bad",
  pending: "warn",
  none: ""
}
const MERGE_LABEL: Record<PullSummary["mergeable"], string> = {
  mergeable: "mergeable",
  conflicting: "conflicts",
  blocked: "blocked",
  unknown: "merge state unknown"
}
const MERGE_TONE: Record<PullSummary["mergeable"], string> = {
  mergeable: "ok",
  conflicting: "bad",
  blocked: "warn",
  unknown: ""
}
const REVIEW_LABEL: Record<PullSummary["review"], string> = {
  approved: "approved",
  "changes-requested": "changes requested",
  "review-required": "needs review",
  none: "no review"
}
const REVIEW_TONE: Record<PullSummary["review"], string> = {
  approved: "ok",
  "changes-requested": "bad",
  "review-required": "warn",
  none: ""
}

type MyStance = "yours" | "approved" | "changes" | "asked" | "not-reviewed"

/** Where you stand on a pull, once the page knows who you are and the host said who reviewed. */
const myStance = (pull: PullSummary, me: string | undefined): MyStance | undefined => {
  if (me === undefined || !pull.approvals) return undefined
  const isMe = (name: string) => name.toLowerCase() === me.toLowerCase()
  if (isMe(pull.author)) return "yours"
  if (pull.approvals.approved.some(isMe)) return "approved"
  if (pull.approvals.changes.some(isMe)) return "changes"
  if (pull.approvals.pending.some(isMe)) return "asked"
  return "not-reviewed"
}

const STANCE_LABEL: Record<MyStance, string> = { yours: "yours", approved: "you approved", changes: "you asked for changes", asked: "your review asked", "not-reviewed": "not reviewed by you" }
const STANCE_CLASS: Record<MyStance, string> = { yours: "", approved: "reviewed", changes: "failed", asked: "stale", "not-reviewed": "stale" }

const MyReviewTag = ({ pull, me }: { pull: PullSummary; me?: string }) => {
  const stance = myStance(pull, me)
  return stance ? (
    <span className={`tag stance ${STANCE_CLASS[stance]}`} title={`You are ${me}`}>
      {STANCE_LABEL[stance]}
    </span>
  ) : null
}

/** Someone else's open pull that you have not approved, by the host's account of reviews. */
const waitingForMe = (pull: PullSummary, me: string | undefined): boolean =>
  me !== undefined && !pull.draft && pull.author.toLowerCase() !== me.toLowerCase() && pull.approvals !== undefined && !pull.approvals.approved.some((name) => name.toLowerCase() === me.toLowerCase())

const matches = (pull: PullSummary, quick: Quick, brief: ReviewBrief | undefined, me: string | undefined): boolean => {
  switch (quick) {
    case "all":
      return true
    case "mine":
      return waitingForMe(pull, me)
    case "ready":
      return !pull.draft && pull.checks !== "failure" && pull.checks !== "pending" && pull.mergeable === "mergeable" && (pull.review === "approved" || pull.review === "none") && !shortOfApprovals(pull)
    case "failing":
      return pull.checks === "failure"
    case "conflicts":
      return pull.mergeable === "conflicting"
    case "review":
      return pull.review === "review-required" || pull.review === "changes-requested" || shortOfApprovals(pull) || (pull.approvals?.pending.length ?? 0) > 0
    case "approved":
      return pull.review === "approved"
    case "drafts":
      return pull.draft
    case "unreviewed":
      return !brief || brief.stale || brief.status === "failed"
  }
}

/** The base branch wants more approvals than it has. */
const shortOfApprovals = (pull: PullSummary): boolean => pull.approvals?.required !== undefined && pull.approvals.approved.length < pull.approvals.required

const pullSortValue = (pull: PullSummary, key: PullSortKey): string | number | undefined => {
  switch (key) {
    case "updated":
      return Date.parse(pull.updatedAt)
    case "created":
      return Date.parse(pull.createdAt)
    case "title":
      return pull.title
    case "author":
      return pull.author
    case "checks":
      return CHECK_RANK[pull.checks]
    case "merge":
      return MERGE_RANK[pull.mergeable]
    case "review":
      return REVIEW_RANK[pull.review]
    case "approvals":
      return pull.approvals ? pull.approvals.approved.length - (pull.approvals.required ?? 0) / 1000 : undefined
    case "size":
      return pull.additions === undefined && pull.deletions === undefined ? undefined : (pull.additions ?? 0) + (pull.deletions ?? 0)
    case "number":
      return pull.number
  }
}

const Pill = ({ tone, children, title }: { tone: string; children: React.ReactNode; title?: string }) => (
  <span className={`pill-s ${tone}`} title={title}>
    {children}
  </span>
)

const names = (list: string[]): string => (list.length ? list.join(", ") : "nobody")

/**
 * "1/2 approved · 1 changes · 2 asked": how far a pull is from the
 * approvals its branch wants, who still has to answer. Nothing when the
 * host gave no detail or nobody is involved yet.
 */
const Approvals = ({ pull, long }: { pull: PullSummary; long?: boolean }) => {
  const a = pull.approvals
  if (!a || (a.approved.length === 0 && a.changes.length === 0 && a.pending.length === 0 && a.required === undefined)) return null
  const short = shortOfApprovals(pull)

  const title = `approved by ${names(a.approved)}${a.required !== undefined ? ` (${a.required} needed)` : ""}\nchanges requested by ${names(a.changes)}\nwaiting for ${names(a.pending)}`
  return (
    <span className={`approvals ${long ? "long" : ""}`} title={title}>
      <span className={a.required !== undefined ? (short ? "warn-text" : "ins-text") : a.approved.length ? "ins-text" : ""}>
        {a.required !== undefined ? `${fmt(a.approved.length)}/${fmt(a.required)}` : fmt(a.approved.length)} approved{long && a.approved.length ? ` by ${names(a.approved)}` : ""}
      </span>
      {a.changes.length > 0 && <span className="bad-text">{long ? `changes requested by ${names(a.changes)}` : `${fmt(a.changes.length)} changes`}</span>}
      {a.pending.length > 0 && <span className="muted">{long ? `waiting for ${names(a.pending)}` : `${fmt(a.pending.length)} asked`}</span>}
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/*  Repositories                                                              */
/* -------------------------------------------------------------------------- */

/** How a saved token is named on the page: its label, else whose it is. */
/** "3 repositories", "1 project". */
const countOf = (n: number, words: HostWords): string => plural(n, words.repoNoun, words.repoNoun === "project" ? "projects" : "repositories")

const tokenName = (token: TokenView): string => token.label || (token.login ? `${token.login}'s token` : `token ${token.id.slice(0, 4)}`)

/** Where the add form's token choice points: a saved token, a new one, or the app. */
const NEW_TOKEN = "new"
const APP = "app"

/** The token most repositories already share, which a new repository most likely wants too. */
const likeliestToken = (tokens: TokenView[]): string =>
  tokens.length ? [...tokens].sort((a, b) => b.repos - a.repos)[0].id : NEW_TOKEN

interface ReposPanelProps {
  host: PullsHost
  words: HostWords
  overview: Overview
  base: string
  apiKey: string
  onChanged: () => Promise<void>
}

const ReposPanel = ({ host, words, overview, base, apiKey, onChanged }: ReposPanelProps) => {
  const [fullName, setFullName] = useState("")
  const [token, setToken] = useState("")
  const [readsWith, setReadsWith] = useState<string>(() => (overview.tokens.length ? likeliestToken(overview.tokens) : overview.appAuth ? APP : NEW_TOKEN))
  // A token saved or removed elsewhere on the page: never post a dead id, and offer a fresh one.
  useEffect(() => {
    const known = readsWith === APP ? overview.appAuth : readsWith === NEW_TOKEN || overview.tokens.some((entry) => entry.id === readsWith)
    if (!known || (readsWith === NEW_TOKEN && overview.tokens.length > 0 && !token)) setReadsWith(overview.tokens.length ? likeliestToken(overview.tokens) : overview.appAuth ? APP : NEW_TOKEN)
  }, [overview.tokens, overview.appAuth])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [confirm, setConfirm] = useState<string | null>(null)
  const [picker, setPicker] = useState<Array<{ fullName: string; account: string }> | null>(null)

  const run = async (what: string, action: () => Promise<unknown>) => {
    setBusy(what)
    setError(undefined)
    try {
      await action()
      await onChanged()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(null)
    }
  }

  const add = (e: FormEvent) => {
    e.preventDefault()
    const name = fullName.trim()
    if (!name) return
    void run("add", async () => {
      const body = readsWith === NEW_TOKEN ? { token: token.trim() } : readsWith === APP ? {} : { tokenId: readsWith }
      const answer = await api<{ repo: RepoView }>(`${base}/repos`, apiKey, { method: "POST", body: { fullName: name, ...body } })
      setFullName("")
      setToken("")
      // A token pasted here is saved now: the next repository can pick it.
      if (readsWith === NEW_TOKEN && answer.repo.tokenId) setReadsWith(answer.repo.tokenId)
    })
  }

  const addFromApp = (name: string) =>
    run(`add:${name}`, async () => {
      await api(`${base}/repos`, apiKey, { method: "POST", body: { fullName: name } })
      setPicker((list) => list && list.filter((entry) => entry.fullName !== name))
    })

  const loadPicker = () =>
    run("picker", async () => {
      const answer = await api<{ repositories: Array<{ fullName: string; account: string }> }>(`${base}/app/repositories`, apiKey)
      const watched = new Set(overview.repos.map((repo) => repo.fullName.toLowerCase()))
      setPicker(answer.repositories.filter((entry) => !watched.has(entry.fullName.toLowerCase())))
    })

  return (
    <section className="panel">
      <div className="section-heading">
        <h2>
          {words.repoNoun === "project" ? "Projects" : "Repositories"}
          <span className="count">{fmt(overview.repos.length)}</span>
        </h2>
        <span className="muted">{overview.host.baseUrl}</span>
      </div>
      {error && <div className="error">{error}</div>}
      {overview.repos.length === 0 ? (
        <div className="empty">Nothing watched yet. Add a {words.repoNoun} below.</div>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>{words.repoNoun}</th>
                <th>reads with</th>
                <th>open</th>
                <th>failing</th>
                <th>synced</th>
                <th title="Review new and updated pulls in the background while the models are idle">auto-review</th>
                <th title="Post every finished review to the host as a comment">auto-post</th>
                <th title="Triage new issues in the background; replies and labels still wait for a click">auto-triage</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {overview.repos.map((repo) => {
                const failing = repo.pulls.filter((pull) => pull.checks === "failure").length
                return (
                  <tr key={repo.id} className={repo.error ? "repo-error" : ""}>
                    <td>
                      <a href={repo.url} target="_blank" rel="noreferrer" className="entity-name">
                        {repo.fullName}
                      </a>
                      {repo.error && <div className="repo-problem">{repo.error}</div>}
                    </td>
                    <td>
                      <select
                        className="mini"
                        value={repo.tokenId ?? APP}
                        disabled={busy !== null}
                        aria-label={`What ${repo.fullName} reads with`}
                        onChange={(e) => void run(`token:${repo.id}`, () => api(`${base}/repos/${repo.id}`, apiKey, { method: "PUT", body: { tokenId: e.target.value === APP ? null : e.target.value } }))}
                      >
                        {overview.tokens.map((token) => (
                          <option key={token.id} value={token.id}>
                            {tokenName(token)}
                          </option>
                        ))}
                        {(overview.appAuth || repo.auth === "app") && <option value={APP}>GitHub App</option>}
                      </select>
                      {repo.tokenRefused && <div className="repo-problem">refused: replace the token below</div>}
                    </td>
                    <td>{fmt(repo.pulls.length)}</td>
                    <td className={failing ? "bad-text" : "muted"}>{fmt(failing)}</td>
                    <td className="muted" title={repo.syncedAt}>
                      {repo.syncing ? "syncing…" : repo.syncedAt ? timeAgo(repo.syncedAt) : repo.error ? "never" : "pending"}
                    </td>
                    <td className="auto">
                      <input
                        type="checkbox"
                        checked={repo.autoReview}
                        disabled={busy !== null || !overview.review.available}
                        aria-label={`Auto-review ${repo.fullName}`}
                        title={overview.review.available ? undefined : "Reviews are unavailable on this gateway"}
                        onChange={(e) => void run(`auto:${repo.id}`, () => api(`${base}/repos/${repo.id}`, apiKey, { method: "PUT", body: { autoReview: e.target.checked } }))}
                      />
                    </td>
                    <td className="auto">
                      <input
                        type="checkbox"
                        checked={repo.autoPost}
                        disabled={busy !== null}
                        aria-label={`Auto-post reviews of ${repo.fullName}`}
                        onChange={(e) => void run(`post:${repo.id}`, () => api(`${base}/repos/${repo.id}`, apiKey, { method: "PUT", body: { autoPost: e.target.checked } }))}
                      />
                    </td>
                    <td className="auto">
                      <input
                        type="checkbox"
                        checked={repo.autoTriage}
                        disabled={busy !== null || !repo.issuesSupported || !overview.review.available}
                        aria-label={`Auto-triage ${repo.fullName}`}
                        title={repo.issuesSupported ? undefined : "This host has no issue tracker the plugin reads"}
                        onChange={(e) => void run(`triage:${repo.id}`, () => api(`${base}/repos/${repo.id}`, apiKey, { method: "PUT", body: { autoTriage: e.target.checked } }))}
                      />
                    </td>
                    <td className="actions">
                      <button type="button" className="ghost mini" disabled={busy !== null} onClick={() => void run(`sync:${repo.id}`, () => api(`${base}/repos/${repo.id}/sync`, apiKey, { method: "POST" }))}>
                        {busy === `sync:${repo.id}` ? "…" : "sync"}
                      </button>{" "}
                      {confirm === repo.id ? (
                        <>
                          <button type="button" className="danger mini" disabled={busy !== null} onClick={() => void run(`remove:${repo.id}`, () => api(`${base}/repos/${repo.id}`, apiKey, { method: "DELETE" }).then(() => setConfirm(null)))}>
                            remove
                          </button>{" "}
                          <button type="button" className="ghost mini" onClick={() => setConfirm(null)}>
                            keep
                          </button>
                        </>
                      ) : (
                        <button type="button" className="ghost mini" disabled={busy !== null} onClick={() => setConfirm(repo.id)}>
                          remove
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <form className="newkey create" onSubmit={add}>
        <input placeholder={words.fullNameHint} value={fullName} onChange={(e) => setFullName(e.target.value)} aria-label={`${words.repoNoun} name`} disabled={busy !== null} spellCheck={false} />
        {(overview.tokens.length > 0 || overview.appAuth) && (
          <select value={readsWith} onChange={(e) => setReadsWith(e.target.value)} aria-label="Reads with" disabled={busy !== null}>
            {overview.tokens.map((saved) => (
              <option key={saved.id} value={saved.id}>
                {tokenName(saved)}
                {saved.repos ? ` · ${countOf(saved.repos, words)}` : ""}
              </option>
            ))}
            {overview.appAuth && <option value={APP}>GitHub App</option>}
            <option value={NEW_TOKEN}>paste a new token…</option>
          </select>
        )}
        {readsWith === NEW_TOKEN && (
          <input type="password" placeholder="access token" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Access token" disabled={busy !== null} autoComplete="off" />
        )}
        <button type="submit" className="primary" disabled={busy !== null || !fullName.trim() || (readsWith === NEW_TOKEN && !token.trim())}>
          {busy === "add" ? "…" : `watch ${words.repoNoun}`}
        </button>
        {host === "github" && overview.appAuth && (
          <button type="button" className="ghost" disabled={busy !== null} onClick={() => void loadPicker()}>
            {busy === "picker" ? "…" : "pick from the App"}
          </button>
        )}
        {readsWith === NEW_TOKEN && <span className="muted">{words.tokenHint} Saved once, it is offered for the next {words.repoNoun} too.</span>}
      </form>
      {picker && (
        <div className="picker">
          {picker.length === 0 ? (
            <div className="empty">The App sees no other repositories. Install it on more at GitHub.</div>
          ) : (
            picker.map((entry) => (
              <div key={entry.fullName} className="picker-row">
                <span className="entity-name">{entry.fullName}</span>
                <span className="muted">{entry.account}</span>
                <button type="button" className="mini" disabled={busy !== null} onClick={() => void addFromApp(entry.fullName)}>
                  {busy === `add:${entry.fullName}` ? "…" : "watch"}
                </button>
              </div>
            ))
          )}
          <button type="button" className="ghost mini" onClick={() => setPicker(null)}>
            close
          </button>
        </div>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Tokens: saved once, shared by any number of repositories                  */
/* -------------------------------------------------------------------------- */

interface TokenPickerState {
  tokenId: string
  repositories: Array<{ fullName: string; watched: boolean }>
  chosen: string[]
  /** Per name: what went wrong adding it. */
  failed: Record<string, string>
  filter: string
}

const TokensPanel = ({ host, words, overview, base, apiKey, onChanged }: ReposPanelProps) => {
  const [label, setLabel] = useState("")
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  /** The token whose value is being replaced, or relabelled. */
  const [replacing, setReplacing] = useState<{ id: string; value: string } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [picker, setPicker] = useState<TokenPickerState | null>(null)

  const run = async (what: string, action: () => Promise<string | void>) => {
    setBusy(what)
    setError(undefined)
    setNotice(undefined)
    try {
      const said = await action()
      if (said) setNotice(said)
      await onChanged()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(null)
    }
  }

  const openPicker = (tokenId: string) =>
    run(`pick:${tokenId}`, async () => {
      const answer = await api<{ repositories: Array<{ fullName: string; watched: boolean }> }>(`${base}/tokens/${tokenId}/repos`, apiKey)
      setPicker({ tokenId, repositories: answer.repositories, chosen: [], failed: {}, filter: "" })
    })

  const save = (e: FormEvent) => {
    e.preventDefault()
    if (!token.trim()) return
    void run("save", async () => {
      const answer = await api<{ token: TokenView; existed: boolean }>(`${base}/tokens`, apiKey, { method: "POST", body: { token: token.trim(), ...(label.trim() ? { label: label.trim() } : {}) } })
      setToken("")
      setLabel("")
      if (overview.canListRepos) {
        const listed = await api<{ repositories: Array<{ fullName: string; watched: boolean }> }>(`${base}/tokens/${answer.token.id}/repos`, apiKey)
        setPicker({ tokenId: answer.token.id, repositories: listed.repositories, chosen: [], failed: {}, filter: "" })
      }
      return answer.existed ? `That token was already saved as ${tokenName(answer.token)}.` : `Saved${answer.token.login ? `: it is ${answer.token.login}` : ""}.`
    })
  }

  const replace = (id: string, value: string) =>
    run(`replace:${id}`, async () => {
      const answer = await api<{ token: TokenView }>(`${base}/tokens/${id}`, apiKey, { method: "PUT", body: { token: value.trim() } })
      setReplacing(null)
      return `Replaced${answer.token.login ? `; it is ${answer.token.login}` : ""}. ${answer.token.repos ? `${countOf(answer.token.repos, words)} sync with it now.` : ""}`
    })

  const watchChosen = (state: TokenPickerState) =>
    run("watch", async () => {
      const failed: Record<string, string> = {}
      let added = 0
      for (const fullName of state.chosen) {
        try {
          await api(`${base}/repos`, apiKey, { method: "POST", body: { fullName, tokenId: state.tokenId } })
          added++
        } catch (e) {
          failed[fullName] = messageOf(e)
        }
      }
      const watched = new Set(state.chosen.filter((name) => !failed[name]))
      setPicker({
        ...state,
        repositories: state.repositories.map((entry) => (watched.has(entry.fullName) ? { ...entry, watched: true } : entry)),
        chosen: Object.keys(failed),
        failed
      })
      return `Watching ${countOf(added, words)} more${Object.keys(failed).length ? `; ${fmt(Object.keys(failed).length)} could not be added` : ""}.`
    })

  const pickerToken = picker && overview.tokens.find((entry) => entry.id === picker.tokenId)
  const shown = picker ? picker.repositories.filter((entry) => !picker.filter || entry.fullName.toLowerCase().includes(picker.filter.toLowerCase())) : []
  const choosable = shown.filter((entry) => !entry.watched).map((entry) => entry.fullName)

  return (
    <section className="panel">
      <div className="section-heading">
        <h2>
          Tokens
          <span className="count">{fmt(overview.tokens.length)}</span>
        </h2>
      </div>
      {error && <div className="error">{error}</div>}
      {notice && <div className="success-bar">{notice}</div>}
      {overview.tokens.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>token</th>
                <th>is</th>
                <th>{words.repoNoun === "project" ? "projects" : "repositories"}</th>
                <th>saved</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {overview.tokens.map((saved) => (
                <tr key={saved.id} className={saved.refused ? "repo-error" : ""}>
                  <td>
                    {renaming?.id === saved.id ? (
                      <form
                        className="inline-edit"
                        onSubmit={(e) => {
                          e.preventDefault()
                          void run(`label:${saved.id}`, () => api(`${base}/tokens/${saved.id}`, apiKey, { method: "PUT", body: { label: renaming.value.trim() } }).then(() => setRenaming(null)))
                        }}
                      >
                        <input value={renaming.value} onChange={(e) => setRenaming({ id: saved.id, value: e.target.value })} aria-label="Label" placeholder="label" autoFocus disabled={busy !== null} />
                        <button type="submit" className="mini" disabled={busy !== null}>save</button>{" "}
                        <button type="button" className="ghost mini" onClick={() => setRenaming(null)}>cancel</button>
                      </form>
                    ) : (
                      <>
                        <span className="entity-name">{tokenName(saved)}</span>
                        {saved.kind && <span className="tag">{saved.kind}</span>}
                      </>
                    )}
                    {saved.refused > 0 && (
                      <div className="repo-problem">
                        {HOST_NAMES[host]} refused it for {countOf(saved.refused, words)}: expired or revoked
                      </div>
                    )}
                  </td>
                  <td className="muted">{saved.login ?? "—"}</td>
                  <td>{fmt(saved.repos)}</td>
                  <td className="muted" title={saved.replacedAt ?? saved.addedAt}>
                    {saved.replacedAt ? `replaced ${timeAgo(saved.replacedAt)}` : `${timeAgo(saved.addedAt)} by ${saved.addedBy}`}
                  </td>
                  <td className="actions">
                    {replacing?.id === saved.id ? (
                      <form
                        className="inline-edit"
                        onSubmit={(e) => {
                          e.preventDefault()
                          if (replacing.value.trim()) void replace(saved.id, replacing.value)
                        }}
                      >
                        <input type="password" value={replacing.value} onChange={(e) => setReplacing({ id: saved.id, value: e.target.value })} aria-label="New token" placeholder="new token" autoFocus autoComplete="off" disabled={busy !== null} />
                        <button type="submit" className="primary mini" disabled={busy !== null || !replacing.value.trim()}>
                          {busy === `replace:${saved.id}` ? "…" : saved.repos ? `replace for ${countOf(saved.repos, words)}` : "replace"}
                        </button>{" "}
                        <button type="button" className="ghost mini" onClick={() => setReplacing(null)}>cancel</button>
                      </form>
                    ) : confirm === saved.id ? (
                      <>
                        <button type="button" className="danger mini" disabled={busy !== null} onClick={() => void run(`remove:${saved.id}`, () => api(`${base}/tokens/${saved.id}`, apiKey, { method: "DELETE" }).then(() => setConfirm(null)))}>
                          remove
                        </button>{" "}
                        <button type="button" className="ghost mini" onClick={() => setConfirm(null)}>keep</button>
                      </>
                    ) : (
                      <>
                        <button type="button" className={saved.refused ? "primary mini" : "ghost mini"} disabled={busy !== null} onClick={() => setReplacing({ id: saved.id, value: "" })}>
                          replace
                        </button>{" "}
                        <button type="button" className="ghost mini" disabled={busy !== null} onClick={() => setRenaming({ id: saved.id, value: saved.label ?? "" })}>
                          label
                        </button>{" "}
                        {overview.canListRepos && (
                          <>
                            <button type="button" className="ghost mini" disabled={busy !== null} onClick={() => void openPicker(saved.id)}>
                              {busy === `pick:${saved.id}` ? "…" : `add ${words.repoNoun === "project" ? "projects" : "repositories"}`}
                            </button>{" "}
                          </>
                        )}
                        <button
                          type="button"
                          className="ghost mini"
                          disabled={busy !== null || saved.repos > 0}
                          title={saved.repos > 0 ? `Move or remove its ${words.repoNoun === "project" ? "projects" : "repositories"} first` : undefined}
                          onClick={() => setConfirm(saved.id)}
                        >
                          remove
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {picker && (
        <div className="picker">
          <div className="picker-row">
            <span className="entity-name">
              {pickerToken ? tokenName(pickerToken) : "This token"} reads {countOf(picker.repositories.length, words)}
              {picker.repositories.length >= 300 ? " (the 300 most recently updated)" : ""}
            </span>
            {picker.repositories.length > 8 && (
              <input value={picker.filter} onChange={(e) => setPicker({ ...picker, filter: e.target.value })} placeholder="filter" aria-label="Filter" spellCheck={false} />
            )}
            <button
              type="button"
              className="ghost mini"
              disabled={busy !== null || choosable.length === 0}
              onClick={() => setPicker({ ...picker, chosen: choosable.every((name) => picker.chosen.includes(name)) ? picker.chosen.filter((name) => !choosable.includes(name)) : [...new Set([...picker.chosen, ...choosable])] })}
            >
              {choosable.length && choosable.every((name) => picker.chosen.includes(name)) ? "choose none" : `choose all ${fmt(choosable.length)}`}
            </button>
            <button type="button" className="primary mini" disabled={busy !== null || picker.chosen.length === 0} onClick={() => void watchChosen(picker)}>
              {busy === "watch" ? "…" : `watch ${fmt(picker.chosen.length)}`}
            </button>
            <button type="button" className="ghost mini" onClick={() => setPicker(null)}>
              close
            </button>
          </div>
          {picker.repositories.length === 0 ? (
            <div className="empty">The token reads no {words.repoNoun === "project" ? "projects" : "repositories"}.</div>
          ) : (
            <div className="picker-list">
              {shown.map((entry) => (
                <label key={entry.fullName} className="picker-row">
                  <input
                    type="checkbox"
                    checked={entry.watched || picker.chosen.includes(entry.fullName)}
                    disabled={entry.watched || busy !== null}
                    onChange={(e) => setPicker({ ...picker, chosen: e.target.checked ? [...picker.chosen, entry.fullName] : picker.chosen.filter((name) => name !== entry.fullName) })}
                  />
                  <span className="entity-name">{entry.fullName}</span>
                  {entry.watched && <span className="muted">watched</span>}
                  {picker.failed[entry.fullName] && <span className="repo-problem">{picker.failed[entry.fullName]}</span>}
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      <form className="newkey create" onSubmit={save}>
        <input placeholder="label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Label" disabled={busy !== null} />
        <input type="password" placeholder="access token" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Access token" disabled={busy !== null} autoComplete="off" />
        <button type="submit" className="primary" disabled={busy !== null || !token.trim()}>
          {busy === "save" ? "…" : "save token"}
        </button>
        <span className="muted">{words.tokenHint}</span>
      </form>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Host settings: GitHub App, self-hosted URL                                */
/* -------------------------------------------------------------------------- */

interface HostPanelProps {
  host: PullsHost
  words: HostWords
  overview: Overview
  base: string
  apiKey: string
  onChanged: () => Promise<void>
}

const HostPanel = ({ host, words, overview, base, apiKey, onChanged }: HostPanelProps) => {
  const [appId, setAppId] = useState("")
  const [privateKey, setPrivateKey] = useState("")
  const [baseUrl, setBaseUrl] = useState(overview.host.baseUrl)
  const [me, setMe] = useState(overview.me.name ?? "")
  useEffect(() => setMe(overview.me.name ?? ""), [overview.me.name])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [confirming, setConfirming] = useState(false)
  useEffect(() => setBaseUrl(overview.host.baseUrl), [overview.host.baseUrl])

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      await action()
      await onChanged()
      setNotice(done)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  const app = overview.host.app ?? null
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>{host === "github" ? "GitHub App" : "Instance"}</h2>
        {host === "github" && <span className={`pill-s ${app ? "ok" : ""}`}>{app ? `installed as ${app.slug ?? app.appId}` : "not set up"}</span>}
      </div>
      {notice && <div className="success-bar">{notice}</div>}
      {error && <div className="error">{error}</div>}

      {host === "github" &&
        (app ? (
          <>
            <dl className="facts">
              <dt>App</dt>
              <dd>
                {app.name ?? app.slug ?? "GitHub App"} <span className="muted">· id {app.appId}</span>
              </dd>
              {app.installUrl && (
                <>
                  <dt>Install on more</dt>
                  <dd>
                    <a href={app.installUrl} target="_blank" rel="noreferrer">
                      {app.installUrl}
                    </a>
                  </dd>
                </>
              )}
            </dl>
            {confirming ? (
              <div className="row-actions">
                <span className="muted">Repositories that read through the App stop syncing until it is set up again.</span>
                <button type="button" className="danger" disabled={busy} onClick={() => void run(() => api(`${base}/app`, apiKey, { method: "DELETE" }).then(() => setConfirming(false)), "GitHub App removed.")}>
                  remove App
                </button>
                <button type="button" className="ghost" onClick={() => setConfirming(false)}>
                  keep
                </button>
              </div>
            ) : (
              <button type="button" className="ghost" disabled={busy} onClick={() => setConfirming(true)}>
                remove
              </button>
            )}
          </>
        ) : (
          <form
            className="app-form"
            onSubmit={(e) => {
              e.preventDefault()
              void run(() => api(`${base}/app`, apiKey, { method: "PUT", body: { appId: appId.trim(), privateKey } }).then(() => (setAppId(""), setPrivateKey(""))), "GitHub App checked and saved. Repositories it is installed on can be watched without a token.")
            }}
          >
            <input placeholder="App ID" value={appId} onChange={(e) => setAppId(e.target.value)} aria-label="App ID" disabled={busy} inputMode="numeric" />
            <textarea placeholder="-----BEGIN RSA PRIVATE KEY-----" value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} aria-label="Private key" disabled={busy} rows={4} spellCheck={false} />
            <div className="row-actions">
              <button type="submit" className="primary" disabled={busy || !appId.trim() || !privateKey.trim()}>
                {busy ? "…" : "set up App"}
              </button>
              <span className="muted">
                Create the App under your organisation&apos;s developer settings with read access to Pull requests, Contents, Checks and Commit statuses, install it on the repositories, then paste its App ID and a generated private key. The key stays on this server.
              </span>
            </div>
          </form>
        ))}

      <form
        className="newkey inline-setting"
        onSubmit={(e) => {
          e.preventDefault()
          void run(() => api(`${base}/settings`, apiKey, { method: "PUT", body: { baseUrl: baseUrl.trim() } }), "Host saved; everything is syncing again.")
        }}
      >
        <label>
          <span className="muted">{host === "github" ? "GitHub Enterprise URL" : `${HOST_NAMES[host]} URL`}</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} aria-label="Host URL" disabled={busy} spellCheck={false} />
        </label>
        <button type="submit" className="ghost" disabled={busy || baseUrl.trim() === overview.host.baseUrl}>
          save host
        </button>
      </form>

      <form
        className="newkey inline-setting"
        onSubmit={(e) => {
          e.preventDefault()
          void run(() => api(`${base}/settings`, apiKey, { method: "PUT", body: { me: me.trim() } }), me.trim() ? `Pulls you have not approved are marked; you are ${me.trim().replace(/^@/, "")}.` : "Username cleared.")
        }}
      >
        <label>
          <span className="muted">
            you on {HOST_NAMES[host]}
            {overview.me.detected && <em> · the token belongs to {overview.me.detected}</em>}
          </span>
          <input value={me} onChange={(e) => setMe(e.target.value)} aria-label={`Your username on ${HOST_NAMES[host]}`} placeholder={overview.me.detected ?? "username"} disabled={busy} spellCheck={false} />
        </label>
        <button type="submit" className="ghost" disabled={busy || me.trim().replace(/^@/, "") === (overview.me.name ?? "")}>
          save
        </button>
        <span className="muted">Marks the {words.nouns} waiting for your approval. Left blank, the name the token reports is used.</span>
      </form>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  A developer's own name on the host                                        */
/* -------------------------------------------------------------------------- */

interface MePanelProps extends HostPanelProps {
  /** No name yet: the panel asks at the top of the page instead of waiting at the bottom. */
  asking?: boolean
  /** Said once a name is saved, where the panel was, since the panel itself then moves. */
  onSaved: (message: string) => void
}

/** For a developer the plugin is shared with: who they are on the host, for their eyes only. */
const MePanel = ({ host, words, overview, base, apiKey, onChanged, asking = false, onSaved }: MePanelProps) => {
  const [me, setMe] = useState(overview.me.name ?? "")
  useEffect(() => setMe(overview.me.name ?? ""), [overview.me.name])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const name = me.trim().replace(/^@/, "")
  const view = `\u201c${QUICK_LABEL.mine}\u201d`
  const save = async (value = name, from?: string) => {
    setBusy(true)
    setError(undefined)
    try {
      await api(`${base}/me`, apiKey, { method: "PUT", body: { me: value } })
      onSaved(
        value
          ? `You are ${value} on ${HOST_NAMES[host]}${from ? `, ${from}` : ""}. The ${words.nouns} waiting for your approval are under ${view}, and marked in the list.${from ? " Not you? Change it under You on " + HOST_NAMES[host] + " at the bottom of the page." : ""}`
          : `Username cleared: ${view} is hidden until you set one.`
      )
      await onChanged()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  // Opened from VS Code signed in to GitHub: no name yet, so use that one, once.
  // Never on an Enterprise server, where a github.com login would be someone else's.
  const hint = hostNameHint(host)
  useEffect(() => {
    if (!hint || overview.me.name) return
    forgetHostName(host)
    if (host === "github" && !isGitHubDotCom(overview.host.baseUrl)) return
    void save(hint, "taken from your GitHub sign-in in VS Code")
    // Once per page load, on the first overview that has no name.
  }, [hint, overview.me.name])

  return (
    <section className={`panel ${asking ? "ask-me" : ""}`} id="you-on-host">
      <div className="section-heading">
        <h2>{asking ? `Who are you on ${HOST_NAMES[host]}?` : `You on ${HOST_NAMES[host]}`}</h2>
      </div>
      {asking && (
        <p className="ask-me-lead">
          Your username gives the {words.nouns} waiting for your approval a view of their own, {view}, and marks them in the list. Only you see it; nothing is posted.
        </p>
      )}
      {error && <div className="error">{error}</div>}
      <form
        className="newkey inline-setting"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label>
          <span className="muted">username</span>
          <input id="you-on-host-name" value={me} onChange={(e) => setMe(e.target.value)} aria-label={`Your username on ${HOST_NAMES[host]}`} placeholder={`your ${HOST_NAMES[host]} username`} disabled={busy} spellCheck={false} autoFocus={asking} />
        </label>
        <button type="submit" className={asking ? "primary" : "ghost"} disabled={busy || !name || name === (overview.me.name ?? "")}>
          {busy ? "…" : "save"}
        </button>
        {!asking && <span className="muted">Marks the {words.nouns} waiting for your approval, on your page only. Repositories and settings are the admin&apos;s.</span>}
      </form>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  One pull                                                                  */
/* -------------------------------------------------------------------------- */

const languageOf = (path: string): string => {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  return ext === path.toLowerCase() ? "text" : ext
}

interface PullViewProps {
  detail: PullPage
  words: HostWords
  host: PullsHost
  review: ReviewSetup
  me?: string
  onBack: () => void
  onReview: () => Promise<void>
  onPost: (as: "comment" | "request-changes" | "approve") => Promise<void>
  onApprove: () => Promise<void>
  /** A developer the plugin is shared with: posts a comment, once, and never approves as the token. */
  member?: boolean
  onAsk: (question: string) => Promise<void>
}

/** Questions about a review and the model's answers, with a box for the next one. */
const ReviewThread = ({ review, noun, canAsk, onAsk }: { review: ReviewRecord; noun: string; canAsk: boolean; onAsk: (question: string) => Promise<void> }) => {
  const [question, setQuestion] = useState("")
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!asking) return
    setElapsed(0)
    const started = Date.now()
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [asking])
  const send = async () => {
    const asked = question.trim()
    if (!asked || asking || !canAsk) return
    setAsking(true)
    setError(undefined)
    try {
      await onAsk(asked)
      setQuestion("")
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setAsking(false)
    }
  }
  const thread = review.thread ?? []
  return (
    <div className="review-thread">
      {thread.length > 0 && (
        <div className="turns">
          {thread.map((turn, index) => (
            <div key={`${turn.at}:${index}`} className={`turn ${turn.role}`}>
              <div className="turn-head">
                <span className="role">{turn.role === "user" ? `asked by ${turn.by ?? "you"}` : `${review.alias}${turn.ms ? ` in ${Math.round(turn.ms / 1000)} s` : ""}`}</span>
                <span className="muted">{timeAgo(turn.at)}</span>
              </div>
              <div className="turn-body">
                {turn.role === "user" ? <p className="question">{turn.text}</p> : <MarkdownView text={turn.text} />}
                {turn.cutShort && <div className="cut-short">{turn.cutShort}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
      <form
        className="ask-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void send()
            }
          }}
          rows={2}
          maxLength={4000}
          placeholder={canAsk ? `Ask ${review.alias} about this review…` : "No model is serving reviews"}
          aria-label="Ask about this review"
          disabled={asking || !canAsk}
        />
        <div className="review-actions">
          <button type="submit" className="primary" disabled={asking || !canAsk || !question.trim()}>
            {asking ? `answering… ${elapsed} s` : "ask"}
          </button>
          {error ? <span className="bad-text">{error}</span> : <span className="muted">Ctrl+Enter sends. The model sees the {noun.toLowerCase()}, the review and this thread; nothing here is posted.</span>}
        </div>
      </form>
    </div>
  )
}

const PullView = ({ detail, words, review, host, me, onBack, onReview, onPost, onApprove, onAsk, member = false }: PullViewProps) => {
  const [approving, setApproving] = useState(false)
  const [approveError, setApproveError] = useState<string | undefined>()
  const [postAs, setPostAs] = useState<"comment" | "request-changes" | "approve">("comment")
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | undefined>()
  const { pull } = detail
  const [reviewing, setReviewing] = useState(detail.reviewing)
  const [reviewError, setReviewError] = useState<string | undefined>()
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => setReviewing(detail.reviewing), [detail.reviewing])
  useEffect(() => {
    if (!reviewing) return
    setElapsed(0)
    const started = Date.now()
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [reviewing])
  const askReview = async () => {
    setReviewing(true)
    setReviewError(undefined)
    try {
      await onReview()
    } catch (e) {
      setReviewError(messageOf(e))
    } finally {
      setReviewing(false)
    }
  }
  const stale = detail.review && detail.review.headSha !== pull.headSha
  const stance = myStance(pull, me)
  const approve = () => {
    setApproving(true)
    setApproveError(undefined)
    void onApprove()
      .catch((e: unknown) => setApproveError(messageOf(e)))
      .finally(() => setApproving(false))
  }
  return (
    <section className="panel record">
      <div className="section-heading">
        <h2 className="record-title">
          <button type="button" className="ghost mini" onClick={onBack}>
            ← {words.nouns}
          </button>
          <b>
            {pull.repo}
            {words.hash}
            {pull.number}
          </b>
          <a href={pull.url} target="_blank" rel="noreferrer">
            open on {HOST_NAMES[host]}
          </a>
        </h2>
        <span className="links">
          <Pill tone={CHECK_TONE[pull.checks]}>{CHECK_LABEL[pull.checks]}</Pill>
          <Pill tone={MERGE_TONE[pull.mergeable]}>{MERGE_LABEL[pull.mergeable]}</Pill>
          <Pill tone={REVIEW_TONE[pull.review]}>{REVIEW_LABEL[pull.review]}</Pill>
          {!member && stance !== "yours" && stance !== "approved" && (
            <button type="button" className="primary mini" disabled={approving} onClick={approve} title={`Approve on ${HOST_NAMES[host]} as the repository's token`}>
              {approving ? "approving…" : "approve"}
            </button>
          )}
        </span>
      </div>
      {approveError && <div className="error">{approveError}</div>}
      <h3 className="pull-title">
        {pull.draft && <span className="tag">draft</span>} {pull.title} <MyReviewTag pull={pull} me={me} />
      </h3>
      <div className="meta">
        <span>
          <span className="meta-k">by</span>
          {pull.author}
        </span>
        <span>
          <span className="meta-k">branch</span>
          <code>{pull.headRef}</code> → <code>{pull.baseRef}</code>
        </span>
        <span>
          <span className="meta-k">updated</span>
          {timeAgo(pull.updatedAt)}
        </span>
        {pull.approvals && (
          <span>
            <span className="meta-k">approvals</span>
            <Approvals pull={pull} long />
          </span>
        )}
        {pull.changedFiles !== undefined && (
          <span>
            <span className="meta-k">changes</span>
            {plural(pull.changedFiles, "file")}, <span className="ins-text">+{fmt(pull.additions ?? 0)}</span> <span className="del-text">−{fmt(pull.deletions ?? 0)}</span>
          </span>
        )}
        {pull.labels.length > 0 && (
          <span>
            <span className="meta-k">labels</span>
            {pull.labels.map((label) => (
              <span key={label} className="tag">
                {label}
              </span>
            ))}
          </span>
        )}
      </div>

      {pull.checkRuns.length > 0 && (
        <div className="checks">
          {pull.checkRuns.map((check, i) => (
            <span key={`${check.name}-${i}`} className={`pill-s ${CHECK_TONE[check.state]}`}>
              {check.url ? (
                <a href={check.url} target="_blank" rel="noreferrer">
                  {check.name}
                </a>
              ) : (
                check.name
              )}
            </span>
          ))}
        </div>
      )}

      <h3 className="sub">Review</h3>
      {reviewing ? (
        <div className="review-running" aria-live="polite">
          <span className="meter">
            <span className="meter-fill indeterminate" style={{ width: "40%" }} />
          </span>
          <span>
            Reviewing with <b>{review.alias}</b>
            <span className="muted"> · {elapsed}s · the model is reading the {words.noun}; a minute or two is normal</span>
          </span>
        </div>
      ) : (
        <div className="review-actions">
          <button type="button" className={detail.review ? "ghost" : "primary"} disabled={!review.available || !review.alias} onClick={() => void askReview()} title={!review.available ? "This gateway offers plugins no models" : !review.alias ? "No chat model is served" : undefined}>
            {detail.review ? "review again" : "review now"}
          </button>
          {review.alias && <span className="muted">with {review.alias}</span>}
          {reviewError && <span className="bad-text">{reviewError}</span>}
        </div>
      )}
      {detail.review ? (
        <>
          <div className="review-meta">
            <span>
              <span className="meta-k">by</span>
              {detail.review.alias}
            </span>
            <span>
              <span className="meta-k">when</span>
              {timeAgo(detail.review.createdAt)}, in {Math.round(detail.review.ms / 1000)} s
            </span>
            <span>
              <span className="meta-k">asked by</span>
              {detail.review.requestedBy}
            </span>
            {stale && <span className="tag stale">for an earlier commit {detail.review.headSha.slice(0, 7)}</span>}
            {detail.review.status === "failed" && <span className="tag failed">failed</span>}
            {detail.review.cutShort && <span className="tag cut">cut short</span>}
            {detail.review.postedAt && (
              <span className="tag reviewed">
                posted as {detail.review.postedAs?.replace("-", " ")} {timeAgo(detail.review.postedAt)}
                {detail.review.postedUrl && (
                  <>
                    {" · "}
                    <a href={detail.review.postedUrl} target="_blank" rel="noreferrer">
                      view
                    </a>
                  </>
                )}
              </span>
            )}
          </div>
          {detail.review.status === "done" && !(member && detail.review.postedAt) && (
            <div className="review-actions">
              {member ? (
                <span className="muted">as a comment</span>
              ) : (
                <select value={postAs} onChange={(e) => setPostAs(e.target.value as typeof postAs)} disabled={posting} aria-label="Post as">
                  <option value="comment">as a comment</option>
                  <option value="request-changes">requesting changes</option>
                  <option value="approve">approving</option>
                </select>
              )}
              <button
                type="button"
                className={detail.review.postedAt ? "ghost" : "primary"}
                disabled={posting}
                onClick={() => {
                  setPosting(true)
                  setPostError(undefined)
                  void onPost(postAs)
                    .catch((e: unknown) => setPostError(messageOf(e)))
                    .finally(() => setPosting(false))
                }}
              >
                {posting ? "posting…" : detail.review.postedAt ? `post again to ${HOST_NAMES[host]}` : `post to ${HOST_NAMES[host]}`}
              </button>
              {postError && <span className="bad-text">{postError}</span>}
            </div>
          )}
          {detail.review.cutShort && <div className="cut-short">{detail.review.cutShort}</div>}
          {detail.review.status === "failed" ? <div className="error">{detail.review.error}</div> : <MarkdownView text={detail.review.text} className="review-body" />}
          {detail.review.status === "done" && !reviewing && <ReviewThread review={detail.review} noun={words.noun} canAsk={review.available && !!review.alias} onAsk={onAsk} />}
        </>
      ) : (
        !reviewing && <div className="empty">Not reviewed yet.</div>
      )}

      <h3 className="sub">Description</h3>
      {detail.body.trim() ? <MarkdownView text={detail.body} className="pull-body" /> : <div className="empty">No description.</div>}

      <h3 className="sub">
        Files <span className="count">{fmt(detail.files.length)}</span>
      </h3>
      <div className="turns">
        {detail.files.map((file) => (
          <DiffBlock
            key={`${file.status}:${file.path}`}
            patch={file.patch ?? ""}
            language={languageOf(file.path)}
            title={
              <>
                <span className={`tag file-${file.status}`}>{file.status}</span> {file.previousPath ? `${file.previousPath} → ` : ""}
                {file.path} <span className="ins-text">+{fmt(file.additions)}</span> <span className="del-text">−{fmt(file.deletions)}</span>
                {file.truncated && <span className="muted"> · cut at 60k characters</span>}
              </>
            }
          />
        ))}
        {detail.moreFiles > 0 && <div className="empty">{plural(detail.moreFiles, "more file")} not shown.</div>}
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Reviews: which model, and whether it can run                              */
/* -------------------------------------------------------------------------- */

const ReviewsPanel = ({ words, overview, base, apiKey, onChanged }: { words: HostWords; overview: Overview; base: string; apiKey: string; onChanged: () => Promise<void> }) => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const { review } = overview
  const auto = overview.repos.filter((repo) => repo.autoReview).length
  const choose = async (alias: string) => {
    setBusy(true)
    setError(undefined)
    try {
      await api(`${base}/settings`, apiKey, { method: "PUT", body: { reviewAlias: alias } })
      await onChanged()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>Reviews</h2>
        <span className={`pill-s ${!review.available || !review.alias ? "bad" : review.busy ? "warn" : "ok"}`}>
          {!review.available ? "unavailable" : !review.alias ? "no chat model" : review.busy ? "reviewing" : "ready"}
        </span>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="newkey">
        <label>
          <span className="muted">review model</span>
          <select value={review.alias ?? ""} onChange={(e) => void choose(e.target.value)} disabled={busy || review.aliases.length === 0} aria-label="Review model">
            {review.aliases.length === 0 && <option value="">no chat alias is served</option>}
            {review.aliases.map((alias) => (
              <option key={alias} value={alias}>
                {alias}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">
          {auto === 0 ? `No ${words.repoNoun} auto-reviews.` : `${fmt(auto)} ${auto === 1 ? words.repoNoun : `${words.repoNoun}s`} auto-review: one ${words.noun} at a time, only while no developer request is running.`} Reviews stay on this server.
        </span>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Issues and triage                                                         */
/* -------------------------------------------------------------------------- */

const PRIORITY_TONE: Record<string, string> = { high: "bad", medium: "warn", low: "" }
const PRIORITY_RANK: Record<TriagePriority, number> = { high: 0, medium: 1, low: 2 }

type IssueView = "all" | "untriaged" | "high" | "duplicates" | "unanswered" | "failed"

const ISSUE_VIEW_LABEL: Record<IssueView, string> = {
  all: "all",
  untriaged: "not triaged",
  high: "high priority",
  duplicates: "duplicates",
  unanswered: "reply pending",
  failed: "triage failed"
}
const ISSUE_VIEW_TITLE: Partial<Record<IssueView, string>> = {
  unanswered: "Triaged with a suggested reply that nobody has posted yet"
}
const ISSUE_VIEWS = Object.keys(ISSUE_VIEW_LABEL) as IssueView[]

const issueMatches = (brief: TriageBrief | undefined, view: IssueView): boolean => {
  switch (view) {
    case "all":
      return true
    case "untriaged":
      return !brief
    case "high":
      return brief?.priority === "high"
    case "duplicates":
      return brief?.duplicateOf !== undefined
    case "unanswered":
      return brief?.status === "done" && !brief.replied
    case "failed":
      return brief?.status === "failed"
  }
}

type IssueSortKey = "updated" | "created" | "number" | "title" | "author" | "comments" | "priority"

const ISSUE_SORTS: Array<{ key: IssueSortKey; label: string; natural: "asc" | "desc" }> = [
  { key: "updated", label: "last updated", natural: "desc" },
  { key: "created", label: "opened", natural: "desc" },
  { key: "number", label: "number", natural: "desc" },
  { key: "title", label: "title", natural: "asc" },
  { key: "author", label: "author", natural: "asc" },
  { key: "comments", label: "comments", natural: "desc" },
  { key: "priority", label: "priority", natural: "asc" }
]

interface IssueFilters {
  view: IssueView
  repo: string
  author: string
  label: string
  age: Age
  sort: Sort<IssueSortKey>
}

const DEFAULT_ISSUE_FILTERS: IssueFilters = { view: "all", repo: "", author: "", label: "", age: "", sort: { key: "updated", dir: "desc" } }

const isIssueFilters = (value: unknown): value is IssueFilters => {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  const sort = v.sort as Record<string, unknown> | undefined
  return (
    ISSUE_VIEWS.includes(v.view as IssueView) &&
    ["repo", "author", "label", "age"].every((field) => typeof v[field] === "string") &&
    sort !== undefined &&
    ISSUE_SORTS.some((entry) => entry.key === sort.key) &&
    (sort.dir === "asc" || sort.dir === "desc")
  )
}

const IssuesPanel = ({ host, overview, base, apiKey, review, onChanged }: { host: PullsHost; overview: Overview; base: string; apiKey: string; review: ReviewSetup; onChanged: () => Promise<void> }) => {
  const [open, setOpen] = useState<{ repoId: string; number: number } | null>(null)
  const [detail, setDetail] = useState<{ body: string; triage: TriageRecord | null } | null>(null)
  const [reply, setReply] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [filters, setFilters] = useStoredState<IssueFilters>(`twinny-server.issues.${host}`, DEFAULT_ISSUE_FILTERS, isIssueFilters)
  const [search, setSearch] = useState("")
  const repos = overview.repos.filter((repo) => repo.issuesSupported)
  const all = useMemo(() => repos.flatMap((repo) => repo.issues.map((issue) => ({ repo, issue, triage: repo.triage[issue.number] as TriageBrief | undefined }))), [repos])
  const narrowed = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return all
      .filter(({ repo }) => !filters.repo || repo.id === filters.repo)
      .filter(({ issue }) => !filters.author || issue.author === filters.author)
      .filter(({ issue }) => !filters.label || issue.labels.includes(filters.label))
      .filter(({ issue }) => withinAge(issue.updatedAt, filters.age))
      .filter(({ issue }) => !needle || issue.title.toLowerCase().includes(needle) || issue.author.toLowerCase().includes(needle) || String(issue.number) === needle || issue.labels.some((label) => label.toLowerCase().includes(needle)))
  }, [all, filters.repo, filters.author, filters.label, filters.age, search])
  const rows = useMemo(
    () =>
      sortRows(
        narrowed.filter(({ triage }) => issueMatches(triage, filters.view)),
        filters.sort.dir,
        ({ issue, triage }) => {
          switch (filters.sort.key) {
            case "updated":
              return Date.parse(issue.updatedAt)
            case "created":
              return Date.parse(issue.createdAt)
            case "number":
              return issue.number
            case "title":
              return issue.title
            case "author":
              return issue.author
            case "comments":
              return issue.comments
            case "priority":
              return triage?.priority ? PRIORITY_RANK[triage.priority] : undefined
          }
        }
      ),
    [narrowed, filters.view, filters.sort]
  )
  const counts = useMemo(() => Object.fromEntries(ISSUE_VIEWS.map((view) => [view, narrowed.filter(({ triage }) => issueMatches(triage, view)).length])) as Record<IssueView, number>, [narrowed])
  const authors = useMemo(() => distinct(all.map(({ issue }) => issue.author)), [all])
  const labels = useMemo(() => distinct(all.flatMap(({ issue }) => issue.labels)), [all])
  const filtering = filters.view !== "all" || Boolean(filters.repo || filters.author || filters.label || filters.age || search.trim())
  const set = <K extends keyof IssueFilters>(key: K, value: IssueFilters[K]) => setFilters((current) => ({ ...current, [key]: value }))
  const sortBy = (key: IssueSortKey) => setFilters((current) => ({ ...current, sort: toggleSort(current.sort, key, naturalOf(ISSUE_SORTS, key)) }))

  useEffect(() => {
    if (!open) {
      setDetail(null)
      return
    }
    let cancelled = false
    setDetail(null)
    api<{ body: string; triage: TriageRecord | null }>(`${base}/repos/${open.repoId}/issues/${open.number}`, apiKey)
      .then((answer) => {
        if (cancelled) return
        setDetail(answer)
        setReply(answer.triage?.reply ?? "")
      })
      .catch((e: unknown) => !cancelled && setError(messageOf(e)))
    return () => {
      cancelled = true
    }
  }, [open, base, apiKey])

  const run = async (what: string, action: () => Promise<unknown>) => {
    setBusy(what)
    setError(undefined)
    try {
      await action()
      await onChanged()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(null)
    }
  }
  const triage = (repoId: string, number: number) =>
    run(`triage:${repoId}:${number}`, async () => {
      const answer = await api<{ triage: TriageRecord }>(`${base}/repos/${repoId}/issues/${number}/triage`, apiKey, { method: "POST" })
      if (open?.repoId === repoId && open.number === number) {
        setDetail((current) => (current ? { ...current, triage: answer.triage } : current))
        setReply(answer.triage.reply)
      }
    })
  const post = (repoId: string, number: number, what: "reply" | "labels") =>
    run(`post:${what}`, async () => {
      const answer = await api<{ triage: TriageRecord }>(`${base}/repos/${repoId}/issues/${number}/triage/post`, apiKey, { method: "POST", body: what === "reply" ? { labels: false, replyText: reply } : { reply: false } })
      setDetail((current) => (current ? { ...current, triage: answer.triage } : current))
    })

  if (repos.length === 0) return null
  const untriaged = all.filter((row) => !row.triage).length
  const high = all.filter((row) => row.triage?.priority === "high").length
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>
          Open issues
          <span className="count">{fmt(rows.length)}</span>
        </h2>
        <span className="links">
          {high > 0 && <span className="pill-s bad">{fmt(high)} high priority</span>}
          <span className="muted">{untriaged ? `${fmt(untriaged)} not triaged` : "all triaged"}</span>
        </span>
      </div>
      {error && <div className="error">{error}</div>}
      {all.length > 0 && (
        <>
          <div className="toolbar">
            <span className="chips" role="group" aria-label="View">
              {ISSUE_VIEWS.map((entry) => (
                <button key={entry} type="button" className={filters.view === entry ? "on" : ""} onClick={() => set("view", entry)} title={ISSUE_VIEW_TITLE[entry]}>
                  {ISSUE_VIEW_LABEL[entry]}
                  <span className="chip-count">{fmt(counts[entry])}</span>
                </button>
              ))}
            </span>
            <input type="search" className="search" placeholder="title, author, label or number" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search issues" />
          </div>
          <div className="toolbar filters">
            {repos.length > 1 && <FilterSelect label="repository" value={filters.repo} onChange={(value) => set("repo", value)} any="every repository" options={repos.map((repo) => ({ value: repo.id, label: repo.fullName }))} />}
            <FilterSelect label="author" value={filters.author} onChange={(value) => set("author", value)} any="anyone" options={authors.map((author) => ({ value: author, label: author }))} />
            {labels.length > 0 && <FilterSelect label="label" value={filters.label} onChange={(value) => set("label", value)} any="any label" options={labels.map((label) => ({ value: label, label }))} />}
            <FilterSelect label="activity" value={filters.age} onChange={(value) => set("age", value as Age)} options={AGE_OPTIONS} />
            {filtering && (
              <button
                type="button"
                className="link"
                onClick={() => {
                  setFilters((current) => ({ ...DEFAULT_ISSUE_FILTERS, sort: current.sort }))
                  setSearch("")
                }}
              >
                clear filters
              </button>
            )}
            <span className="spacer" />
            <label className="filter sort">
              <span>order by</span>
              <select value={filters.sort.key} onChange={(e) => set("sort", { key: e.target.value as IssueSortKey, dir: naturalOf(ISSUE_SORTS, e.target.value as IssueSortKey) })} aria-label="Order issues by">
                {ISSUE_SORTS.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </select>
              <button type="button" className="ghost mini dir" onClick={() => set("sort", { ...filters.sort, dir: filters.sort.dir === "asc" ? "desc" : "asc" })} title={filters.sort.dir === "asc" ? "Ascending; click for descending" : "Descending; click for ascending"} aria-label={filters.sort.dir === "asc" ? "Ascending" : "Descending"}>
                {filters.sort.dir === "asc" ? "↑" : "↓"}
              </button>
            </label>
          </div>
        </>
      )}
      {rows.length === 0 ? (
        <div className="empty">{all.length === 0 ? "No open issues." : "Nothing matches these filters."}</div>
      ) : (
        <div className="scroll">
          <table className="pulls">
            <thead>
              <tr>
                <SortHeader column="title" sort={filters.sort} onSort={sortBy}>
                  issue
                </SortHeader>
                <SortHeader column="author" sort={filters.sort} onSort={sortBy}>
                  author
                </SortHeader>
                <SortHeader column="priority" sort={filters.sort} onSort={sortBy}>
                  triage
                </SortHeader>
                <SortHeader column="comments" sort={filters.sort} onSort={sortBy} className="num">
                  comments
                </SortHeader>
                <SortHeader column="updated" sort={filters.sort} onSort={sortBy}>
                  updated
                </SortHeader>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ repo, issue, triage: brief }) => {
                const isOpen = open?.repoId === repo.id && open.number === issue.number
                const key = `${repo.id}:${issue.number}`
                return (
                  <React.Fragment key={key}>
                    <tr className="pull-row" onClick={() => setOpen(isOpen ? null : { repoId: repo.id, number: issue.number })}>
                      <td>
                        <div className="entity-name">{issue.title}</div>
                        <div className="key-id muted">
                          {repos.length > 1 ? `${repo.fullName} ` : ""}#{issue.number}
                          {issue.labels.map((label) => (
                            <span key={label} className="tag">
                              {label}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>{issue.author}</td>
                      <td>
                        {!brief ? (
                          <span className="muted">–</span>
                        ) : brief.status === "failed" ? (
                          <span className="pill-s bad">failed</span>
                        ) : (
                          <>
                            {brief.priority && <span className={`pill-s ${PRIORITY_TONE[brief.priority]}`}>{brief.priority}</span>}{" "}
                            {brief.duplicateOf !== undefined && <span className="tag stale">dup of #{brief.duplicateOf}</span>}
                            {brief.labels.map((label) => (
                              <span key={label} className={`tag ${brief.labeled ? "reviewed" : ""}`}>
                                {label}
                              </span>
                            ))}
                            {brief.replied && <span className="tag reviewed">replied</span>}
                          </>
                        )}
                      </td>
                      <td className={`num ${issue.comments ? "" : "muted"}`}>{fmt(issue.comments)}</td>
                      <td className="muted" title={`updated ${issue.updatedAt}\nopened ${issue.createdAt}`}>
                        {timeAgo(issue.updatedAt)}
                      </td>
                      <td className="actions" onClick={(e) => e.stopPropagation()}>
                        <button type="button" className="ghost mini" disabled={busy !== null || !review.alias} onClick={() => void triage(repo.id, issue.number)}>
                          {busy === `triage:${repo.id}:${issue.number}` ? "…" : brief ? "triage again" : "triage"}
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="issue-detail">
                        <td colSpan={6}>
                          {!detail ? (
                            <div className="skeleton-rows">
                              <span className="skeleton" style={{ width: "60%", height: 12 }} />
                              <span className="skeleton" style={{ width: "100%", height: 60 }} />
                            </div>
                          ) : (
                            <div className="issue-open">
                              <a href={issue.url} target="_blank" rel="noreferrer">
                                open #{issue.number} on the host
                              </a>
                              {detail.body.trim() ? <MarkdownView text={detail.body} className="pull-body" /> : <div className="empty">No description.</div>}
                              {detail.triage?.status === "done" && (
                                <div className="triage-box">
                                  <div className="review-meta">
                                    <span>
                                      <span className="meta-k">triaged by</span>
                                      {detail.triage.alias} {timeAgo(detail.triage.createdAt)}
                                    </span>
                                    {detail.triage.priority && (
                                      <span>
                                        <span className="meta-k">priority</span>
                                        <span className={`pill-s ${PRIORITY_TONE[detail.triage.priority]}`}>{detail.triage.priority}</span>
                                      </span>
                                    )}
                                    {detail.triage.duplicateOf !== undefined && (
                                      <span>
                                        <span className="meta-k">duplicate of</span>#{detail.triage.duplicateOf}
                                      </span>
                                    )}
                                    {detail.triage.labels.length > 0 && (
                                      <span>
                                        <span className="meta-k">labels</span>
                                        {detail.triage.labels.map((label) => (
                                          <span key={label} className="tag">
                                            {label}
                                          </span>
                                        ))}
                                        {detail.triage.labeledAt ? (
                                          <span className="tag reviewed">applied</span>
                                        ) : (
                                          <button type="button" className="ghost mini" disabled={busy !== null} onClick={() => void post(repo.id, issue.number, "labels")}>
                                            {busy === "post:labels" ? "…" : "apply labels"}
                                          </button>
                                        )}
                                      </span>
                                    )}
                                  </div>
                                  <label className="config-field">
                                    <span>reply to the reporter {detail.triage.repliedAt && <em className="muted">(posted {timeAgo(detail.triage.repliedAt)})</em>}</span>
                                    <textarea rows={4} value={reply} onChange={(e) => setReply(e.target.value)} disabled={busy !== null} />
                                  </label>
                                  <div className="row-actions">
                                    <button type="button" className={detail.triage.repliedAt ? "ghost" : "primary"} disabled={busy !== null || !reply.trim()} onClick={() => void post(repo.id, issue.number, "reply")}>
                                      {busy === "post:reply" ? "posting…" : detail.triage.repliedAt ? "post again" : "post reply"}
                                    </button>
                                  </div>
                                </div>
                              )}
                              {detail.triage?.status === "failed" && <div className="error">{detail.triage.error}</div>}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  The page                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A pull-request plugin's page. `member` is a developer the plugin is
 * shared with: the same pulls, reviews and issues, without the panels that
 * set up repositories, the host or the review model.
 */
export const PullsPanel = ({ host, apiKey, member = false }: { host: PullsHost; apiKey: string; member?: boolean }) => {
  const words = WORDS[host]
  const base = `/twinny/v1/admin/plugins/${host}/api`
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [filters, setFilters] = useStoredState<PullFilters>(`twinny-server.pulls.${host}`, DEFAULT_PULL_FILTERS, isPullFilters)
  const [search, setSearch] = useState("")
  const [opened, setOpened] = useState<{ repoId: string; number: number } | null>(null)
  const [detail, setDetail] = useState<PullPage | null>(null)
  const [detailError, setDetailError] = useState<string | undefined>()
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(async () => {
    try {
      setOverview(await api<Overview>(`${base}/`, apiKey))
      setError(undefined)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setError(e.message)
      else setError(messageOf(e))
    }
  }, [base, apiKey])

  useEffect(() => {
    void load()
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load()
    }, 60_000)
    return () => clearInterval(timer)
  }, [load])

  useEffect(() => {
    if (!opened) {
      setDetail(null)
      return
    }
    let cancelled = false
    setDetail(null)
    setDetailError(undefined)
    api<PullPage>(`${base}/repos/${opened.repoId}/pulls/${opened.number}`, apiKey)
      .then((answer) => {
        if (!cancelled) setDetail(answer)
      })
      .catch((e: unknown) => {
        if (!cancelled) setDetailError(messageOf(e))
      })
    return () => {
      cancelled = true
    }
  }, [opened, base, apiKey])

  const syncAll = async () => {
    setSyncing(true)
    try {
      await api(`${base}/sync`, apiKey, { method: "POST" })
      await load()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setSyncing(false)
    }
  }

  const all = useMemo(() => overview?.repos.flatMap((repo) => repo.pulls.map((pull) => ({ repo, pull, brief: repo.reviews[pull.number] as ReviewBrief | undefined }))) ?? [], [overview])

  /** Everything but the quick view and the drafts switch, so the chip counts say what each view would show. */
  const narrowedWithDrafts = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return all
      .filter(({ repo }) => !filters.repo || repo.id === filters.repo)
      .filter(({ pull }) => !filters.author || pull.author === filters.author)
      .filter(({ pull }) => !filters.label || pull.labels.includes(filters.label))
      .filter(({ pull }) => !filters.base || pull.baseRef === filters.base)
      .filter(({ pull }) => withinAge(pull.updatedAt, filters.age))
      .filter(({ pull }) => !needle || pull.title.toLowerCase().includes(needle) || pull.author.toLowerCase().includes(needle) || String(pull.number) === needle || pull.headRef.toLowerCase().includes(needle) || pull.labels.some((label) => label.toLowerCase().includes(needle)))
  }, [all, filters.repo, filters.author, filters.label, filters.base, filters.age, search])
  const narrowed = useMemo(() => (filters.drafts ? narrowedWithDrafts : narrowedWithDrafts.filter(({ pull }) => !pull.draft)), [narrowedWithDrafts, filters.drafts])

  const me = overview?.me.name
  const [meNotice, setMeNotice] = useState<string | undefined>()
  // The "drafts" view ignores the switch; every other view honours it.
  const pulls = useMemo(
    () =>
      sortRows(
        (filters.quick === "drafts" ? narrowedWithDrafts : narrowed).filter(({ pull, brief }) => matches(pull, filters.quick, brief, me)),
        filters.sort.dir,
        ({ pull }) => pullSortValue(pull, filters.sort.key)
      ),
    [narrowed, narrowedWithDrafts, filters.quick, filters.sort, me]
  )

  const counts = useMemo(
    () => Object.fromEntries(QUICKS.map((quick) => [quick, (quick === "drafts" ? narrowedWithDrafts : narrowed).filter(({ pull, brief }) => matches(pull, quick, brief, me)).length])) as Record<Quick, number>,
    [narrowed, narrowedWithDrafts, me]
  )
  const totals = useMemo(() => Object.fromEntries(QUICKS.map((quick) => [quick, all.filter(({ pull, brief }) => matches(pull, quick, brief, me)).length])) as Record<Quick, number>, [all, me])
  const authors = useMemo(() => distinct(all.map(({ pull }) => pull.author)), [all])
  const labels = useMemo(() => distinct(all.flatMap(({ pull }) => pull.labels)), [all])
  const bases = useMemo(() => distinct(all.map(({ pull }) => pull.baseRef)), [all])
  const filtering = filters.quick !== "all" || filters.drafts || Boolean(filters.repo || filters.author || filters.label || filters.base || filters.age || search.trim())
  const hiddenDrafts = filters.drafts || filters.quick === "drafts" ? 0 : narrowedWithDrafts.filter(({ pull }) => pull.draft).length
  const set = <K extends keyof PullFilters>(key: K, value: PullFilters[K]) => setFilters((current) => ({ ...current, [key]: value }))
  const sortBy = (key: PullSortKey) => setFilters((current) => ({ ...current, sort: toggleSort(current.sort, key, naturalOf(PULL_SORTS, key)) }))

  if (!overview)
    return error ? (
      <div className="error-bar">{error}</div>
    ) : (
      <PageSkeleton
        tiles={5}
        title={
          <h2 className="plugin-name">
            <PluginIcon id={host} size={22} />
            {HOST_NAMES[host]}
          </h2>
        }
      />
    )

  return (
    <>
      <div className="page-title">
        <h2 className="plugin-name">
          <PluginIcon id={host} size={22} />
          {HOST_NAMES[host]}
        </h2>
        <p>
          Open {words.nouns} on the {words.repoNoun === "project" ? "projects" : "repositories"} this gateway watches, synced every five minutes.{" "}
          <button type="button" className="link" onClick={() => void syncAll()} disabled={syncing}>
            {syncing ? "syncing…" : "sync now"}
          </button>
        </p>
      </div>
      {error && <div className="error-bar">{error}</div>}
      {meNotice && (
        <div className="success-bar with-close">
          <span>{meNotice}</span>
          <button type="button" className="link" onClick={() => setMeNotice(undefined)} aria-label="Dismiss">
            ok
          </button>
        </div>
      )}
      {member && !overview.me.name && <MePanel host={host} words={words} overview={overview} base={base} apiKey={apiKey} onChanged={load} asking onSaved={setMeNotice} />}

      <div className="tiles">
        <div className="tile">
          <div className="label">{words.repoNoun === "project" ? "projects" : "repositories"}</div>
          <div className="value">{fmt(overview.repos.length)}</div>
        </div>
        <div className="tile">
          <div className="label">open {words.nouns}</div>
          <div className="value">{fmt(totals.all)}</div>
        </div>
        <div className={`tile ${totals.failing ? "bad" : ""}`}>
          <div className="label">failing checks</div>
          <div className="value">{fmt(totals.failing)}</div>
        </div>
        <div className={`tile ${totals.conflicts ? "bad" : ""}`}>
          <div className="label">conflicts</div>
          <div className="value">{fmt(totals.conflicts)}</div>
        </div>
        <div className="tile">
          <div className="label">awaiting review</div>
          <div className="value">{fmt(totals.review)}</div>
        </div>
        <div className={`tile ${totals.ready ? "attention" : ""}`}>
          <div className="label">ready to merge</div>
          <div className="value">{fmt(totals.ready)}</div>
        </div>
      </div>

      {opened ? (
        detail ? (
          <PullView
            detail={detail}
            words={words}
            host={host}
            member={member}
            review={overview.review}
            me={me}
            onBack={() => setOpened(null)}
            onReview={async () => {
              const answer = await api<{ review: ReviewRecord }>(`${base}/repos/${opened.repoId}/pulls/${opened.number}/review`, apiKey, { method: "POST" })
              setDetail((current) => (current ? { ...current, review: answer.review, reviewing: false } : current))
              void load()
            }}
            onPost={async (as) => {
              const answer = await api<{ review: ReviewRecord }>(`${base}/repos/${opened.repoId}/pulls/${opened.number}/review/post`, apiKey, { method: "POST", body: { as } })
              setDetail((current) => (current ? { ...current, review: answer.review } : current))
              void load()
            }}
            onApprove={async () => {
              const answer = await api<{ pull: PullSummary }>(`${base}/repos/${opened.repoId}/pulls/${opened.number}/approve`, apiKey, { method: "POST" })
              setDetail((current) => (current ? { ...current, pull: answer.pull } : current))
              void load()
            }}
            onAsk={async (question) => {
              const answer = await api<{ review: ReviewRecord }>(`${base}/repos/${opened.repoId}/pulls/${opened.number}/review/ask`, apiKey, { method: "POST", body: { question } })
              setDetail((current) => (current ? { ...current, review: answer.review } : current))
            }}
          />
        ) : (
          <section className="panel">
            <button type="button" className="ghost mini" onClick={() => setOpened(null)}>
              ← {words.nouns}
            </button>
            {detailError ? (
              <div className="error">{detailError}</div>
            ) : (
              <div className="skeleton-rows" aria-busy="true" aria-label={`Loading the ${words.noun}`}>
                <span className="skeleton" style={{ width: "50%", height: 18, marginTop: 10 }} />
                <span className="skeleton" style={{ width: "70%", height: 12 }} />
                <span className="skeleton" style={{ width: "100%", height: 120, marginTop: 8 }} />
                <span className="skeleton" style={{ width: "100%", height: 180 }} />
              </div>
            )}
          </section>
        )
      ) : (
        <section className="panel">
          <div className="section-heading">
            <h2>
              Open {words.nouns}
              <span className="count">{fmt(pulls.length)}</span>
            </h2>
          </div>
          <div className="toolbar">
            <span className="chips" role="group" aria-label="View">
              {QUICKS.filter((entry) => entry !== "mine" || me !== undefined).map((entry) => (
                <button key={entry} type="button" className={filters.quick === entry ? "on" : ""} onClick={() => set("quick", entry)} title={entry === "mine" ? `${QUICK_TITLE.mine} (you are ${me})` : QUICK_TITLE[entry]}>
                  {QUICK_LABEL[entry]}
                  <span className="chip-count">{fmt(counts[entry])}</span>
                </button>
              ))}
            </span>
            <input type="search" className="search" placeholder="title, author, branch, label or number" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
          </div>
          <div className="toolbar filters">
            {overview.repos.length > 1 && <FilterSelect label={words.repoNoun} value={filters.repo} onChange={(value) => set("repo", value)} any={`every ${words.repoNoun}`} options={overview.repos.map((repo) => ({ value: repo.id, label: repo.fullName }))} />}
            <FilterSelect label="author" value={filters.author} onChange={(value) => set("author", value)} any="anyone" options={authors.map((author) => ({ value: author, label: author }))} />
            {labels.length > 0 && <FilterSelect label="label" value={filters.label} onChange={(value) => set("label", value)} any="any label" options={labels.map((label) => ({ value: label, label }))} />}
            {bases.length > 1 && <FilterSelect label="into" value={filters.base} onChange={(value) => set("base", value)} any="any branch" options={bases.map((base) => ({ value: base, label: base }))} />}
            <FilterSelect label="activity" value={filters.age} onChange={(value) => set("age", value as Age)} options={AGE_OPTIONS} />
            <button type="button" className={`mini toggle ${filters.drafts ? "on" : "ghost"}`} onClick={() => set("drafts", !filters.drafts)} aria-pressed={filters.drafts} title={filters.drafts ? "Drafts are in the list; click to hide them" : "Drafts are hidden; click to show them"}>
              {filters.drafts ? "drafts shown" : `drafts hidden${hiddenDrafts ? ` · ${fmt(hiddenDrafts)}` : ""}`}
            </button>
            {filtering && (
              <button
                type="button"
                className="link"
                onClick={() => {
                  setFilters((current) => ({ ...DEFAULT_PULL_FILTERS, sort: current.sort }))
                  setSearch("")
                }}
              >
                clear filters
              </button>
            )}
            <span className="spacer" />
            <label className="filter sort">
              <span>order by</span>
              <select value={filters.sort.key} onChange={(e) => set("sort", { key: e.target.value as PullSortKey, dir: naturalOf(PULL_SORTS, e.target.value as PullSortKey) })} aria-label="Order by">
                {PULL_SORTS.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </select>
              <button type="button" className="ghost mini dir" onClick={() => set("sort", { ...filters.sort, dir: filters.sort.dir === "asc" ? "desc" : "asc" })} title={filters.sort.dir === "asc" ? "Ascending; click for descending" : "Descending; click for ascending"} aria-label={filters.sort.dir === "asc" ? "Ascending" : "Descending"}>
                {filters.sort.dir === "asc" ? "↑" : "↓"}
              </button>
            </label>
          </div>
          {pulls.length === 0 ? (
            <div className="empty">{all.length === 0 ? `No open ${words.nouns}.` : hiddenDrafts && narrowedWithDrafts.length === hiddenDrafts ? `Only drafts (${fmt(hiddenDrafts)}), and drafts are hidden.` : "Nothing matches these filters."}</div>
          ) : (
            <div className="scroll">
              <table className="pulls">
                <thead>
                  <tr>
                    <SortHeader column="title" sort={filters.sort} onSort={sortBy}>
                      {words.noun}
                    </SortHeader>
                    <SortHeader column="author" sort={filters.sort} onSort={sortBy}>
                      author
                    </SortHeader>
                    <SortHeader column="size" sort={filters.sort} onSort={sortBy} className="num" title="Lines added and removed">
                      size
                    </SortHeader>
                    <SortHeader column="checks" sort={filters.sort} onSort={sortBy}>
                      checks
                    </SortHeader>
                    <SortHeader column="merge" sort={filters.sort} onSort={sortBy}>
                      merge
                    </SortHeader>
                    <SortHeader column="review" sort={filters.sort} onSort={sortBy}>
                      review
                    </SortHeader>
                    <SortHeader column="updated" sort={filters.sort} onSort={sortBy}>
                      updated
                    </SortHeader>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {pulls.map(({ repo, pull }) => (
                    <tr key={`${repo.id}:${pull.number}`} className={`pull-row ${waitingForMe(pull, me) ? "needs-me" : ""}`} onClick={() => setOpened({ repoId: repo.id, number: pull.number })} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setOpened({ repoId: repo.id, number: pull.number })}>
                      <td>
                        <div className="entity-name">
                          {pull.draft && <span className="tag">draft</span>} {pull.title}
                        </div>
                        <div className="key-id muted pull-sub">
                          <span className="pull-ref">
                            {overview.repos.length > 1 ? `${repo.fullName} ` : ""}
                            {words.hash}
                            {pull.number}
                          </span>
                          <span className="pull-branches">
                            <code>{pull.headRef}</code> → <code>{pull.baseRef}</code>
                          </span>
                        </div>
                        {(myStance(pull, me) !== undefined || pull.labels.length > 0) && (
                          <div className="pull-tags">
                            <MyReviewTag pull={pull} me={me} />
                            {pull.labels.map((label) => (
                              <span key={label} className="tag">
                                {label}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>{pull.author}</td>
                      <td className="num size" title={pull.changedFiles !== undefined ? plural(pull.changedFiles, "file changed", "files changed") : undefined}>
                        {pull.changedFiles === undefined ? (
                          <span className="muted">–</span>
                        ) : (
                          <>
                            <span className="ins-text">+{fmt(pull.additions ?? 0)}</span> <span className="del-text">−{fmt(pull.deletions ?? 0)}</span>
                          </>
                        )}
                      </td>
                      <td>
                        <Pill tone={CHECK_TONE[pull.checks]} title={pull.checkRuns.map((check) => `${check.name}: ${check.state}`).join("\n")}>
                          {pull.checks === "none" ? "none" : `${fmt(pull.checkRuns.filter((check) => check.state === "success").length)}/${fmt(pull.checkRuns.length)}`}
                        </Pill>
                      </td>
                      <td>
                        <Pill tone={MERGE_TONE[pull.mergeable]}>{MERGE_LABEL[pull.mergeable]}</Pill>
                      </td>
                      <td>
                        <Pill tone={REVIEW_TONE[pull.review]}>{REVIEW_LABEL[pull.review]}</Pill>
                        <Approvals pull={pull} />
                      </td>
                      <td className="muted" title={`updated ${pull.updatedAt}\nopened ${pull.createdAt}`}>
                        {timeAgo(pull.updatedAt)}
                      </td>
                      <td className="actions" onClick={(e) => e.stopPropagation()}>
                        <a href={pull.url} target="_blank" rel="noreferrer" className="open-link" title={`Open ${words.hash}${pull.number} on ${HOST_NAMES[host]}`} onKeyDown={(e) => e.stopPropagation()}>
                          open ↗
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <IssuesPanel host={host} overview={overview} base={base} apiKey={apiKey} review={overview.review} onChanged={load} />
      {member ? (
        overview.me.name ? <MePanel host={host} words={words} overview={overview} base={base} apiKey={apiKey} onChanged={load} onSaved={setMeNotice} /> : null
      ) : (
        <>
          <ReposPanel host={host} words={words} overview={overview} base={base} apiKey={apiKey} onChanged={load} />
          <TokensPanel host={host} words={words} overview={overview} base={base} apiKey={apiKey} onChanged={load} />
          <ReviewsPanel words={words} overview={overview} base={base} apiKey={apiKey} onChanged={load} />
          <HostPanel host={host} words={words} overview={overview} base={base} apiKey={apiKey} onChanged={load} />
        </>
      )}
    </>
  )
}

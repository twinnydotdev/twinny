/**
 * The page of a pull-request plugin (GitHub, GitLab): the watched
 * repositories with their sync state, the open pulls across them with
 * checks, mergeability and review state, and one pull opened with its
 * description and diffs. Talks only to the plugin's own routes.
 */
import React, { FormEvent, useCallback, useEffect, useMemo, useState } from "react"

import type { GitHubStatus } from "../plugins/github"
import type { PullPage, PullSummary, RepoView } from "../plugins/pulls"
import type { ReviewRecord } from "../plugins/reviews"

import { api, ApiError } from "./api"
import { fmt, plural, timeAgo } from "./format"
import { DiffBlock, MarkdownView } from "./markdown"
import { PluginIcon } from "./plugins"

export type PullsHost = "github" | "gitlab"

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
    tokenHint: "A fine-grained token with Pull requests, Contents, Checks and Commit statuses read access, or a classic token with repo scope. Leave blank to read through the GitHub App.",
    fullNameHint: "owner/name"
  },
  gitlab: {
    noun: "merge request",
    nouns: "merge requests",
    hash: "!",
    repoNoun: "project",
    tokenHint: "A project, group or personal access token with the read_api scope.",
    fullNameHint: "group/project"
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
  appAuth: boolean
  host: { baseUrl: string } & Partial<GitHubStatus>
  review: ReviewSetup
}

type Filter = "all" | "failing" | "conflicts" | "review" | "drafts"

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

const matches = (pull: PullSummary, filter: Filter): boolean =>
  filter === "all"
    ? true
    : filter === "failing"
      ? pull.checks === "failure"
      : filter === "conflicts"
        ? pull.mergeable === "conflicting"
        : filter === "review"
          ? pull.review === "review-required" || pull.review === "changes-requested"
          : pull.draft

const Pill = ({ tone, children, title }: { tone: string; children: React.ReactNode; title?: string }) => (
  <span className={`pill-s ${tone}`} title={title}>
    {children}
  </span>
)

/* -------------------------------------------------------------------------- */
/*  Repositories                                                              */
/* -------------------------------------------------------------------------- */

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
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const add = (e: FormEvent) => {
    e.preventDefault()
    const name = fullName.trim()
    if (!name) return
    void run("add", async () => {
      await api(`${base}/repos`, apiKey, { method: "POST", body: { fullName: name, ...(token.trim() ? { token: token.trim() } : {}) } })
      setFullName("")
      setToken("")
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
                      <span className="tag">{repo.auth === "app" ? "GitHub App" : "token"}</span>
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
        <input type="password" placeholder={overview.appAuth ? "token (optional)" : "access token"} value={token} onChange={(e) => setToken(e.target.value)} aria-label="Access token" disabled={busy !== null} autoComplete="off" />
        <button type="submit" className="primary" disabled={busy !== null || !fullName.trim() || (!overview.appAuth && !token.trim())}>
          {busy === "add" ? "…" : `watch ${words.repoNoun}`}
        </button>
        {host === "github" && overview.appAuth && (
          <button type="button" className="ghost" disabled={busy !== null} onClick={() => void loadPicker()}>
            {busy === "picker" ? "…" : "pick from the App"}
          </button>
        )}
        <span className="muted">{words.tokenHint}</span>
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
/*  Host settings: GitHub App, self-hosted URL                                */
/* -------------------------------------------------------------------------- */

interface HostPanelProps {
  host: PullsHost
  overview: Overview
  base: string
  apiKey: string
  onChanged: () => Promise<void>
}

const HostPanel = ({ host, overview, base, apiKey, onChanged }: HostPanelProps) => {
  const [appId, setAppId] = useState("")
  const [privateKey, setPrivateKey] = useState("")
  const [baseUrl, setBaseUrl] = useState(overview.host.baseUrl)
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
      setError(e instanceof Error ? e.message : String(e))
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
          <span className="muted">{host === "github" ? "GitHub Enterprise URL" : "GitLab URL"}</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} aria-label="Host URL" disabled={busy} spellCheck={false} />
        </label>
        <button type="submit" className="ghost" disabled={busy || baseUrl.trim() === overview.host.baseUrl}>
          save host
        </button>
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
  review: ReviewSetup
  onBack: () => void
  onReview: () => Promise<void>
}

const PullView = ({ detail, words, review, onBack, onReview }: PullViewProps) => {
  const { pull } = detail
  const [reviewing, setReviewing] = useState(detail.reviewing)
  const [reviewError, setReviewError] = useState<string | undefined>()
  useEffect(() => setReviewing(detail.reviewing), [detail.reviewing])
  const askReview = async () => {
    setReviewing(true)
    setReviewError(undefined)
    try {
      await onReview()
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : String(e))
    } finally {
      setReviewing(false)
    }
  }
  const stale = detail.review && detail.review.headSha !== pull.headSha
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
            open on {pull.url.startsWith("https://github.com") ? "GitHub" : pull.url.includes("gitlab") ? "GitLab" : "the host"}
          </a>
        </h2>
        <span className="links">
          <Pill tone={CHECK_TONE[pull.checks]}>{CHECK_LABEL[pull.checks]}</Pill>
          <Pill tone={MERGE_TONE[pull.mergeable]}>{MERGE_LABEL[pull.mergeable]}</Pill>
          <Pill tone={REVIEW_TONE[pull.review]}>{REVIEW_LABEL[pull.review]}</Pill>
        </span>
      </div>
      <h3 className="pull-title">
        {pull.draft && <span className="tag">draft</span>} {pull.title}
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
      <div className="review-actions">
        <button type="button" className={detail.review ? "ghost" : "primary"} disabled={reviewing || !review.available || !review.alias} onClick={() => void askReview()} title={!review.available ? "This gateway offers plugins no models" : !review.alias ? "No chat model is served" : undefined}>
          {reviewing ? "reviewing…" : detail.review ? "review again" : "review now"}
        </button>
        {review.alias && <span className="muted">with {review.alias}</span>}
        {reviewing && <span className="muted">The model is reading the {words.noun}; this can take a minute or two.</span>}
        {reviewError && <span className="bad-text">{reviewError}</span>}
      </div>
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
          </div>
          {detail.review.status === "failed" ? <div className="error">{detail.review.error}</div> : <MarkdownView text={detail.review.text} className="review-body" />}
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
      setError(e instanceof Error ? e.message : String(e))
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
/*  The page                                                                  */
/* -------------------------------------------------------------------------- */

export const PullsPanel = ({ host, apiKey }: { host: PullsHost; apiKey: string }) => {
  const words = WORDS[host]
  const base = `/twinny/v1/admin/plugins/${host}/api`
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [filter, setFilter] = useState<Filter>("all")
  const [repoFilter, setRepoFilter] = useState("")
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
      else setError(e instanceof Error ? e.message : String(e))
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
        if (!cancelled) setDetailError(e instanceof Error ? e.message : String(e))
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
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncing(false)
    }
  }

  const pulls = useMemo(() => {
    if (!overview) return []
    const needle = search.trim().toLowerCase()
    return overview.repos
      .filter((repo) => !repoFilter || repo.id === repoFilter)
      .flatMap((repo) => repo.pulls.map((pull) => ({ repo, pull })))
      .filter(({ pull }) => matches(pull, filter))
      .filter(({ pull }) => !needle || pull.title.toLowerCase().includes(needle) || pull.author.toLowerCase().includes(needle) || String(pull.number) === needle || pull.headRef.toLowerCase().includes(needle))
      .sort((a, b) => Date.parse(b.pull.updatedAt) - Date.parse(a.pull.updatedAt))
  }, [overview, filter, repoFilter, search])

  const all = useMemo(() => overview?.repos.flatMap((repo) => repo.pulls) ?? [], [overview])
  const counts: Record<Filter, number> = {
    all: all.length,
    failing: all.filter((pull) => matches(pull, "failing")).length,
    conflicts: all.filter((pull) => matches(pull, "conflicts")).length,
    review: all.filter((pull) => matches(pull, "review")).length,
    drafts: all.filter((pull) => matches(pull, "drafts")).length
  }

  if (!overview) return error ? <div className="error-bar">{error}</div> : <div className="loading">Loading…</div>

  return (
    <>
      <div className="page-title">
        <h2 className="plugin-name">
          <PluginIcon id={host} size={22} />
          {host === "github" ? "GitHub" : "GitLab"}
        </h2>
        <p>
          Open {words.nouns} on the {words.repoNoun === "project" ? "projects" : "repositories"} this gateway watches, synced every five minutes.{" "}
          <button type="button" className="link" onClick={() => void syncAll()} disabled={syncing}>
            {syncing ? "syncing…" : "sync now"}
          </button>
        </p>
      </div>
      {error && <div className="error-bar">{error}</div>}

      <div className="tiles">
        <div className="tile">
          <div className="label">{words.repoNoun === "project" ? "projects" : "repositories"}</div>
          <div className="value">{fmt(overview.repos.length)}</div>
        </div>
        <div className="tile">
          <div className="label">open {words.nouns}</div>
          <div className="value">{fmt(counts.all)}</div>
        </div>
        <div className={`tile ${counts.failing ? "bad" : ""}`}>
          <div className="label">failing checks</div>
          <div className="value">{fmt(counts.failing)}</div>
        </div>
        <div className={`tile ${counts.conflicts ? "bad" : ""}`}>
          <div className="label">conflicts</div>
          <div className="value">{fmt(counts.conflicts)}</div>
        </div>
        <div className="tile">
          <div className="label">awaiting review</div>
          <div className="value">{fmt(counts.review)}</div>
        </div>
      </div>

      {opened ? (
        detail ? (
          <PullView
            detail={detail}
            words={words}
            review={overview.review}
            onBack={() => setOpened(null)}
            onReview={async () => {
              const answer = await api<{ review: ReviewRecord }>(`${base}/repos/${opened.repoId}/pulls/${opened.number}/review`, apiKey, { method: "POST" })
              setDetail((current) => (current ? { ...current, review: answer.review, reviewing: false } : current))
              void load()
            }}
          />
        ) : (
          <section className="panel">
            <button type="button" className="ghost mini" onClick={() => setOpened(null)}>
              ← {words.nouns}
            </button>
            {detailError ? <div className="error">{detailError}</div> : <div className="loading">Loading the {words.noun}…</div>}
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
            <span className="chips" role="group" aria-label="Filter">
              {(["all", "failing", "conflicts", "review", "drafts"] as Filter[]).map((entry) => (
                <button key={entry} type="button" className={filter === entry ? "on" : ""} onClick={() => setFilter(entry)}>
                  {entry === "review" ? "needs review" : entry}
                  <span className="chip-count">{fmt(counts[entry])}</span>
                </button>
              ))}
            </span>
            {overview.repos.length > 1 && (
              <select value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} aria-label={`Filter by ${words.repoNoun}`}>
                <option value="">every {words.repoNoun}</option>
                {overview.repos.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.fullName}
                  </option>
                ))}
              </select>
            )}
            <input type="search" className="search" placeholder="title, author, branch or number" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
          </div>
          {pulls.length === 0 ? (
            <div className="empty">{all.length === 0 ? `No open ${words.nouns}.` : "Nothing matches."}</div>
          ) : (
            <div className="scroll">
              <table className="pulls">
                <thead>
                  <tr>
                    <th>{words.noun}</th>
                    <th>author</th>
                    <th>checks</th>
                    <th>merge</th>
                    <th>review</th>
                    <th>updated</th>
                  </tr>
                </thead>
                <tbody>
                  {pulls.map(({ repo, pull }) => (
                    <tr key={`${repo.id}:${pull.number}`} className="pull-row" onClick={() => setOpened({ repoId: repo.id, number: pull.number })} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setOpened({ repoId: repo.id, number: pull.number })}>
                      <td>
                        <div className="entity-name">
                          {pull.draft && <span className="tag">draft</span>} {pull.title}
                          {repo.reviews[pull.number] && (
                            <span className={`tag ${repo.reviews[pull.number].status === "failed" ? "failed" : repo.reviews[pull.number].stale ? "stale" : "reviewed"}`} title={`Reviewed by ${repo.reviews[pull.number].alias} ${timeAgo(repo.reviews[pull.number].createdAt)}`}>
                              {repo.reviews[pull.number].status === "failed" ? "review failed" : repo.reviews[pull.number].stale ? "review stale" : "reviewed"}
                            </span>
                          )}
                        </div>
                        <div className="key-id muted">
                          {overview.repos.length > 1 ? `${repo.fullName} ` : ""}
                          {words.hash}
                          {pull.number} · <code>{pull.headRef}</code>
                          {pull.changedFiles !== undefined && (
                            <>
                              {" "}
                              · {plural(pull.changedFiles, "file")} <span className="ins-text">+{fmt(pull.additions ?? 0)}</span> <span className="del-text">−{fmt(pull.deletions ?? 0)}</span>
                            </>
                          )}
                        </div>
                      </td>
                      <td>{pull.author}</td>
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
                      </td>
                      <td className="muted" title={pull.updatedAt}>
                        {timeAgo(pull.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <ReposPanel host={host} words={words} overview={overview} base={base} apiKey={apiKey} onChanged={load} />
      <ReviewsPanel words={words} overview={overview} base={base} apiKey={apiKey} onChanged={load} />
      <HostPanel host={host} overview={overview} base={base} apiKey={apiKey} onChanged={load} />
    </>
  )
}

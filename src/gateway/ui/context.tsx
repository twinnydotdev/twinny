/**
 * The Shared context plugin's page: the repositories in the team index,
 * their state, the embeddings model used, and a search box to try it.
 */
import React, { FormEvent, useCallback, useEffect, useState } from "react"

import { messageOf } from "../../common/errors"
import type { ContextHit, ContextRepoView } from "../plugins/context"

import { api } from "./api"
import { fmt, timeAgo } from "./format"
import { CodeBlock } from "./markdown"
import { PageSkeleton, PluginIcon } from "./plugins"

interface Overview {
  repos: ContextRepoView[]
  alias?: string
  aliases: string[]
  intervalMinutes: number
  searchPath: string
}

export const ContextPanel = ({ apiKey }: { apiKey: string }) => {
  const base = "/twinny/v1/admin/plugins/context/api"
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [url, setUrl] = useState("")
  const [name, setName] = useState("")
  const [branch, setBranch] = useState("")
  const [token, setToken] = useState("")
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<ContextHit[] | null>(null)

  const load = useCallback(async () => {
    try {
      setOverview(await api<Overview>(`${base}/`, apiKey))
      setError(undefined)
    } catch (e) {
      setError(messageOf(e))
    }
  }, [apiKey])

  // Poll every two seconds while anything is indexing, so the progress bar moves.
  const indexing = overview?.repos.some((repo) => repo.syncing) ?? false
  useEffect(() => {
    void load()
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load()
    }, indexing ? 2_000 : 30_000)
    return () => clearInterval(timer)
  }, [load, indexing])

  const run = async (what: string, action: () => Promise<unknown>, done?: string) => {
    setBusy(what)
    setError(undefined)
    setNotice(undefined)
    try {
      await action()
      await load()
      if (done) setNotice(done)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(null)
    }
  }

  const add = (e: FormEvent) => {
    e.preventDefault()
    void run("add", async () => {
      await api(`${base}/repos`, apiKey, { method: "POST", body: { url: url.trim(), ...(name.trim() ? { name: name.trim() } : {}), ...(branch.trim() ? { branch: branch.trim() } : {}), ...(token.trim() ? { token: token.trim() } : {}) } })
      setUrl("")
      setName("")
      setBranch("")
      setToken("")
    }, "Cloning and indexing; the table shows the progress.")
  }

  const search = (e: FormEvent) => {
    e.preventDefault()
    void run("search", async () => {
      const answer = await api<{ hits: ContextHit[] }>(`${base}/search`, apiKey, { method: "POST", body: { query, k: 8 } })
      setHits(answer.hits)
    })
  }

  if (!overview)
    return error ? (
      <div className="error-bar">{error}</div>
    ) : (
      <PageSkeleton
        tiles={3}
        rows={3}
        title={
          <h2 className="plugin-name">
            <PluginIcon id="context" size={22} />
            Shared context
          </h2>
        }
      />
    )

  const chunks = overview.repos.reduce((sum, repo) => sum + (repo.index?.chunks ?? 0), 0)
  const files = overview.repos.reduce((sum, repo) => sum + (repo.index?.files ?? 0), 0)

  return (
    <>
      <div className="page-title">
        <h2 className="plugin-name">
          <PluginIcon id="context" size={22} />
          Shared context
        </h2>
        <p>One index of your repositories, on this gateway, that every connected chat can draw on.</p>
      </div>
      {notice && <div className="success-bar">{notice}</div>}
      {error && <div className="error-bar">{error}</div>}

      <div className="tiles">
        <div className="tile">
          <div className="label">repositories</div>
          <div className="value">{fmt(overview.repos.length)}</div>
        </div>
        <div className="tile">
          <div className="label">files indexed</div>
          <div className="value">{fmt(files)}</div>
        </div>
        <div className="tile">
          <div className="label">chunks</div>
          <div className="value">{fmt(chunks)}</div>
        </div>
        <div className={`tile ${overview.alias ? "" : "bad"}`}>
          <div className="label">embeddings model</div>
          <div className="value">{overview.alias ?? "none served"}</div>
        </div>
      </div>

      <section className="panel">
        <div className="section-heading">
          <h2>
            Repositories
            <span className="count">{fmt(overview.repos.length)}</span>
          </h2>
          <span className="muted">re-indexed every {fmt(overview.intervalMinutes)} min while the models are idle</span>
        </div>
        {overview.repos.length === 0 ? (
          <div className="empty">Nothing indexed yet. Add a repository below.</div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>repository</th>
                  <th>branch</th>
                  <th>files</th>
                  <th>chunks</th>
                  <th>indexed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {overview.repos.map((repo) => (
                  <tr key={repo.id} className={repo.error ? "repo-error" : ""}>
                    <td>
                      <div className="entity-name">{repo.name}</div>
                      <div className="key-id muted">
                        {repo.url.replace(/\/\/[^@]+@/, "//")}
                        {repo.tokenSet && <span className="tag">token</span>}
                      </div>
                      {repo.error && <div className="repo-problem">{repo.error}</div>}
                      {repo.syncing && (
                        <div className="sync-progress" aria-live="polite">
                          <span className="meter" style={{ width: 160 }}>
                            <span className={`meter-fill ${repo.progress?.total ? "" : "indeterminate"}`} style={{ width: repo.progress?.total ? `${Math.round((repo.progress.done / repo.progress.total) * 100)}%` : "40%" }} />
                          </span>
                          <span className="muted">
                            {!repo.progress
                              ? "starting…"
                              : repo.progress.phase === "embedding"
                                ? `embedding ${fmt(repo.progress.done)} of ${fmt(repo.progress.total)} chunks`
                                : `${repo.progress.phase}…`}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="muted">{repo.branch ?? "default"}</td>
                    <td>{repo.index ? fmt(repo.index.files) : "–"}</td>
                    <td>{repo.index ? fmt(repo.index.chunks) : "–"}</td>
                    <td className="muted" title={repo.index?.commit}>
                      {repo.syncing ? <span className="pill-s warn">indexing</span> : repo.index?.updatedAt ? timeAgo(repo.index.updatedAt) : "never"}
                    </td>
                    <td className="actions">
                      <button type="button" className="ghost mini" disabled={busy !== null || repo.syncing} onClick={() => void run(`sync:${repo.id}`, () => api(`${base}/repos/${repo.id}/sync`, apiKey, { method: "POST" }))}>
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
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form className="create-form" onSubmit={add}>
          <div className="config-fields">
            <label className="config-field">
              <span>clone URL</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/acme/widgets.git" spellCheck={false} disabled={busy !== null} />
            </label>
            <label className="config-field">
              <span>name (optional)</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="acme/widgets" spellCheck={false} disabled={busy !== null} />
            </label>
            <label className="config-field">
              <span>branch (optional; the default branch otherwise)</span>
              <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" spellCheck={false} disabled={busy !== null} />
            </label>
            <label className="config-field">
              <span>token for a private https clone (optional; user:token or a token)</span>
              <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" disabled={busy !== null} />
            </label>
          </div>
          <div className="row-actions">
            <button type="submit" className="primary" disabled={busy !== null || !url.trim() || !overview.alias}>
              {busy === "add" ? "…" : "add repository"}
            </button>
            <span className="muted">Cloned shallow onto this server and re-indexed on the interval; only changed files are embedded again. Tokens are kept on the server and never shown.</span>
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>Model and schedule</h2>
        </div>
        <div className="newkey">
          <label>
            <span className="muted">embeddings model</span>
            <select value={overview.alias ?? ""} disabled={busy !== null || overview.aliases.length === 0} onChange={(e) => void run("alias", () => api(`${base}/settings`, apiKey, { method: "PUT", body: { alias: e.target.value } }), "Saved. Repositories are re-embedded on their next sync.")}>
              {overview.aliases.length === 0 && <option value="">no embeddings alias is served</option>}
              {overview.aliases.map((alias) => (
                <option key={alias} value={alias}>
                  {alias}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="muted">re-index every (minutes)</span>
            <input inputMode="numeric" defaultValue={overview.intervalMinutes} disabled={busy !== null} onBlur={(e) => Number(e.target.value) !== overview.intervalMinutes && void run("interval", () => api(`${base}/settings`, apiKey, { method: "PUT", body: { intervalMinutes: Number(e.target.value) } }), "Interval saved.")} style={{ width: 90 }} />
          </label>
          <span className="muted">Developers connected to this team get hits from here in their chats' "relevant code" alongside their own workspace.</span>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>Try a search</h2>
          <span className="muted">what a developer's chat would pull in</span>
        </div>
        <form className="newkey" onSubmit={search}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="where do we validate the licence token?" disabled={busy !== null} />
          <button type="submit" disabled={busy !== null || !query.trim() || !overview.alias}>
            {busy === "search" ? "…" : "search"}
          </button>
        </form>
        {hits && hits.length === 0 && <div className="empty">Nothing matched.</div>}
        {hits && hits.length > 0 && (
          <div className="turns">
            {hits.map((hit, i) => (
              <CodeBlock key={`${hit.repo}:${hit.path}:${hit.startLine}-${i}`} code={hit.text} language={hit.path.slice(hit.path.lastIndexOf(".") + 1)} title={<><b>{hit.repo}</b> {hit.path}:{hit.startLine}-{hit.endLine} <span className="muted">score {hit.score}</span></>} />
            ))}
          </div>
        )}
      </section>
    </>
  )
}

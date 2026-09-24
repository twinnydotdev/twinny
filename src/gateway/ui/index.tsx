/**
 * The admin page: one screen for the person running the gateway. Signs in
 * with an admin key (kept in this tab only), then shows whether the
 * backends answer, how much each developer and model has been used over a
 * period, and which keys exist. Reads the gateway's own API; nothing else.
 */
import React, { FormEvent, useCallback, useEffect, useMemo, useState } from "react"
import { createRoot } from "react-dom/client"

import { messageOf } from "../../common/errors"
import { inviteLink, RemoteIdentity, RemoteStatus } from "../../protocol/types"
import type { PluginSummary } from "../plugins/host"
import type { UsageSummary } from "../usage"

import { api, ApiError } from "./api"
import { AuditPage } from "./audit"
import { ConfigurationPanel } from "./configuration"
import { fmt } from "./format"
import { OTHER, OverviewPage, Series } from "./overview"
import { CreatedKey, KeysResponse, PeoplePage } from "./people"
import { PlanPage } from "./plan"
import { PluginIcon, PluginPage, PluginsPage } from "./plugins"
import { RecordingsPanel } from "./recordings"
import { UsagePage } from "./usage"

type Period = "24h" | "7d" | "30d"
type AdminView = "overview" | "usage" | "people" | "policy" | "recordings" | "audit" | "models" | "plan" | "plugins" | `plugin:${string}`
const PERIODS: Period[] = ["24h", "7d", "30d"]
const STORAGE_KEY = "twinny-server.admin-key"
const VIEW_KEY = "twinny-server.admin-view"
/** A demo gateway marks the page; it then opens as the read-only visitor. */
const DEMO = document.documentElement.dataset.demo === "1"
const DEMO_KEY = "demo"

/** The validated dark categorical slots, assigned to keys in first-seen order. */
const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)"]
const MAX_SERIES = SERIES.length

/** Views the period picker applies to; it is hidden elsewhere so it never looks like it does something. */
const PERIOD_VIEWS = new Set<AdminView>(["overview", "usage", "people", "models"])

const isView = (value: unknown): value is AdminView =>
  value === "overview" || value === "usage" || value === "people" || value === "policy" || value === "recordings" || value === "audit" || value === "models" || value === "plan" || value === "plugins" || (typeof value === "string" && /^plugin:[a-z][a-z0-9-]{1,31}$/.test(value))

/* -------------------------------------------------------------------------- */
/*  Sign-in                                                                   */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*  Demo                                                                      */
/* -------------------------------------------------------------------------- */

interface GuestInvite {
  code: string
  name: string
  expiresAt: string
  guestMinutes: number
}

/** Says what the visitor is looking at, and gets them a guest key for VS Code. */
const DemoBar = () => {
  const [invite, setInvite] = useState<GuestInvite | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const ask = async () => {
    setBusy(true)
    try {
      const made = await api<GuestInvite>("/twinny/v1/demo/invite", DEMO_KEY, { method: "POST" })
      setInvite(made)
      setError(undefined)
      window.location.href = inviteLink(window.location.origin, made.code)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="demo-bar">
      <span>
        <b>Live demo.</b> A real twinny-server with real models behind it. You are looking at the admin page read-only: changes are switched off.
      </span>
      <span className="spacer" />
      {invite ? (
        <span>
          VS Code should be opening as <b>{invite.name}</b>, a guest for {fmt(invite.guestMinutes)} minutes. <a href={inviteLink(window.location.origin, invite.code)}>Open again</a>
        </span>
      ) : (
        <button className="primary" onClick={() => void ask()} disabled={busy} title="Needs the Twinny extension installed in VS Code">
          {busy ? "…" : "Try it in VS Code"}
        </button>
      )}
      {error && <span className="demo-error">{error}</span>}
    </div>
  )
}

const SignIn = ({ onKey, error }: { onKey: (key: string) => void; error?: string }) => {
  const [value, setValue] = useState("")
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (value.trim()) onKey(value.trim())
  }
  return (
    <main className="signin">
      <section className="card">
        <h1>
          twinny<span>-server</span>
        </h1>
        <p>Sign in with an admin key.</p>
        <form onSubmit={submit}>
          <input type="password" autoFocus placeholder="tsk_…" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Admin key" />
          <button type="submit" className="primary">
            Open
          </button>
        </form>
        {error && <div className="error">{error}</div>}
        <div className="hint">
          Make one on the server: <code>twinny-server keys create you --admin</code>. The key stays in this tab.
        </div>
        {DEMO && (
          <div className="hint">
            <button type="button" className="ghost" onClick={() => onKey(DEMO_KEY)}>
              Back to the demo
            </button>
          </div>
        )}
      </section>
    </main>
  )
}

/* -------------------------------------------------------------------------- */
/*  App                                                                       */
/* -------------------------------------------------------------------------- */

interface Data {
  status: RemoteStatus
  usage: UsageSummary
  keys: KeysResponse
  plugins: PluginSummary[]
  pluginsLicensed: boolean
}

const App = () => {
  const [key, setKey] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(STORAGE_KEY) ?? (DEMO ? DEMO_KEY : null)
    } catch {
      return DEMO ? DEMO_KEY : null
    }
  })
  const [who, setWho] = useState<RemoteIdentity | null>(null)
  const [period, setPeriod] = useState<Period>("7d")
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [signInError, setSignInError] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [view, setViewState] = useState<AdminView>(() => {
    try {
      const hash = location.hash.replace(/^#/, "")
      if (isView(hash)) return hash
      const remembered = sessionStorage.getItem(VIEW_KEY)
      return isView(remembered) ? remembered : "overview"
    } catch {
      return "overview"
    }
  })
  const [pendingSignIns, setPendingSignIns] = useState(0)
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)

  // The tab survives a reload and the URL names it, so a link can point at one.
  const setView = useCallback((next: AdminView) => {
    setViewState(next)
    try {
      sessionStorage.setItem(VIEW_KEY, next)
      history.replaceState(null, "", `#${next}`)
    } catch {
      // Nothing to remember.
    }
  }, [])
  useEffect(() => {
    const onHash = () => {
      const hash = location.hash.replace(/^#/, "")
      if (isView(hash)) setViewState(hash)
    }
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  const signOut = useCallback(() => {
    try {
      sessionStorage.removeItem(STORAGE_KEY)
    } catch {
      // Nothing to forget.
    }
    setKey(null)
    setWho(null)
    setData(null)
  }, [])

  // Who the key belongs to, and whether it may see this page at all.
  useEffect(() => {
    if (!key) return
    let cancelled = false
    api<RemoteIdentity>("/twinny/v1/whoami", key)
      .then((identity) => {
        if (cancelled) return
        if (!identity.admin) {
          setSignInError(`"${identity.key}" is not an admin key. Create one with --admin.`)
          signOut()
          return
        }
        setSignInError(undefined)
        setWho(identity)
        try {
          if (key !== DEMO_KEY) sessionStorage.setItem(STORAGE_KEY, key)
        } catch {
          // The tab will ask again next time.
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setSignInError(messageOf(e))
        signOut()
      })
    return () => {
      cancelled = true
    }
  }, [key, signOut])

  const load = useCallback(async () => {
    if (!key || !who) return
    setLoading(true)
    try {
      const [status, usage, keys, store] = await Promise.all([
        api<RemoteStatus>("/twinny/v1/status", key),
        api<UsageSummary>(`/twinny/v1/admin/usage?since=${period}`, key),
        api<KeysResponse>("/twinny/v1/admin/keys", key),
        // An older gateway has no plugins; the store is then empty.
        api<{ plugins: PluginSummary[]; licensed: boolean }>("/twinny/v1/admin/plugins", key).catch(() => ({ plugins: [] as PluginSummary[], licensed: false }))
      ])
      setData({ status, usage, keys, plugins: store.plugins, pluginsLicensed: store.licensed })
      setRefreshedAt(Date.now())
      setError(undefined)
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setSignInError(e.message)
        signOut()
        return
      }
      setError(messageOf(e))
    } finally {
      setLoading(false)
    }
  }, [key, who, period, signOut])

  useEffect(() => {
    void load()
  }, [load])

  // Keep the numbers fresh while the tab is open, without hammering the backends.
  useEffect(() => {
    if (!who) return
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load()
    }, 60_000)
    return () => clearInterval(timer)
  }, [who, load])

  const createKey = useCallback(
    async (name: string, admin: boolean, readOnly = false) => {
      if (!key) throw new Error("Not signed in.")
      const created = await api<CreatedKey>("/twinny/v1/admin/keys", key, { method: "POST", body: { name, admin, ...(readOnly ? { readOnly: true } : {}) } })
      await load()
      return created
    },
    [key, load]
  )

  const revokeKey = useCallback(
    async (id: string) => {
      if (!key) throw new Error("Not signed in.")
      await api(`/twinny/v1/admin/keys/${id}/revoke`, key, { method: "POST" })
      await load()
    },
    [key, load]
  )

  const installLicense = useCallback(
    async (token: string) => {
      if (!key) throw new Error("Not signed in.")
      await api("/twinny/v1/admin/license", key, { method: "PUT", body: { token } })
      await load()
    },
    [key, load]
  )

  const togglePlugin = useCallback(
    async (id: string, enabled: boolean) => {
      if (!key) throw new Error("Not signed in.")
      await api(`/twinny/v1/admin/plugins/${id}/${enabled ? "enable" : "disable"}`, key, { method: "POST" })
      await load()
    },
    [key, load]
  )

  const removeLicense = useCallback(async () => {
    if (!key) throw new Error("Not signed in.")
    await api("/twinny/v1/admin/license", key, { method: "DELETE" })
    await load()
  }, [key, load])

  // Colours follow the key, in order of first appearance across the period:
  // a filter that changes the period never repaints a survivor.
  const series = useMemo<Series[]>(() => {
    if (!data) return []
    const ranked = Object.entries(data.usage.byKey)
      .sort((a, b) => b[1].requests - a[1].requests || a[0].localeCompare(b[0]))
      .map(([name]) => name)
    return ranked.slice(0, MAX_SERIES).map((name, i) => ({ name, color: SERIES[i] }))
  }, [data])
  const colorOf = (name: string) => series.find((s) => s.name === name)?.color ?? OTHER

  if (!key || !who) return <SignIn onKey={setKey} error={signInError} />

  const down = data?.status.backends.filter((b) => !b.ok) ?? []
  const plan = data?.keys.plan
  const planAttention = !!plan && plan.status !== "free" && plan.status !== "licensed"
  const features = plan?.features ?? []

  const navButton = (target: AdminView, label: React.ReactNode) => (
    <button key={target} className={view === target ? "on" : ""} onClick={() => setView(target)} aria-current={view === target ? "page" : undefined}>
      {label}
    </button>
  )
  const enabledPlugins = data?.plugins.filter((plugin) => plugin.enabled) ?? []
  const openPlugin = view.startsWith("plugin:") ? view.slice("plugin:".length) : undefined

  return (
    <div className="app">
      <header className="top">
        <h1>
          twinny<span>-server</span>
        </h1>
        {data && (
          <button type="button" className={`pill ${down.length ? "bad" : "ok"}`} onClick={() => setView("overview")} title="Live backend checks; open the overview">
            <i />
            {down.length
              ? `${down.length} of ${data.status.backends.length} backends down: ${down.map((b) => b.provider).join(", ")}`
              : `${data.status.backends.length} backend${data.status.backends.length === 1 ? "" : "s"} answering`}
          </button>
        )}
        <span className="spacer" />
        {PERIOD_VIEWS.has(view) && (
          <span className="chips" role="group" aria-label="Period">
            {PERIODS.map((p) => (
              <button key={p} className={p === period ? "on" : "ghost"} onClick={() => setPeriod(p)}>
                {p}
              </button>
            ))}
          </span>
        )}
        <button className="ghost" onClick={() => void load()} disabled={loading} title={refreshedAt ? `Refreshed ${new Date(refreshedAt).toLocaleTimeString()}; refreshes itself every minute` : undefined}>
          {loading ? "…" : "refresh"}
        </button>
        <span className="who" title="Signed in with this admin key">
          {who.key}
        </span>
        <button className="ghost" onClick={signOut}>
          {key === DEMO_KEY ? "admin sign in" : "sign out"}
        </button>
      </header>
      {DEMO && key === DEMO_KEY && <DemoBar />}

      <div className="shell">
        <nav className="sidenav" aria-label="Admin sections">
          <div className="group">Monitor</div>
          {navButton("overview", <>Overview{down.length > 0 && <span className="badge bad">{fmt(down.length)}</span>}</>)}
          {navButton("usage", "Usage")}
          <div className="group">Team</div>
          {navButton("people", <>People{pendingSignIns > 0 && <span className="badge">{fmt(pendingSignIns)}</span>}</>)}
          {navButton("policy", "Policy")}
          {navButton("recordings", "Recordings")}
          {navButton("audit", "Audit log")}
          <div className="group">Gateway</div>
          {navButton("models", "Providers & models")}
          {navButton("plan", <>Plan &amp; licence{planAttention && <span className="badge bad">!</span>}</>)}
          <div className="group">Plugins</div>
          {navButton("plugins", <>Store{enabledPlugins.length > 0 && <span className="badge">{fmt(enabledPlugins.length)}</span>}</>)}
          {enabledPlugins.map((plugin) =>
            navButton(
              `plugin:${plugin.id}`,
              <span className="nav-plugin">
                <PluginIcon id={plugin.id} size={14} />
                {plugin.name}
              </span>
            )
          )}
        </nav>
        <div className="main">
          {error && <div className="error-bar">{error}</div>}
          {!data && !error && <div className="loading">Loading…</div>}

          <div hidden={view !== "recordings"}>{view === "recordings" && <RecordingsPanel apiKey={key} features={features} />}</div>
          <div hidden={view !== "audit"}>{view === "audit" && <AuditPage apiKey={key} />}</div>

          <div hidden={view !== "models" && view !== "policy"}>
            <ConfigurationPanel
              apiKey={key}
              onSaved={() => void load()}
              features={features}
              section={view === "policy" ? "policy" : "models"}
              status={data?.status}
              usage={data?.usage}
              period={period}
              onNavigate={setView}
            />
          </div>

          {data && (
            <>
              <div hidden={view !== "overview"}>
                <OverviewPage status={data.status} usage={data.usage} keys={data.keys} period={period} series={series} colorOf={colorOf} onNavigate={setView} />
              </div>

              <div hidden={view !== "usage"}>
                <UsagePage summary={data.usage} status={data.status} period={period} colorOf={colorOf} />
              </div>

              <div hidden={view !== "people"}>
                <PeoplePage
                  apiKey={key}
                  keys={data.keys}
                  usage={data.usage}
                  period={period}
                  me={who.key}
                  pending={pendingSignIns}
                  onPending={setPendingSignIns}
                  onChanged={() => void load()}
                  onCreate={createKey}
                  onRevoke={revokeKey}
                  onNavigate={setView}
                />
              </div>

              <div hidden={view !== "plan"}>{plan && <PlanPage plan={plan} onInstall={installLicense} onRemove={removeLicense} onNavigate={setView} />}</div>

              <div hidden={view !== "plugins"}>
                <PluginsPage plugins={data.plugins} licensed={data.pluginsLicensed} onToggle={togglePlugin} onOpen={(id) => setView(`plugin:${id}`)} onNavigate={setView} />
              </div>

              {openPlugin && (
                <div>
                  {enabledPlugins.some((plugin) => plugin.id === openPlugin) ? (
                    <PluginPage key={openPlugin} id={openPlugin} apiKey={key} />
                  ) : (
                    <div className="empty">
                      This plugin is switched off.{" "}
                      <button type="button" className="link" onClick={() => setView("plugins")}>
                        plugins
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const root = document.getElementById("root")
if (root) createRoot(root).render(<App />)

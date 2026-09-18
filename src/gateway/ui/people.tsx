/**
 * The People page: who has a key, what they have used it for lately, the
 * sign-in codes waiting for approval, and making or revoking keys by hand.
 */
import React, { FormEvent, useCallback, useEffect, useMemo, useState } from "react"

import { inviteLink } from "../../protocol/types"
import type { UsageSummary } from "../usage"

import { api } from "./api"
import { compact, fmt, plural, timeAgo, timeUntil, when } from "./format"

export interface KeyRow {
  id: string
  name: string
  createdAt: string
  revokedAt?: string
  admin?: boolean
}

/** The plan as the gateway reports it: `LicenseSummary` in src/gateway/license.ts. */
export interface PlanSummary {
  status: "free" | "licensed" | "expiring" | "grace" | "expired" | "invalid"
  features: string[]
  seats: number
  used: number
  unseated: string[]
  org?: string
  licenseId?: string
  expiresAt?: string
  email?: string
  message: string
}

export interface KeysResponse {
  keys: KeyRow[]
  sharedToken: boolean
  plan?: PlanSummary
}

export interface CreatedKey {
  key: string
  record: KeyRow
}

/* -------------------------------------------------------------------------- */
/*  Invites                                                                   */
/* -------------------------------------------------------------------------- */

interface PendingInvite {
  id: string
  name: string
  admin?: boolean
  replace?: boolean
  createdAt: string
  expiresAt: string
  createdBy: string
}

interface MadeInvite {
  code: string
  invite: PendingInvite
}

/** The address developers reach this gateway at: this page's origin, minus /admin. */
const gatewayAddress = (): string => {
  const { origin, pathname } = window.location
  return `${origin}${pathname.replace(/\/admin(\/.*)?$/, "")}`.replace(/\/+$/, "")
}

const ADDRESS_KEY = "twinny-server.invite-address"

/** The address the last invite was made with, when the admin changed it. */
const rememberedAddress = (): string => {
  try {
    return localStorage.getItem(ADDRESS_KEY) ?? ""
  } catch {
    return ""
  }
}

const rememberAddress = (address: string) => {
  try {
    if (address && address !== gatewayAddress()) localStorage.setItem(ADDRESS_KEY, address)
    else localStorage.removeItem(ADDRESS_KEY)
  } catch {
    // No storage; the field is prefilled from the page's address anyway.
  }
}

interface InvitePanelProps {
  apiKey: string
  seatsLeft?: number
  /** Names holding an active key: inviting one of these replaces that key. */
  activeNames?: string[]
  onSeatsFull?: () => void
}

/**
 * The short path onto the team: a link per developer. Opening it in VS
 * Code makes their key and shows them the team's models to confirm, so
 * nothing is read out or pasted. The code is shown once, here.
 */
export const InvitePanel = ({ apiKey, seatsLeft, activeNames = [], onSeatsFull }: InvitePanelProps) => {
  const [invites, setInvites] = useState<PendingInvite[]>([])
  const [name, setName] = useState("")
  const [admin, setAdmin] = useState(false)
  const [replace, setReplace] = useState(false)
  const [made, setMade] = useState<MadeInvite | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [copied, setCopied] = useState<"link" | "message" | null>(null)
  const [copyFallback, setCopyFallback] = useState<"link" | "message" | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [address, setAddress] = useState(() => rememberedAddress() || gatewayAddress())

  const load = useCallback(async () => {
    try {
      const { invites } = await api<{ invites: PendingInvite[] }>("/twinny/v1/admin/invites", apiKey)
      setInvites(invites)
      setNow(Date.now())
    } catch {
      // The page's main loader reports auth problems.
    }
  }, [apiKey])

  useEffect(() => {
    void load()
  }, [load])

  const clash = !!name.trim() && activeNames.includes(name.trim())
  const seatsFull = seatsLeft === 0 && !(clash && replace)

  const create = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !name.trim()) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await api<MadeInvite>("/twinny/v1/admin/invites", apiKey, {
        method: "POST",
        body: { name: name.trim(), admin, ...(clash && replace ? { replace: true } : {}) }
      })
      rememberAddress(address.trim())
      setMade(result)
      setName("")
      setAdmin(false)
      setReplace(false)
      setCopied(null)
      setCopyFallback(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const withdraw = async (invite: PendingInvite) => {
    setBusy(true)
    setError(undefined)
    try {
      await api(`/twinny/v1/admin/invites/${invite.id}`, apiKey, { method: "DELETE" })
      if (made?.invite.id === invite.id) setMade(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const link = made ? inviteLink(address.trim() || gatewayAddress(), made.code) : ""
  const message = made
    ? [
        "You're invited to our Twinny team.",
        "",
        "1. Install Twinny in VS Code: https://marketplace.visualstudio.com/items?itemName=rjmacarthy.Twinny",
        `2. Open this link (it opens VS Code and connects you): ${link}`,
        "3. Confirm the team's models in the Twinny sidebar.",
        "",
        `The link works once and expires ${when(made.invite.expiresAt)}. On Cursor or VSCodium, replace vscode:// with cursor:// or vscodium://.`
      ].join("\n")
    : ""

  const copy = async (what: "link" | "message") => {
    try {
      await navigator.clipboard.writeText(what === "link" ? link : message)
      setCopied(what)
      setCopyFallback(null)
      setTimeout(() => setCopied(null), 2_000)
    } catch {
      // HTTP on a private network may have no Clipboard API. In that
      // case the full message still needs to be available to select.
      setCopyFallback(what)
    }
  }

  return (
    <>
      {error && <div className="error">{error}</div>}
      <form className="newkey create" onSubmit={(event) => void create(event)}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="developer name or username"
          aria-label="Key name for the invite"
          disabled={busy}
          autoFocus
        />
        <input
          type="url"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="https://ai.example.com"
          aria-label="Address developers reach this gateway at"
          title="The address the link carries: what developers' machines reach this gateway at"
          disabled={busy}
        />
        <label className="signin-admin">
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} disabled={busy} /> admin
        </label>
        {clash && (
          <label className="signin-admin" title={`${name.trim()} already has an active key. Replacing revokes it when the invite is opened, so a lost key does not keep its seat.`}>
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} disabled={busy} /> replace existing key
          </label>
        )}
        <button
          type="submit"
          className="primary"
          disabled={busy || !name.trim() || !address.trim() || (clash && !replace) || seatsFull}
          title={
            !name.trim()
              ? "Name the key the invite makes"
              : clash && !replace
                ? `${name.trim()} already has an active key: tick "replace existing key", or use another name`
                : seatsFull
                  ? "Every seat is taken. Revoke a key or add seats."
                  : `Make an invite link for ${name.trim()}`
          }
        >
          make invite link
        </button>
        {seatsFull && onSeatsFull && (
          <button type="button" className="link" onClick={onSeatsFull}>
            every seat is taken: add seats
          </button>
        )}
      </form>
      {made && (
        <div className="created">
          <div>
            Invite for <b>{made.invite.name}</b>
            {made.invite.admin ? " (admin)" : ""}
            {made.invite.replace ? ", replacing their current key" : ""}. Send them this link; it opens VS Code and connects them. Works once, expires {when(made.invite.expiresAt)}.
          </div>
          <code className="secret">{link}</code>
          {copyFallback && (
            <div>
              <p className="hint" role="status">Clipboard access is unavailable. Select the text below and copy it.</p>
              <textarea
                aria-label="Invite text to copy"
                readOnly
                autoFocus
                rows={copyFallback === "message" ? 8 : 3}
                style={{ width: "100%", boxSizing: "border-box" }}
                value={copyFallback === "message" ? message : link}
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
          )}
          <div className="row">
            <button type="button" onClick={() => void copy("link")}>
              {copied === "link" ? "copied" : "copy link"}
            </button>
            <button type="button" onClick={() => void copy("message")}>
              {copied === "message" ? "copied" : "copy a message to send"}
            </button>
            <button type="button" className="ghost" onClick={() => setMade(null)}>
              done
            </button>
          </div>
        </div>
      )}
      {invites.length > 0 && (
        <div className="scroll">
          <table className="rows">
            <thead>
              <tr>
                <th>Key name</th>
                <th>Made by</th>
                <th>Sent</th>
                <th>Expires</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invites.map((invite) => (
                <tr key={invite.id} className="static">
                  <td>
                    <b>{invite.name}</b>
                    {invite.admin ? <span className="pill-s"> admin</span> : null}
                    {invite.replace ? <span className="pill-s"> replace</span> : null}
                  </td>
                  <td className="muted">{invite.createdBy}</td>
                  <td className="muted" title={when(invite.createdAt)}>
                    {timeAgo(invite.createdAt, now)}
                  </td>
                  <td className="muted">{timeUntil(invite.expiresAt, now)}</td>
                  <td className="actions">
                    <button type="button" className="ghost" disabled={busy} onClick={() => void withdraw(invite)}>
                      withdraw
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint">
        The link carries a one-time code, not a key: the key is made under this name when the link is opened, and an unopened invite holds no seat. Send it over a channel you trust. Withdraw it if it went to the wrong person.
      </div>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/*  Sign-in requests                                                          */
/* -------------------------------------------------------------------------- */

interface PendingSignIn {
  userCode: string
  name?: string
  machine?: string
  createdAt: string
  expiresAt: string
}

interface SignInPanelProps {
  apiKey: string
  /** Called after an approval so the key list refreshes. */
  onChanged: () => void
  /** How many are waiting, for the navigation badge and the tiles. */
  onCount?: (count: number) => void
  seatsLeft?: number
  /** Names holding an active key: approving one of these replaces that key. */
  activeNames?: string[]
}

/**
 * Codes developers are waiting on. Polled every few seconds while the page
 * is open, since the whole point is that the admin sees a request as it
 * comes in. Approving names the key; the developer's VS Code collects it.
 */
export const SignInPanel = ({ apiKey, onChanged, onCount, seatsLeft, activeNames = [] }: SignInPanelProps) => {
  const [requests, setRequests] = useState<PendingSignIn[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [admins, setAdmins] = useState<Record<string, boolean>>({})
  const [replaces, setReplaces] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      const { requests } = await api<{ requests: PendingSignIn[] }>("/twinny/v1/admin/signin", apiKey)
      setRequests(requests)
      onCount?.(requests.length)
      setNow(Date.now())
    } catch {
      // The page's main loader reports auth problems; a missed poll is not news.
    }
  }, [apiKey, onCount])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 4_000)
    return () => clearInterval(timer)
  }, [load])

  const act = async (code: string, action: "approve" | "deny") => {
    setBusy(code)
    setError(undefined)
    setNotice(undefined)
    try {
      const name = (names[code] ?? requests.find((r) => r.userCode === code)?.name ?? "").trim()
      const replace = activeNames.includes(name) && replaces[code] === true
      const body = action === "approve" ? { name, admin: admins[code] === true, ...(replace ? { replace: true } : {}) } : undefined
      const result = await api<{ name?: string; replaced?: string }>(`/twinny/v1/admin/signin/${code}/${action}`, apiKey, { method: "POST", body })
      setNotice(
        action !== "approve"
          ? `Denied ${code}.`
          : result.replaced
            ? `New key made for ${result.name}; their old key is revoked. Their VS Code picks it up within a few seconds.`
            : `Key made for ${result.name}. Their VS Code picks it up within a few seconds.`
      )
      await load()
      if (action === "approve") onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {notice && <div className="success-bar">{notice}</div>}
      {error && <div className="error">{error}</div>}
      {!requests.length ? (
        <div className="empty">
          No one is waiting. A developer asks for a key from <b>Connect to team → Request a key</b> in VS Code and reads you the code that appears; it shows up here within a few seconds.
        </div>
      ) : (
        <div className="scroll">
          <table className="rows">
            <thead>
              <tr>
                <th>Code</th>
                <th>Key name</th>
                <th>Machine</th>
                <th>Requested</th>
                <th>Expires</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => {
                const name = (names[r.userCode] ?? r.name ?? "").trim()
                const expired = Date.parse(r.expiresAt) <= now
                const clash = !!name && activeNames.includes(name)
                const replacing = clash && replaces[r.userCode] === true
                return (
                  <tr key={r.userCode} className="static">
                    <td>
                      <code className="signin-code">{r.userCode}</code>
                    </td>
                    <td>
                      <input
                        value={names[r.userCode] ?? r.name ?? ""}
                        onChange={(e) => setNames({ ...names, [r.userCode]: e.target.value })}
                        placeholder="developer name"
                        aria-label={`Key name for ${r.userCode}`}
                        disabled={busy === r.userCode}
                      />
                      <label className="signin-admin">
                        <input type="checkbox" checked={admins[r.userCode] === true} onChange={(e) => setAdmins({ ...admins, [r.userCode]: e.target.checked })} disabled={busy === r.userCode} /> admin
                      </label>
                      {clash && (
                        <label className="signin-admin" title={`${name} already has an active key. Replacing revokes it, so a lost key does not keep its seat.`}>
                          <input
                            type="checkbox"
                            checked={replacing}
                            onChange={(e) => setReplaces({ ...replaces, [r.userCode]: e.target.checked })}
                            disabled={busy === r.userCode}
                          />{" "}
                          replace existing key
                        </label>
                      )}
                    </td>
                    <td className="muted">{r.machine ?? "–"}</td>
                    <td className="muted" title={when(r.createdAt)}>
                      {timeAgo(r.createdAt, now)}
                    </td>
                    <td className={expired ? "revoked" : "muted"}>{timeUntil(r.expiresAt, now)}</td>
                    <td className="actions">
                      <button
                        type="button"
                        className="primary"
                        disabled={busy === r.userCode || !name || expired || (clash && !replacing) || (seatsLeft === 0 && !replacing)}
                        title={
                          !name
                            ? "Give the key a name first"
                            : clash && !replacing
                              ? `${name} already has an active key: tick "replace existing key", or use another name`
                              : replacing
                                ? `Revoke ${name}'s current key and make a new one`
                                : seatsLeft === 0
                                  ? "No seats left"
                                  : `Make a key named ${name}`
                        }
                        onClick={() => void act(r.userCode, "approve")}
                      >
                        approve
                      </button>
                      <button type="button" className="ghost" disabled={busy === r.userCode} onClick={() => void act(r.userCode, "deny")}>
                        deny
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint">Approve only a code someone has read to you. Approving mints a key under the name you choose; the code itself never becomes a key.</div>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/*  Keys                                                                      */
/* -------------------------------------------------------------------------- */

type Filter = "active" | "admins" | "unseated" | "revoked" | "all"

interface KeysPanelProps extends KeysResponse {
  me: string
  usage?: UsageSummary
  period: string
  onCreate: (name: string, admin: boolean) => Promise<CreatedKey>
  onRevoke: (id: string) => Promise<void>
}

/** Requests and the last day with any, per key name, from the usage summary. */
const activity = (usage: UsageSummary | undefined) => {
  const lastDay: Record<string, string> = {}
  for (const day of usage?.byDay ?? []) for (const name of Object.keys(day.byKey)) if (day.byKey[name] > 0) lastDay[name] = day.day
  return { totals: usage?.byKey ?? {}, lastDay }
}

/** The key list, plus making and revoking keys without leaving the page. */
export const KeysPanel = ({ keys, sharedToken, plan, me, usage, period, onCreate, onRevoke }: KeysPanelProps) => {
  const unseated = new Set(plan?.unseated ?? [])
  const [filter, setFilter] = useState<Filter>("active")
  const [search, setSearch] = useState("")
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [admin, setAdmin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<CreatedKey | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const { totals, lastDay } = useMemo(() => activity(usage), [usage])
  const seatsFull = plan ? plan.used >= plan.seats : false

  const counts = useMemo(() => {
    const active = keys.filter((k) => !k.revokedAt)
    return {
      all: keys.length,
      active: active.length,
      admins: active.filter((k) => k.admin).length,
      unseated: active.filter((k) => unseated.has(k.name)).length,
      revoked: keys.length - active.length
    }
  }, [keys, unseated])

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase()
    const pass = (k: KeyRow) => {
      if (term && !k.name.toLowerCase().includes(term) && !k.id.includes(term)) return false
      switch (filter) {
        case "active":
          return !k.revokedAt
        case "admins":
          return !k.revokedAt && k.admin === true
        case "unseated":
          return !k.revokedAt && unseated.has(k.name)
        case "revoked":
          return !!k.revokedAt
        default:
          return true
      }
    }
    // Live keys first, alphabetically; revoked ones after, newest revocation first.
    return keys.filter(pass).sort((a, b) => {
      if (!a.revokedAt !== !b.revokedAt) return a.revokedAt ? 1 : -1
      if (a.revokedAt && b.revokedAt) return b.revokedAt.localeCompare(a.revokedAt)
      return a.name.localeCompare(b.name)
    })
  }, [keys, filter, search, unseated])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      setCreated(await onCreate(name.trim(), admin))
      setName("")
      setAdmin(false)
      setCopied(false)
      setCreating(false)
      if (filter === "revoked") setFilter("active")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.key)
      setCopied(true)
    } catch {
      // No clipboard on this origin; the key is selectable.
    }
  }

  const revoke = async (k: KeyRow) => {
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      await onRevoke(k.id)
      setNotice(`Revoked ${k.name}. Their editor is refused from the next request on.${filter === "all" || filter === "revoked" ? "" : " It is listed under Revoked."}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setConfirming(null)
    }
  }

  const chip = (value: Filter, label: string, count: number) => (
    <button key={value} type="button" className={filter === value ? "on" : "ghost"} onClick={() => setFilter(value)} disabled={value !== "all" && value !== "active" && count === 0 && filter !== value}>
      {label}
      <span className="chip-count">{fmt(count)}</span>
    </button>
  )

  return (
    <>
      <div className="toolbar">
        <span className="chips" role="group" aria-label="Show">
          {chip("active", "Active", counts.active)}
          {chip("admins", "Admins", counts.admins)}
          {counts.unseated > 0 && chip("unseated", "No seat", counts.unseated)}
          {chip("revoked", "Revoked", counts.revoked)}
          {chip("all", "All", counts.all)}
        </span>
        <input className="search" type="search" placeholder="find by name or id" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Find a key" />
        {!creating && (
          <button type="button" className="primary" disabled={busy || seatsFull} title={seatsFull ? "Every seat is taken. Revoke a key or add seats." : "Make a key by hand and hand it over yourself"} onClick={() => setCreating(true)}>
            new key
          </button>
        )}
      </div>
      {creating && (
        <form className="newkey create" onSubmit={submit}>
          <input placeholder="developer name, e.g. alice" value={name} onChange={(e) => setName(e.target.value)} aria-label="Key name" disabled={busy} autoFocus />
          <label>
            <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} disabled={busy} /> admin: may open this page
          </label>
          <button type="submit" className="primary" disabled={busy || !name.trim() || seatsFull}>
            {busy ? "…" : "create key"}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => {
              setCreating(false)
              setName("")
              setAdmin(false)
            }}
          >
            cancel
          </button>
          <span className="muted">Letters, digits, . _ @ and -; up to 64 characters. The secret is shown once.</span>
        </form>
      )}
      {created && (
        <div className="created">
          <div>
            Key for <b>{created.record.name}</b>
            {created.record.admin ? " (admin)" : ""}. Shown once; only its hash is kept. Send it over a channel you trust.
          </div>
          <code className="secret">{created.key}</code>
          <div className="row">
            <button type="button" onClick={copy}>
              {copied ? "copied" : "copy"}
            </button>
            <button type="button" className="ghost" onClick={() => setCreated(null)}>
              done
            </button>
          </div>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {notice && <div className="success-bar">{notice}</div>}
      {!shown.length ? (
        <div className="empty">
          {search.trim() ? (
            <>No key matches “{search.trim()}”{filter !== "all" ? " in this view" : ""}.</>
          ) : filter === "revoked" ? (
            "No key has been revoked."
          ) : filter === "admins" ? (
            "No admin keys are active."
          ) : filter === "unseated" ? (
            "Every active key has a seat."
          ) : (
            "No keys yet. Approve a sign-in request above, or make a key by hand."
          )}
        </div>
      ) : (
        <div className="scroll">
          <table className="rows">
            <thead>
              <tr>
                <th>Key</th>
                <th>Status</th>
                <th>Created</th>
                <th>Last active</th>
                <th className="num">Requests</th>
                <th className="num">Tokens</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((k) => {
                const t = totals[k.name]
                const live = !k.revokedAt
                return (
                  <tr key={k.id} className={`static ${live ? "" : "dim"}`}>
                    <td>
                      <span className="entity-name">{k.name}</span>
                      {k.admin && <span className="tag admin">admin</span>}
                      {k.name === me && <span className="tag you">you</span>}
                      <div className="key-id muted mono" title="The key's id, for twinny-server keys revoke">
                        {k.id}
                      </div>
                    </td>
                    <td>
                      {k.revokedAt ? (
                        <span className="pill-s bad" title={`Revoked ${when(k.revokedAt)}`}>
                          revoked {timeAgo(k.revokedAt)}
                        </span>
                      ) : unseated.has(k.name) ? (
                        <span className="pill-s bad" title="Refused until seats are added or other keys revoked">
                          no seat
                        </span>
                      ) : (
                        <span className="pill-s ok">active</span>
                      )}
                    </td>
                    <td className="muted" title={when(k.createdAt)}>
                      {timeAgo(k.createdAt)}
                    </td>
                    <td className="muted" title={lastDay[k.name] ? undefined : `Nothing in the last ${period}`}>
                      {lastDay[k.name] ?? "–"}
                    </td>
                    <td className="num">
                      {t ? (
                        <span title={`${fmt(t.ok)} ok, ${fmt(t.failed)} failed, ${fmt(t.cancelled)} cancelled`}>
                          {fmt(t.requests)}
                          {t.failed > 0 && <span className="revoked"> · {fmt(t.failed)} failed</span>}
                        </span>
                      ) : (
                        <span className="muted">0</span>
                      )}
                    </td>
                    <td className="num">
                      {t && t.counted ? (
                        <span title={`${fmt(t.promptTokens)} prompt, ${fmt(t.completionTokens)} output`}>
                          {compact(t.promptTokens)}
                          <span className="muted"> → </span>
                          {compact(t.completionTokens)}
                        </span>
                      ) : (
                        <span className="muted">–</span>
                      )}
                    </td>
                    <td className="actions">
                      {live &&
                        k.name !== me &&
                        (confirming === k.id ? (
                          <>
                            <button type="button" className="danger" disabled={busy} onClick={() => void revoke(k)} title={`Revoke ${k.name}`}>
                              confirm
                            </button>
                            <button type="button" className="ghost" onClick={() => setConfirming(null)}>
                              keep
                            </button>
                          </>
                        ) : (
                          <button type="button" className="ghost" disabled={busy} onClick={() => setConfirming(k.id)}>
                            revoke
                          </button>
                        ))}
                    </td>
                  </tr>
                )
              })}
              {sharedToken && (filter === "active" || filter === "all") && !search.trim() && (
                <tr className="static">
                  <td>
                    <span className="entity-name">shared</span>
                    <div className="key-id muted">the shared token</div>
                  </td>
                  <td>
                    <span className="pill-s ok" title="Retire it by setting auth.tokenEnv to null">
                      active
                    </span>
                  </td>
                  <td className="muted">–</td>
                  <td className="muted">{lastDay.shared ?? "–"}</td>
                  <td className="num">{totals.shared ? fmt(totals.shared.requests) : <span className="muted">0</span>}</td>
                  <td className="num muted">–</td>
                  <td className="actions" />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

/* -------------------------------------------------------------------------- */
/*  Sharing                                                                   */
/* -------------------------------------------------------------------------- */

/** A teammate's computer connected to the pool: `PeerSnapshot` in src/gateway/peers.ts. */
interface PeerRow {
  id: string
  key: string
  machine: string
  label: string
  backend: string
  models: string[]
  slots: number
  inflight: number
  connectedAt: string
  served: number
  failed: number
  degradedUntil?: string
}

interface PeersResponse {
  peers: PeerRow[]
  /** Whether the configuration has a team pool at all. */
  configured: boolean
  /** Backend model names the pool's aliases want. */
  wanted: string[]
}

/**
 * Who is sharing their computer with the team right now. Polled while the
 * page is open; a disconnect closes that connection (the developer's
 * extension reconnects unless they switch sharing off).
 */
export const SharingPanel = ({ apiKey, usage }: { apiKey: string; usage?: UsageSummary }) => {
  const [data, setData] = useState<PeersResponse | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      setData(await api<PeersResponse>("/twinny/v1/admin/peers", apiKey))
      setNow(Date.now())
    } catch (err) {
      // A gateway without peer support answers 503; the panel then says so once.
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [apiKey])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 5_000)
    return () => clearInterval(timer)
  }, [load])

  const disconnect = async (peer: PeerRow) => {
    setBusy(peer.id)
    setError(undefined)
    try {
      await api(`/twinny/v1/admin/peers/${peer.id}/disconnect`, apiKey, { method: "POST" })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  if (!data) return error ? <div className="error">{error}</div> : <div className="loading">Loading…</div>
  const served = usage?.byPeer ?? {}
  return (
    <>
      {error && <div className="error">{error}</div>}
      {!data.configured ? (
        <div className="empty">
          No team pool yet. Add a <b>Team members' computers</b> provider under Providers &amp; models and point aliases at it; developers then see <b>Share this computer with the team</b> in Twinny.
        </div>
      ) : !data.peers.length ? (
        <div className="empty">
          Nobody is sharing right now. The pool wants {data.wanted.length ? data.wanted.map((m) => <code key={m}>{m}</code>).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ", ", el] : [el]), []) : "no models yet"}. A developer switches sharing on from the Twinny sidebar.
        </div>
      ) : (
        <div className="scroll">
          <table className="rows">
            <thead>
              <tr>
                <th>Computer</th>
                <th>Server</th>
                <th>Models</th>
                <th className="num">Running</th>
                <th className="num">Served</th>
                <th>Since</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.peers.map((p) => {
                const offered = p.models.filter((m) => data.wanted.includes(m))
                const degraded = p.degradedUntil && Date.parse(p.degradedUntil) > now
                const totals = served[p.label]
                return (
                  <tr key={p.id} className="static">
                    <td>
                      <span className="entity-name">{p.key}</span>
                      <span className="muted">@{p.machine}</span>
                    </td>
                    <td className="muted">
                      {p.backend}
                      {degraded && <span className="revoked"> · not answering</span>}
                    </td>
                    <td title={p.models.join(", ")}>
                      {offered.length ? offered.join(", ") : <span className="muted">none the pool wants ({p.models.length} local)</span>}
                    </td>
                    <td className="num">
                      {fmt(p.inflight)}
                      <span className="muted"> / {fmt(p.slots)}</span>
                    </td>
                    <td className="num" title={totals ? `${fmt(totals.requests)} in the selected period` : undefined}>
                      {fmt(p.served)}
                      {p.failed > 0 && <span className="revoked"> · {fmt(p.failed)} failed</span>}
                    </td>
                    <td className="muted" title={when(p.connectedAt)}>
                      {timeAgo(p.connectedAt, now)}
                    </td>
                    <td className="actions">
                      <button type="button" className="ghost" disabled={busy === p.id} onClick={() => void disconnect(p)}>
                        disconnect
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint">Requests to pooled aliases run on these computers; usage records name the computer that served each one. Disconnecting is temporary; revoke the key to keep someone out.</div>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/*  The page                                                                  */
/* -------------------------------------------------------------------------- */

interface PeoplePageProps {
  apiKey: string
  keys: KeysResponse
  usage?: UsageSummary
  period: string
  me: string
  pending: number
  onPending: (count: number) => void
  onChanged: () => void
  onCreate: (name: string, admin: boolean) => Promise<CreatedKey>
  onRevoke: (id: string) => Promise<void>
  onNavigate: (view: "plan") => void
}

export const PeoplePage = ({ apiKey, keys, usage, period, me, pending, onPending, onChanged, onCreate, onRevoke, onNavigate }: PeoplePageProps) => {
  const active = keys.keys.filter((k) => !k.revokedAt)
  const plan = keys.plan
  const seatsLeft = plan ? Math.max(0, plan.seats - plan.used) : undefined
  const usedLately = active.filter((k) => (usage?.byKey[k.name]?.requests ?? 0) > 0).length
  return (
    <>
      <div className="page-title">
        <h2>People</h2>
        <p>
          {plan ? `${plan.used} of ${plan.seats} seats used. ` : ""}
          Invite developers with a link, approve sign-in codes they read to you, or make keys by hand.
        </p>
      </div>
      <section className="tiles">
        <div className={`tile ${plan && plan.used >= plan.seats ? "bad" : ""}`}>
          <div className="label">Active keys</div>
          <div className="value">
            {fmt(plan ? plan.used : active.length)}
            {plan && <small>of {fmt(plan.seats)} seats</small>}
          </div>
        </div>
        <div className="tile">
          <div className="label">Active in {period}</div>
          <div className="value">
            {fmt(usedLately)}
            <small>of {fmt(active.length)}</small>
          </div>
        </div>
        <div className="tile">
          <div className="label">Admins</div>
          <div className="value">{fmt(active.filter((k) => k.admin).length)}</div>
        </div>
        <div className={`tile ${pending ? "attention" : ""}`}>
          <div className="label">Waiting to sign in</div>
          <div className="value">{fmt(pending)}</div>
        </div>
        <div className="tile">
          <div className="label">Revoked</div>
          <div className="value">{fmt(keys.keys.length - active.length)}</div>
        </div>
      </section>
      {plan && plan.unseated.length > 0 && (
        <div className="error-bar">
          {plural(plan.unseated.length, "key")} without a seat, refused until seats are added or keys revoked: {plan.unseated.join(", ")}.{" "}
          <button type="button" className="link" onClick={() => onNavigate("plan")}>
            Add seats
          </button>
        </div>
      )}
      {plan && plan.unseated.length === 0 && plan.used >= plan.seats && (
        <div className="error-bar">
          Every seat is taken: the next key, invite or sign-in is refused until seats are added or a key is revoked.{" "}
          <button type="button" className="link" onClick={() => onNavigate("plan")}>
            Add seats
          </button>
        </div>
      )}
      <section className="panel">
        <h2>
          Invite<span className="count">{plural(active.length, "person", "people")} on the team</span>
        </h2>
        <InvitePanel apiKey={apiKey} seatsLeft={seatsLeft} activeNames={active.map((k) => k.name)} onSeatsFull={() => onNavigate("plan")} />
      </section>
      <section className="panel">
        <h2>
          Sign-in requests
          {pending > 0 && <span className="count">{fmt(pending)} waiting</span>}
        </h2>
        <SignInPanel apiKey={apiKey} onChanged={onChanged} onCount={onPending} seatsLeft={seatsLeft} activeNames={active.map((k) => k.name)} />
      </section>
      <section className="panel">
        <h2>
          Keys<span className="count">{plural(keys.keys.length, "key")}</span>
        </h2>
        <KeysPanel {...keys} me={me} usage={usage} period={period} onCreate={onCreate} onRevoke={onRevoke} />
      </section>
      <section className="panel">
        <h2>Sharing their computer</h2>
        <SharingPanel apiKey={apiKey} usage={usage} />
      </section>
    </>
  )
}

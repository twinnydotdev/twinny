/**
 * The SSO plugin's page: the identity provider's settings, whether its
 * discovery document was read, the sign-in link to give developers,
 * and recent sign-ins.
 */
import React, { FormEvent, useCallback, useEffect, useState } from "react"

import { messageOf } from "../../common/errors"
import type { OidcSettingsView, OidcSignIn } from "../plugins/oidc"

import { api } from "./api"
import { fmt, timeAgo } from "./format"
import { CopyButton } from "./markdown"
import { PageSkeleton, PluginIcon } from "./plugins"

interface Overview {
  settings: OidcSettingsView
  configured: boolean
  discovery: { issuer: string; authorization: string } | null
  discoveryError?: string
  signIns: OidcSignIn[]
  startPath: string
  callbackPath: string
  pending: number
}

export const OidcPanel = ({ apiKey }: { apiKey: string }) => {
  const base = "/twinny/v1/admin/plugins/oidc/api"
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [busy, setBusy] = useState<string | null>(null)
  const [form, setForm] = useState({ issuer: "", clientId: "", clientSecret: "", scopes: "", allowedDomains: "", adminEmails: "", publicUrl: "", nameClaim: "email" })

  const fill = useCallback((settings: OidcSettingsView) => {
    setForm({
      issuer: settings.issuer,
      clientId: settings.clientId,
      clientSecret: "",
      scopes: settings.scopes,
      allowedDomains: settings.allowedDomains.join(", "),
      adminEmails: settings.adminEmails.join(", "),
      publicUrl: settings.publicUrl,
      nameClaim: settings.nameClaim
    })
  }, [])

  const load = useCallback(async () => {
    try {
      const answer = await api<Overview>(`${base}/`, apiKey)
      setOverview(answer)
      setError(undefined)
      return answer
    } catch (e) {
      setError(messageOf(e))
      return null
    }
  }, [apiKey])

  useEffect(() => {
    void load().then((answer) => answer && fill(answer.settings))
  }, [load, fill])

  const run = async (what: string, action: () => Promise<unknown>, done?: string) => {
    setBusy(what)
    setError(undefined)
    setNotice(undefined)
    try {
      await action()
      const answer = await load()
      if (answer && what === "save") fill(answer.settings)
      if (done) setNotice(done)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(null)
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault()
    void run("save", () => api(`${base}/settings`, apiKey, { method: "PUT", body: { ...form, ...(form.clientSecret ? {} : { clientSecret: undefined }) } }), "Settings saved.")
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
            <PluginIcon id="oidc" size={22} />
            SSO sign-in
          </h2>
        }
      />
    )

  const origin = overview.settings.publicUrl || window.location.origin
  const startUrl = `${origin}${overview.startPath}`
  const callbackUrl = `${origin}${overview.callbackPath}`
  const failed = overview.signIns.filter((s) => !s.ok).length

  return (
    <>
      <div className="page-title">
        <h2 className="plugin-name">
          <PluginIcon id="oidc" size={22} />
          SSO sign-in
        </h2>
        <p>Developers sign in with your identity provider and VS Code connects with a key of their own.</p>
      </div>
      {notice && <div className="success-bar">{notice}</div>}
      {error && <div className="error-bar">{error}</div>}

      <div className="tiles">
        <div className={`tile ${overview.configured && overview.discovery ? "" : "bad"}`}>
          <div className="label">provider</div>
          <div className="value">{!overview.configured ? "not set up" : overview.discovery ? "reachable" : "unreachable"}</div>
        </div>
        <div className="tile">
          <div className="label">sign-ins (recent)</div>
          <div className="value">{fmt(overview.signIns.length)}</div>
        </div>
        <div className={`tile ${failed ? "bad" : ""}`}>
          <div className="label">refused</div>
          <div className="value">{fmt(failed)}</div>
        </div>
      </div>
      {overview.discoveryError && <div className="error-bar">{overview.discoveryError}</div>}

      {overview.configured && overview.discovery && (
        <section className="panel">
          <div className="section-heading">
            <h2>Sign-in link</h2>
            <span className="muted">give this to developers, or put it on your wiki</span>
          </div>
          <div className="created">
            <code className="secret">{startUrl}</code>
            <div className="row">
              <CopyButton text={startUrl} label="copy link" />
              <a className="button" href={startUrl} target="_blank" rel="noreferrer">
                try it
              </a>
            </div>
          </div>
          <div className="hint">
            Register <code>{callbackUrl}</code> as the redirect URI at the provider. Each sign-in mints a fresh key for the person's email and revokes the previous one, so it also works to recover a lost key.
          </div>
        </section>
      )}

      <form className="panel" onSubmit={save}>
        <div className="section-heading">
          <h2>Identity provider</h2>
          <span className={`pill-s ${overview.discovery ? "ok" : ""}`}>{overview.discovery ? overview.discovery.issuer : "OpenID Connect"}</span>
        </div>
        <div className="config-fields">
          <label className="config-field">
            <span>issuer URL (has /.well-known/openid-configuration)</span>
            <input value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} placeholder="https://login.microsoftonline.com/<tenant>/v2.0" spellCheck={false} />
          </label>
          <label className="config-field">
            <span>client id</span>
            <input value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} spellCheck={false} autoComplete="off" />
          </label>
          <label className="config-field">
            <span>client secret {overview.settings.clientSecretSet && <em className="muted">(set; leave blank to keep)</em>}</span>
            <input type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} autoComplete="new-password" />
          </label>
          <label className="config-field">
            <span>scopes</span>
            <input value={form.scopes} onChange={(e) => setForm({ ...form, scopes: e.target.value })} placeholder="openid email profile" spellCheck={false} />
          </label>
          <label className="config-field">
            <span>allowed email domains (comma-separated; blank: anyone the provider vouches for)</span>
            <input value={form.allowedDomains} onChange={(e) => setForm({ ...form, allowedDomains: e.target.value })} placeholder="example.com, example.co.uk" spellCheck={false} />
          </label>
          <label className="config-field">
            <span>admin emails (get an admin key)</span>
            <input value={form.adminEmails} onChange={(e) => setForm({ ...form, adminEmails: e.target.value })} placeholder="you@example.com" spellCheck={false} />
          </label>
          <label className="config-field">
            <span>public URL of this gateway (blank: taken from the request)</span>
            <input value={form.publicUrl} onChange={(e) => setForm({ ...form, publicUrl: e.target.value })} placeholder={window.location.origin} spellCheck={false} />
          </label>
          <label className="config-field">
            <span>claim that names the key</span>
            <select value={form.nameClaim} onChange={(e) => setForm({ ...form, nameClaim: e.target.value })}>
              <option value="email">email</option>
              <option value="preferred_username">preferred_username</option>
              <option value="upn">upn</option>
            </select>
          </label>
        </div>
        <div className="row-actions" style={{ marginTop: 16 }}>
          <button type="submit" className="primary" disabled={busy !== null}>
            {busy === "save" ? "…" : "save"}
          </button>
          <button type="button" className="ghost" disabled={busy !== null || !overview.configured} onClick={() => void run("check", () => api(`${base}/check`, apiKey, { method: "POST" }), "The provider answered: discovery and keys read.")}>
            {busy === "check" ? "…" : "test provider"}
          </button>
          <span className="muted">
            Make a confidential web application at the provider with the redirect URI above; grant it the openid, email and profile scopes. Secrets stay on this server.
          </span>
        </div>
      </form>

      <section className="panel">
        <div className="section-heading">
          <h2>
            Recent sign-ins
            <span className="count">{fmt(overview.signIns.length)}</span>
          </h2>
        </div>
        {overview.signIns.length === 0 ? (
          <div className="empty">Nobody has signed in yet.</div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>when</th>
                  <th>who</th>
                  <th>result</th>
                  <th>from</th>
                </tr>
              </thead>
              <tbody>
                {overview.signIns.map((s, i) => (
                  <tr key={`${s.at}-${i}`}>
                    <td className="muted" title={s.at}>
                      {timeAgo(s.at)}
                    </td>
                    <td className="entity-name">
                      {s.name}
                      {s.admin && <span className="tag admin">admin</span>}
                    </td>
                    <td>
                      <span className={`pill-s ${s.ok ? "ok" : "bad"}`} title={s.error}>
                        {s.ok ? "key issued" : s.error ?? "refused"}
                      </span>
                    </td>
                    <td className="muted">{s.from ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}

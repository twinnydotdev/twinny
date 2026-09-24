/**
 * The Plan page: which plan the gateway is on, how many seats are in use,
 * what the licence switches on, and installing or replacing the token.
 */
import React, { useState } from "react"

import { fmt, plural } from "./format"
import type { PlanSummary } from "./people"

const DOCS_LICENSING = "https://docs.twinny.dev/teams/licensing/"
/** Stripe Payment Link for the Team plan: yearly, quantity is seats. */
const BUY_SEATS = "https://buy.stripe.com/eVq00igUndD80qW6AR7Zu00"

const PLAN_LABEL: Record<PlanSummary["status"], string> = {
  free: "Free plan",
  licensed: "Licensed",
  expiring: "Licensed, expiring soon",
  grace: "Licence expired, in grace period",
  expired: "Free plan (licence expired)",
  invalid: "Free plan (licence not usable)"
}

const daysUntil = (iso: string): number => Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000)

interface PlanPageProps {
  plan: PlanSummary
  onInstall: (token: string) => Promise<void>
  onRemove: () => Promise<void>
  onNavigate: (view: "people") => void
}

export const PlanPage = ({ plan, onInstall, onRemove, onNavigate }: PlanPageProps) => {
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [confirming, setConfirming] = useState(false)
  const attention = plan.status !== "free" && plan.status !== "licensed"
  const seatsBad = plan.used > plan.seats
  const hasLicense = !!plan.licenseId || plan.status === "invalid"
  const share = Math.min(100, Math.round((plan.used / Math.max(1, plan.seats)) * 100))
  const left = daysUntil(plan.expiresAt ?? "")

  const run = async (action: () => Promise<void>, done: string) => {
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      await action()
      setToken("")
      setConfirming(false)
      setNotice(done)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="page-title">
        <h2>Plan &amp; licence</h2>
        <p>Seats are active keys. A licence raises the limit and switches on team features.</p>
      </div>
      {notice && <div className="success-bar">{notice}</div>}
      {error && <div className="error-bar">{error}</div>}

      <div>
        <section className={`panel plan ${attention || seatsBad ? "attention" : ""}`}>
          <div className="section-heading">
            <h2>Plan</h2>
            <span className={`pill-s ${attention || seatsBad ? "bad" : "ok"}`}>{PLAN_LABEL[plan.status]}</span>
          </div>
          <div className="plan-headline">
            {plan.org ? plan.org : "Free plan"}
            {plan.expiresAt && (
              <span className={`muted ${left < 30 ? "revoked" : ""}`}>
                {" "}
                · {left < 0 ? `expired ${plural(-left, "day")} ago` : left === 0 ? "expires today" : `${plural(left, "day")} left`}
              </span>
            )}
          </div>
          <p className={attention ? "plan-note attention" : "plan-note"}>{plan.message}</p>
          <div className="meter-row">
            <span className="meter-label">
              <b>{fmt(plan.used)}</b> of <b>{fmt(plan.seats)}</b> seats used
            </span>
            <span className={`meter ${seatsBad ? "bad" : share >= 90 ? "warn" : ""}`}>
              <span className="meter-fill" style={{ width: `${share}%` }} />
            </span>
            <button type="button" className="link" onClick={() => onNavigate("people")}>
              people
            </button>
          </div>
          {plan.unseated.length > 0 && (
            <p className="plan-note attention">
              No seat, refused until seats are added or keys revoked: {plan.unseated.join(", ")}.
            </p>
          )}
          <dl className="facts">
            {plan.licenseId && (
              <>
                <dt>Licence</dt>
                <dd className="mono">{plan.licenseId}</dd>
              </>
            )}
            {plan.expiresAt && (
              <>
                <dt>Valid until</dt>
                <dd>{plan.expiresAt.slice(0, 10)}</dd>
              </>
            )}
            {plan.email && (
              <>
                <dt>Contact</dt>
                <dd>{plan.email}</dd>
              </>
            )}
            {!hasLicense && (
              <>
                <dt>Includes</dt>
                <dd>{plural(plan.seats, "seat")}, every model and provider, usage reporting, sign-in approval</dd>
              </>
            )}
          </dl>
        </section>

      </div>

      <section className="panel">
        <div className="section-heading">
          <h2>{hasLicense ? "Replace the licence" : "Install a licence"}</h2>
          <span className="muted">One token, signed by Twinny</span>
        </div>
        <form
          className="newkey"
          onSubmit={(e) => {
            e.preventDefault()
            if (token.trim()) void run(() => onInstall(token.trim()), "Licence installed. Seats and features apply at once.")
          }}
        >
          <input placeholder="paste a licence token (twl1.…)" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Licence token" disabled={busy} spellCheck={false} />
          <button type="submit" className="primary" disabled={busy || !token.trim()}>
            {busy ? "…" : hasLicense ? "replace licence" : "install licence"}
          </button>
          {hasLicense &&
            (confirming ? (
              <>
                <button type="button" className="danger" disabled={busy} onClick={() => void run(onRemove, "Licence removed. The gateway is on the free plan.")}>
                  remove licence
                </button>
                <button type="button" className="ghost" onClick={() => setConfirming(false)}>
                  keep
                </button>
              </>
            ) : (
              <button type="button" className="ghost" disabled={busy} onClick={() => setConfirming(true)}>
                remove
              </button>
            ))}
        </form>
        <div className="hint">
          {hasLicense ? (
            <>
              Replacing takes effect immediately; removing drops the gateway to the free plan and keys beyond its
              seats are refused. See{" "}
              <a href={DOCS_LICENSING} target="_blank" rel="noreferrer">
                Teams and licensing
              </a>
              {plan.email ? <> or contact {plan.email}</> : null}.
            </>
          ) : (
            <>
              Need more seats or the team features?{" "}
              <a href={BUY_SEATS} target="_blank" rel="noreferrer">
                Buy seats
              </a>{" "}
              by card; the token appears as soon as payment clears and is emailed to you. Paste it above. See{" "}
              <a href={DOCS_LICENSING} target="_blank" rel="noreferrer">
                Teams and licensing
              </a>{" "}
              for the plans.
            </>
          )}
        </div>
      </section>
    </>
  )
}

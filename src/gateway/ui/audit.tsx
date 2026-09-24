/**
 * The audit log: who changed what, newest first, with the chain's verdict
 * and an export. Filters by actor and by action prefix.
 */
import React, { useCallback, useEffect, useState } from "react"

import { messageOf } from "../../common/errors"
import type { AuditEntry, AuditVerification } from "../audit"

import { api } from "./api"
import { fmt, timeAgo, whenExact } from "./format"

interface Answer {
  entries: AuditEntry[]
  verification: AuditVerification
}

const ACTIONS = ["", "key.", "invite.", "signin.", "config.", "license.", "plugin."]
const LABELS: Record<string, string> = { "": "everything", "key.": "keys", "invite.": "invites", "signin.": "sign-ins", "config.": "configuration", "license.": "licence", "plugin.": "plugins" }

export const AuditPage = ({ apiKey }: { apiKey: string }) => {
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [action, setAction] = useState("")
  const [actor, setActor] = useState("")
  const [since, setSince] = useState("30d")

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({ since, limit: "500" })
      if (action) query.set("action", action)
      if (actor.trim()) query.set("actor", actor.trim())
      setAnswer(await api<Answer>(`/twinny/v1/admin/audit?${query.toString()}`, apiKey))
      setError(undefined)
    } catch (e) {
      setError(messageOf(e))
    }
  }, [apiKey, action, actor, since])

  useEffect(() => {
    void load()
  }, [load])

  const exportLog = async () => {
    const response = await fetch("/twinny/v1/admin/audit/export", { headers: { Authorization: `Bearer ${apiKey}` } })
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "twinny-audit.jsonl"
    a.click()
    URL.revokeObjectURL(url)
  }

  const details = (entry: AuditEntry) =>
    Object.entries(entry.details ?? {})
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ")

  return (
    <>
      <div className="page-title">
        <h2>Audit log</h2>
        <p>Who changed what on this gateway. Each line carries the hash of the one before it, so a gap or an edit shows.</p>
      </div>
      {error && <div className="error-bar">{error}</div>}
      {answer && (
        <div className="tiles">
          <div className="tile">
            <div className="label">entries shown</div>
            <div className="value">{fmt(answer.entries.length)}</div>
          </div>
          <div className="tile">
            <div className="label">entries kept</div>
            <div className="value">{fmt(answer.verification.entries)}</div>
          </div>
          <div className={`tile ${answer.verification.ok ? "" : "bad"}`}>
            <div className="label">chain</div>
            <div className="value">{answer.verification.ok ? "intact" : "broken"}</div>
          </div>
        </div>
      )}
      {answer && !answer.verification.ok && answer.verification.brokenAt && (
        <div className="error-bar">
          The chain breaks in {answer.verification.brokenAt.file} at line {fmt(answer.verification.brokenAt.line)}: {answer.verification.brokenAt.reason}. Everything before it is intact.
        </div>
      )}
      <section className="panel">
        <div className="toolbar">
          <span className="chips" role="group" aria-label="Period">
            {["24h", "7d", "30d", "365d"].map((p) => (
              <button key={p} type="button" className={since === p ? "on" : ""} onClick={() => setSince(p)}>
                {p}
              </button>
            ))}
          </span>
          <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action">
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {LABELS[a]}
              </option>
            ))}
          </select>
          <input type="search" className="search" placeholder="actor (key name)" value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Actor" />
          <button type="button" className="ghost mini" onClick={() => void exportLog()}>
            export
          </button>
        </div>
        {!answer ? (
          <div className="loading">Loading…</div>
        ) : answer.entries.length === 0 ? (
          <div className="empty">Nothing in this period.</div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>when</th>
                  <th>actor</th>
                  <th>action</th>
                  <th>target</th>
                  <th>details</th>
                  <th>from</th>
                </tr>
              </thead>
              <tbody>
                {answer.entries.map((entry, i) => (
                  <tr key={`${entry.ts}-${i}`}>
                    <td className="muted" title={whenExact(entry.ts)}>
                      {timeAgo(entry.ts)}
                    </td>
                    <td className="entity-name">{entry.actor}</td>
                    <td>
                      <span className="tag">{entry.action}</span>
                    </td>
                    <td>{entry.target ?? ""}</td>
                    <td className="muted">{details(entry)}</td>
                    <td className="muted">{entry.from ?? ""}</td>
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

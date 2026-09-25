/**
 * The page of a notifier plugin (Slack, Discord, Teams): the webhooks
 * (one per channel) and what each gets, a test button, and the recent
 * deliveries with their outcome.
 */
import React, { FormEvent, useCallback, useEffect, useState } from "react"

import { messageOf } from "../../common/errors"
import type { PluginEventKind } from "../plugins/events"
import type { Delivery, WebhookView } from "../plugins/notify"

import { api } from "./api"
import { fmt, timeAgo } from "./format"
import { PageSkeleton, PluginIcon } from "./plugins"

interface Overview {
  webhooks: WebhookView[]
  kinds: PluginEventKind[]
  deliveries: Delivery[]
  health: boolean
  backends: Array<{ provider: string; ok: boolean }>
  urlExample: string
}

export type NotifyHostId = "slack" | "discord" | "teams"

const NAMES: Record<NotifyHostId, string> = { slack: "Slack", discord: "Discord", teams: "Microsoft Teams" }
const HOW: Record<NotifyHostId, string> = {
  slack: "In Slack: Apps → Incoming Webhooks → add to a channel, copy the URL. Mattermost: Integrations → Incoming Webhooks.",
  discord: "In Discord: Server settings → Integrations → Webhooks → New webhook, pick the channel, copy the URL.",
  teams: "In Teams: the channel's ⋯ → Workflows → \"Post to a channel when a webhook request is received\", copy the URL. An older Incoming Webhook connector works too."
}

const EventPicker = ({ kinds, value, onChange, disabled }: { kinds: PluginEventKind[]; value: string[]; onChange: (events: string[]) => void; disabled?: boolean }) => (
  <div className="event-picker">
    {kinds.map((kind) => {
      const on = value.includes(kind.type)
      return (
        <label key={kind.type} className={`policy-option ${on ? "on" : ""}`} title={kind.description}>
          <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked ? [...value, kind.type] : value.filter((entry) => entry !== kind.type))} />
          <span>
            <b>{kind.label}</b>
            <small>{kind.description}</small>
          </span>
        </label>
      )
    })}
  </div>
)

export const NotifyPanel = ({ host, apiKey }: { host: NotifyHostId; apiKey: string }) => {
  const base = `/twinny/v1/admin/plugins/${host}/api`
  const name = NAMES[host]
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [hookName, setHookName] = useState("")
  const [url, setUrl] = useState("")
  const [events, setEvents] = useState<string[]>([])

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
    void load().then((answer) => {
      if (answer && events.length === 0 && editing === null) setEvents(answer.kinds.map((kind) => kind.type))
    })
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load()
    }, 30_000)
    return () => clearInterval(timer)
  }, [load])

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

  const reset = (kinds: PluginEventKind[]) => {
    setEditing(null)
    setHookName("")
    setUrl("")
    setEvents(kinds.map((kind) => kind.type))
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!overview) return
    if (editing) {
      void run("save", () => api(`${base}/webhooks/${editing}`, apiKey, { method: "PUT", body: { name: hookName, ...(url.trim() ? { url } : {}), events } }).then(() => reset(overview.kinds)), "Webhook saved.")
    } else {
      void run("save", () => api(`${base}/webhooks`, apiKey, { method: "POST", body: { name: hookName, url, events } }).then(() => reset(overview.kinds)), "Webhook added. Send a test to see it in the channel.")
    }
  }

  if (!overview)
    return error ? (
      <div className="error-bar">{error}</div>
    ) : (
      <PageSkeleton
        tiles={4}
        rows={3}
        title={
          <h2 className="plugin-name">
            <PluginIcon id={host} size={22} />
            {name}
          </h2>
        }
      />
    )

  const failed = overview.deliveries.filter((delivery) => !delivery.ok).length
  const labelOf = (type: string) => overview.kinds.find((kind) => kind.type === type)?.label ?? type
  const down = overview.backends.filter((backend) => !backend.ok)

  return (
    <>
      <div className="page-title">
        <h2 className="plugin-name">
          <PluginIcon id={host} size={22} />
          {name}
        </h2>
        <p>Reviews, new pulls, failing checks, backups and backend outages, posted to the channels you choose.</p>
      </div>
      {notice && <div className="success-bar">{notice}</div>}
      {error && <div className="error-bar">{error}</div>}

      <div className="tiles">
        <div className="tile">
          <div className="label">webhooks</div>
          <div className="value">{fmt(overview.webhooks.length)}</div>
        </div>
        <div className="tile">
          <div className="label">sent recently</div>
          <div className="value">{fmt(overview.deliveries.length)}</div>
        </div>
        <div className={`tile ${failed ? "bad" : ""}`}>
          <div className="label">failed</div>
          <div className="value">{fmt(failed)}</div>
        </div>
        <div className={`tile ${down.length ? "bad" : ""}`}>
          <div className="label">backends watched</div>
          <div className="value">
            {overview.health ? fmt(overview.backends.length) : "–"}
            {down.length > 0 && <small>{down.map((backend) => backend.provider).join(", ")} down</small>}
          </div>
        </div>
      </div>

      <section className="panel">
        <div className="section-heading">
          <h2>
            Webhooks
            <span className="count">{fmt(overview.webhooks.length)}</span>
          </h2>
        </div>
        {overview.webhooks.length === 0 ? (
          <div className="empty">No channel yet. Add one below with an incoming webhook URL.</div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>channel</th>
                  <th>sends</th>
                  <th>to</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {overview.webhooks.map((webhook) => (
                  <tr key={webhook.id}>
                    <td className="entity-name">{webhook.name}</td>
                    <td>
                      {webhook.events.length === overview.kinds.length ? (
                        <span className="muted">everything</span>
                      ) : webhook.events.length === 0 ? (
                        <span className="muted">nothing</span>
                      ) : (
                        webhook.events.map((event) => (
                          <span key={event} className="tag">
                            {labelOf(event)}
                          </span>
                        ))
                      )}
                    </td>
                    <td className="muted">{webhook.host}</td>
                    <td className="actions">
                      <button type="button" className="ghost mini" disabled={busy !== null} onClick={() => void run(`test:${webhook.id}`, () => api(`${base}/webhooks/${webhook.id}/test`, apiKey, { method: "POST" }), `Sent a test to ${webhook.name}.`)}>
                        {busy === `test:${webhook.id}` ? "…" : "test"}
                      </button>{" "}
                      <button
                        type="button"
                        className="ghost mini"
                        disabled={busy !== null}
                        onClick={() => {
                          setEditing(webhook.id)
                          setHookName(webhook.name)
                          setUrl("")
                          setEvents(webhook.events)
                        }}
                      >
                        edit
                      </button>{" "}
                      {confirm === webhook.id ? (
                        <>
                          <button type="button" className="danger mini" disabled={busy !== null} onClick={() => void run(`remove:${webhook.id}`, () => api(`${base}/webhooks/${webhook.id}`, apiKey, { method: "DELETE" }).then(() => setConfirm(null)))}>
                            remove
                          </button>{" "}
                          <button type="button" className="ghost mini" onClick={() => setConfirm(null)}>
                            keep
                          </button>
                        </>
                      ) : (
                        <button type="button" className="ghost mini" disabled={busy !== null} onClick={() => setConfirm(webhook.id)}>
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

        <form className="create-form" onSubmit={submit}>
          <div className="config-fields">
            <label className="config-field">
              <span>channel name</span>
              <input value={hookName} onChange={(e) => setHookName(e.target.value)} placeholder={host === "discord" ? "#deploys" : "#eng-reviews"} disabled={busy !== null} />
            </label>
            <label className="config-field">
              <span>incoming webhook URL {editing && <em className="muted">(leave blank to keep)</em>}</span>
              <input type="password" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={overview.urlExample} disabled={busy !== null} autoComplete="off" spellCheck={false} />
            </label>
          </div>
          <EventPicker kinds={overview.kinds} value={events} onChange={setEvents} disabled={busy !== null} />
          <div className="row-actions">
            <button type="submit" className="primary" disabled={busy !== null || !hookName.trim() || (!editing && !url.trim())}>
              {busy === "save" ? "…" : editing ? "save webhook" : "add webhook"}
            </button>
            {editing && (
              <button type="button" className="ghost" onClick={() => reset(overview.kinds)}>
                cancel
              </button>
            )}
            <span className="muted">{HOW[host]} The URL is kept on this server and never shown again.</span>
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>
            Recent deliveries
            <span className="count">{fmt(overview.deliveries.length)}</span>
          </h2>
        </div>
        {overview.deliveries.length === 0 ? (
          <div className="empty">Nothing sent yet.</div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>when</th>
                  <th>channel</th>
                  <th>event</th>
                  <th>message</th>
                  <th>result</th>
                </tr>
              </thead>
              <tbody>
                {overview.deliveries.map((delivery, i) => (
                  <tr key={`${delivery.at}-${i}`}>
                    <td className="muted" title={delivery.at}>
                      {timeAgo(delivery.at)}
                    </td>
                    <td>{delivery.webhook}</td>
                    <td>
                      <span className="tag">{labelOf(delivery.event)}</span>
                    </td>
                    <td>{delivery.title}</td>
                    <td>
                      <span className={`pill-s ${delivery.ok ? "ok" : "bad"}`} title={delivery.error}>
                        {delivery.ok ? `sent in ${fmt(delivery.ms)} ms` : delivery.error ?? "failed"}
                      </span>
                    </td>
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

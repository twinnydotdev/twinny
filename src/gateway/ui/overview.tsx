/**
 * The Overview: is the gateway healthy, how busy is it, who and what is
 * busiest, and whether every backend answers. Everything here is a
 * summary that links to the tab with the detail.
 */
import React from "react"

import type { RemoteStatus } from "../../protocol/types"
import type { UsageSummary, UsageTotals } from "../usage"

import { compact, duration, fmt, pct, plural } from "./format"
import type { KeysResponse } from "./people"

export interface Series {
  name: string
  color: string
}

export const OTHER = "var(--other)"

const dayList = (since: string, until: string): string[] => {
  const days: string[] = []
  const end = new Date(until.slice(0, 10) + "T00:00:00Z").getTime()
  for (
    let t = new Date(since.slice(0, 10) + "T00:00:00Z").getTime();
    t <= end;
    t += 86_400_000
  ) {
    days.push(new Date(t).toISOString().slice(0, 10))
  }
  return days
}

/** Requests per day, stacked by key, with the long tail folded into "other". */
export const RequestsChart = ({
  summary,
  series
}: {
  summary: UsageSummary
  series: Series[]
}) => {
  const days = dayList(String(summary.since), String(summary.until))
  const byDay = new Map(summary.byDay.map((d) => [d.day, d]))
  const named = new Set(series.map((s) => s.name))
  const columns = days.map((day) => {
    const entry = byDay.get(day)
    const counts = series.map((s) => entry?.byKey[s.name] ?? 0)
    const other = entry
      ? Object.entries(entry.byKey)
          .filter(([name]) => !named.has(name))
          .reduce((sum, [, n]) => sum + n, 0)
      : 0
    return { day, counts, other, total: entry?.requests ?? 0 }
  })
  const max = Math.max(1, ...columns.map((c) => c.total))
  const width = 900
  const height = 180
  const left = 36
  const bottom = 22
  const top = 14
  const plotW = width - left - 8
  const plotH = height - top - bottom
  const slot = plotW / columns.length
  const barW = Math.max(4, Math.min(28, slot * 0.6))
  const y = (v: number) => top + plotH - (v / max) * plotH
  const ticks = [0, Math.round(max / 2), max]
  const labelEvery = Math.ceil(columns.length / 10)
  const showTotals = columns.length <= 14
  const hasOther = columns.some((c) => c.other > 0)

  if (!summary.total.requests)
    return <div className="empty">No requests in this period.</div>

  return (
    <>
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Requests per day by key"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              className="grid"
              x1={left}
              x2={width - 8}
              y1={y(t)}
              y2={y(t)}
            />
            <text x={left - 6} y={y(t) + 3} textAnchor="end">
              {fmt(t)}
            </text>
          </g>
        ))}
        {columns.map((c, i) => {
          const x = left + i * slot + (slot - barW) / 2
          let acc = 0
          const segments = [
            ...c.counts.map((n, k) => ({
              n,
              color: series[k].color,
              name: series[k].name
            })),
            { n: c.other, color: OTHER, name: "other" }
          ]
          return (
            <g key={c.day}>
              {segments.map((seg) => {
                if (!seg.n) return null
                const y1 = y(acc + seg.n)
                const h = y(acc) - y1
                acc += seg.n
                return (
                  <rect
                    key={seg.name}
                    className="seg"
                    x={x}
                    y={y1}
                    width={barW}
                    height={h}
                    rx={acc === c.total ? 3 : 0}
                    fill={seg.color}
                  >
                    <title>{`${c.day} · ${seg.name}: ${fmt(seg.n)} of ${fmt(c.total)}`}</title>
                  </rect>
                )
              })}
              {showTotals && c.total > 0 && (
                <text
                  className="label"
                  x={x + barW / 2}
                  y={y(c.total) - 4}
                  textAnchor="middle"
                >
                  {fmt(c.total)}
                </text>
              )}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={height - 6} textAnchor="middle">
                  {c.day.slice(5)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div className="legend">
        {series.map((s) => (
          <span key={s.name}>
            <i style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
        {hasOther && (
          <span>
            <i style={{ background: OTHER }} />
            other
          </span>
        )}
      </div>
    </>
  )
}

/** A ranked list of names with a bar for each one's share of the whole. */
export const Bars = ({
  rows,
  whole,
  colorOf,
  limit = 8,
  emptyText,
  right
}: {
  rows: Array<{ name: string; totals: UsageTotals; note?: React.ReactNode }>
  whole: number
  colorOf?: (name: string) => string
  limit?: number
  emptyText: string
  right?: (t: UsageTotals) => React.ReactNode
}) => {
  const sorted = [...rows].sort(
    (a, b) =>
      b.totals.requests - a.totals.requests || a.name.localeCompare(b.name)
  )
  const shown = sorted.slice(0, limit)
  const rest = sorted.slice(limit)
  const max = Math.max(1, ...shown.map((r) => r.totals.requests))
  if (!shown.length) return <div className="empty">{emptyText}</div>
  return (
    <div className="bars">
      {shown.map((r) => (
        <div
          key={r.name}
          className="bar-row"
          title={`${fmt(r.totals.requests)} of ${fmt(whole)} requests`}
        >
          <span className="bar-name">
            {colorOf && (
              <i className="dot" style={{ background: colorOf(r.name) }} />
            )}
            {r.name}
            {r.note}
          </span>
          <span className="bar-track">
            <span
              className="bar-fill"
              style={{
                width: `${(r.totals.requests / max) * 100}%`,
                background: colorOf ? colorOf(r.name) : "var(--accent)"
              }}
            />
          </span>
          <span className="bar-value">
            {right ? right(r.totals) : fmt(r.totals.requests)}
            <span className="muted"> · {pct(r.totals.requests, whole)}</span>
          </span>
        </div>
      ))}
      {rest.length > 0 && (
        <div className="bar-row muted">
          <span className="bar-name">{plural(rest.length, "more")}</span>
          <span className="bar-track" />
          <span className="bar-value">
            {fmt(rest.reduce((n, r) => n + r.totals.requests, 0))}
          </span>
        </div>
      )}
    </div>
  )
}

interface OverviewPageProps {
  status: RemoteStatus
  usage: UsageSummary
  keys: KeysResponse
  period: string
  series: Series[]
  colorOf: (name: string) => string
  onNavigate: (view: "usage" | "people" | "models" | "plan") => void
}

export const OverviewPage = ({
  status,
  usage,
  keys,
  period,
  series,
  colorOf,
  onNavigate
}: OverviewPageProps) => {
  const total = usage.total
  const activeKeys = keys.keys.filter((k) => !k.revokedAt)
  const busyKeys = Object.entries(usage.byKey).filter(
    ([, t]) => t.requests > 0
  ).length
  const down = status.backends.filter((b) => !b.ok)
  const days = Math.max(1, usage.byDay.length)
  const modelOk = new Map(status.models.map((m) => [m.id, m.ok]))
  const successRate = total.requests
    ? Math.round((total.ok / total.requests) * 100)
    : null

  return (
    <>
      <div className="page-title">
        <h2>Overview</h2>
        <p>The last {period}, and whether the backends answer right now.</p>
      </div>
      {down.length > 0 && (
        <div className="error-bar">
          {down.length === 1
            ? "A backend is down"
            : `${down.length} backends are down`}
          :{" "}
          {down
            .map((b) => `${b.provider} (${b.kind ?? "unreachable"})`)
            .join(", ")}
          . Requests routed to
          {down.length === 1 ? " it " : " them "}fail until it answers.{" "}
          <button
            type="button"
            className="link"
            onClick={() => onNavigate("models")}
          >
            Check the provider
          </button>
          .
        </div>
      )}
      <section className="tiles">
        <div className="tile">
          <div className="label">Requests</div>
          <div className="value">{fmt(total.requests)}</div>
          <div className="sub">
            {total.requests
              ? `${fmt(Math.round(total.requests / days))} a day on average`
              : "none in this period"}
            {total.indexing.runs
              ? ` · ${plural(total.indexing.runs, "indexing run")}`
              : ""}
          </div>
        </div>
        <div
          className={`tile ${successRate !== null && successRate < 90 ? "bad" : ""}`}
        >
          <div className="label">Succeeded</div>
          <div className="value">
            {successRate === null ? "–" : `${successRate}%`}
          </div>
          <div className="sub">
            {total.failed ? (
              <span className="revoked">{fmt(total.failed)} failed</span>
            ) : (
              "none failed"
            )}
            {total.cancelled ? ` · ${fmt(total.cancelled)} cancelled` : ""}
          </div>
        </div>
        <div className="tile">
          <div className="label">Developers active</div>
          <div className="value">
            {fmt(busyKeys)}
            <small>of {fmt(activeKeys.length)}</small>
          </div>
          <div className="sub">
            <button
              type="button"
              className="link"
              onClick={() => onNavigate("people")}
            >
              {activeKeys.length === busyKeys
                ? "everyone with a key"
                : `${fmt(activeKeys.length - busyKeys)} idle`}
            </button>
          </div>
        </div>
        <div className="tile">
          <div className="label">Tokens</div>
          <div className="value">
            {total.counted ? (
              <>
                {compact(total.promptTokens)}
                <small>→ {compact(total.completionTokens)}</small>
              </>
            ) : (
              "–"
            )}
          </div>
          <div className="sub">
            {total.counted
              ? `prompt → output · counted on ${pct(total.counted, total.requests)}`
              : "backends reported no counts"}
          </div>
        </div>
        <div className="tile">
          <div className="label">Avg latency</div>
          <div className="value">
            {total.requests ? duration(total.ms / total.requests) : "–"}
          </div>
          <div className="sub">
            {status.backends.length === 1
              ? `${status.backends[0].provider} answers in ${duration(status.backends[0].ms)}`
              : status.backends.length
                ? `backends answer in ${duration(Math.min(...status.backends.map((b) => b.ms)))} to ${duration(Math.max(...status.backends.map((b) => b.ms)))}`
                : "no backends configured"}
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>Requests per day</h2>
        <RequestsChart summary={usage} series={series} />
      </section>

      <div className="grid-2">
        <section className="panel">
          <div className="section-heading">
            <h2>Developers</h2>
            <span className="links">
              {activeKeys.every((k) => k.admin) && (
                <button type="button" className="link" onClick={() => onNavigate("people")}>
                  invite people
                </button>
              )}
              <button
                type="button"
                className="link"
                onClick={() => onNavigate("usage")}
              >
                full usage
              </button>
            </span>
          </div>
          <Bars
            rows={Object.entries(usage.byKey).map(([name, totals]) => ({
              name,
              totals
            }))}
            whole={total.requests}
            colorOf={colorOf}
            emptyText="No one has made a request in this period."
          />
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>Models</h2>
            <button
              type="button"
              className="link"
              onClick={() => onNavigate("models")}
            >
              providers &amp; models
            </button>
          </div>
          <Bars
            rows={Object.entries(usage.byModel).map(([name, totals]) => ({
              name,
              totals,
              note: modelOk.has(name) ? (
                <i
                  className={`status-dot ${modelOk.get(name) ? "ok" : "bad"}`}
                  title={modelOk.get(name) ? "answering" : "down"}
                />
              ) : undefined
            }))}
            whole={total.requests}
            emptyText="No model has served a request in this period."
          />
        </section>
      </div>

      <section className="panel">
        <div className="section-heading">
          <h2>Backends</h2>
          <span className="muted">Checked live when this page loads</span>
        </div>
        {!status.backends.length ? (
          <div className="empty">
            No providers configured.{" "}
            <button
              type="button"
              className="link"
              onClick={() => onNavigate("models")}
            >
              Add one
            </button>
            .
          </div>
        ) : (
          <div className="backends">
            {status.backends.map((b) => {
              const models = status.models.filter(
                (m) => m.provider === b.provider
              )
              return (
                <div
                  key={b.provider}
                  className={`backend ${b.ok ? "" : "down"}`}
                >
                  <div className="backend-head">
                    <span className="entity-name">{b.provider}</span>
                    <span className={`pill-s ${b.ok ? "ok" : "bad"}`}>
                      {b.ok
                        ? `answering · ${duration(b.ms)}`
                        : `down · ${b.kind ?? "unreachable"}`}
                    </span>
                    {b.peers !== undefined && (
                      <span className="muted">
                        {plural(
                          b.peers,
                          "teammate's computer",
                          "teammates' computers"
                        )}{" "}
                        connected
                      </span>
                    )}
                  </div>
                  <div className="backend-models">
                    {models.length ? (
                      models.map((m) => (
                        <span
                          key={m.id}
                          className="tag"
                          title={m.ok ? "serving" : "not serving"}
                        >
                          <i className={`status-dot ${m.ok ? "ok" : "bad"}`} />
                          {m.id}
                          {usage.byModel[m.id] ? (
                            <span className="muted">
                              {"\u00a0· "}
                              {plural(usage.byModel[m.id].requests, "request")}
                            </span>
                          ) : null}
                        </span>
                      ))
                    ) : (
                      <span className="muted">no models use this provider</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </>
  )
}

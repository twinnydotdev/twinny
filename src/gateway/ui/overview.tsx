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
import { money } from "./usage"

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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
/** `2026-11-09` as "Nov 9". */
const shortDay = (day: string): string => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`
/** `2026-11-09` as "Mon, Nov 9". */
const longDay = (day: string): string => `${WEEKDAYS[new Date(day + "T00:00:00Z").getUTCDay()]}, ${shortDay(day)}`

/** A round number at or above `max`, so the axis reads 0, 50, 100 and not 0, 43, 87. */
const niceMax = (max: number): number => {
  if (max <= 4) return Math.max(2, Math.ceil(max / 2) * 2)
  const power = 10 ** Math.floor(Math.log10(max))
  const lead = max / power
  return (lead <= 1 ? 1 : lead <= 2 ? 2 : lead <= 2.5 ? 2.5 : lead <= 5 ? 5 : 10) * power
}

export type ChartMetric = "requests" | "tokens" | "failed"

const METRICS: Array<{ id: ChartMetric; label: string }> = [
  { id: "requests", label: "Requests" },
  { id: "tokens", label: "Tokens" },
  { id: "failed", label: "Failures" }
]

/**
 * One column per day. Requests are stacked by key, with the long tail
 * folded into "other"; tokens and failures are a single series. Pointing
 * at a day shows what is in it.
 */
export const RequestsChart = ({
  summary,
  series,
  metric = "requests"
}: {
  summary: UsageSummary
  series: Series[]
  metric?: ChartMetric
}) => {
  const [hover, setHover] = React.useState<number | null>(null)
  const days = dayList(String(summary.since), String(summary.until))
  const today = String(summary.until).slice(0, 10)
  const byDay = new Map(summary.byDay.map((d) => [d.day, d]))
  const named = new Set(series.map((s) => s.name))
  const columns = days.map((day) => {
    const entry = byDay.get(day)
    const requests = entry?.requests ?? 0
    const parts =
      metric === "requests"
        ? [
            ...series.map((s) => ({ name: s.name, color: s.color, n: entry?.byKey[s.name] ?? 0 })),
            {
              name: "other",
              color: OTHER,
              n: entry
                ? Object.entries(entry.byKey)
                    .filter(([name]) => !named.has(name))
                    .reduce((sum, [, n]) => sum + n, 0)
                : 0
            }
          ]
        : metric === "tokens"
          ? [{ name: "tokens", color: "var(--s6)", n: entry?.tokens ?? 0 }]
          : [{ name: "failed", color: "var(--bad)", n: entry?.failed ?? 0 }]
    return {
      day,
      parts,
      total: parts.reduce((sum, part) => sum + part.n, 0),
      requests,
      failed: entry?.failed ?? 0,
      tokens: entry?.tokens ?? 0,
      ms: entry?.ms ?? 0
    }
  })
  const max = niceMax(Math.max(1, ...columns.map((c) => c.total)))
  const width = 900
  const height = 220
  const left = 44
  const right = 8
  const bottom = 26
  const top = 12
  const plotW = width - left - right
  const plotH = height - top - bottom
  const slot = plotW / columns.length
  const barW = Math.max(3, Math.min(34, slot * 0.62))
  const y = (v: number) => top + plotH - (v / max) * plotH
  const ticks = [0, max / 4, max / 2, (max * 3) / 4, max]
  const labelEvery = Math.ceil(columns.length / 10)
  const axis = (v: number) => (metric === "tokens" ? compact(Math.round(v)) : fmt(Math.round(v)))
  const hasOther = metric === "requests" && columns.some((c) => c.parts[c.parts.length - 1].n > 0)

  if (!summary.total.requests)
    return <div className="empty">No requests in this period.</div>

  const shown = hover === null ? undefined : columns[hover]
  const tipAt = hover === null ? 0 : ((left + hover * slot + slot / 2) / width) * 100

  return (
    <>
      <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
        <svg
          className="chart"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={
            metric === "requests" ? "Requests per day by key" : metric === "tokens" ? "Tokens per day" : "Failed requests per day"
          }
        >
          {ticks.map((t, n) => (
            <g key={n}>
              <line className={n === 0 ? "grid base" : "grid"} x1={left} x2={width - right} y1={y(t)} y2={y(t)} />
              {n % 2 === 0 && (
                <text x={left - 8} y={y(t) + 4} textAnchor="end">
                  {axis(t)}
                </text>
              )}
            </g>
          ))}
          {columns.map((c, i) => {
            const x = left + i * slot + (slot - barW) / 2
            let acc = 0
            const live = c.parts.filter((part) => part.n > 0)
            return (
              <g key={c.day} className={hover === i ? "col on" : hover === null ? "col" : "col off"}>
                <rect className="band" x={left + i * slot} y={top} width={slot} height={plotH} />
                {live.map((part, k) => {
                  const y1 = y(acc + part.n)
                  const h = y(acc) - y1
                  acc += part.n
                  const last = k === live.length - 1
                  const r = Math.min(4, barW / 2, h)
                  // Only the top of the stack is rounded, and only at its top.
                  const d = last
                    ? `M${x},${y1 + h} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + barW - r} Q${x + barW},${y1} ${x + barW},${y1 + r} V${y1 + h} Z`
                    : `M${x},${y1 + h} V${y1} H${x + barW} V${y1 + h} Z`
                  return <path key={part.name} className="seg" d={d} fill={part.color} />
                })}
                {i % labelEvery === 0 && (
                  <text className={c.day === today ? "today" : undefined} x={x + barW / 2} y={height - 8} textAnchor="middle">
                    {c.day === today ? "today" : shortDay(c.day)}
                  </text>
                )}
                <rect
                  className="hit"
                  x={left + i * slot}
                  y={top}
                  width={slot}
                  height={plotH + bottom}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  tabIndex={0}
                  aria-label={`${longDay(c.day)}: ${plural(c.requests, "request")}, ${fmt(c.failed)} failed, ${compact(c.tokens)} tokens`}
                />
              </g>
            )
          })}
        </svg>
        {shown && (
          <div
            className={`chart-tip ${tipAt > 62 ? "left" : ""}`}
            style={tipAt > 62 ? { right: `${100 - tipAt}%` } : { left: `${tipAt}%` }}
            role="status"
          >
            <div className="chart-tip-day">
              {longDay(shown.day)}
              {shown.day === today && <span className="muted"> · so far</span>}
            </div>
            {metric === "requests" &&
              shown.parts
                .filter((part) => part.n > 0)
                .sort((a, b) => b.n - a.n)
                .map((part) => (
                  <div key={part.name} className="chart-tip-row">
                    <span>
                      <i style={{ background: part.color }} />
                      {part.name}
                    </span>
                    <b>{fmt(part.n)}</b>
                  </div>
                ))}
            <div className="chart-tip-row total">
              <span>Requests</span>
              <b>{fmt(shown.requests)}</b>
            </div>
            <div className="chart-tip-row">
              <span>Failed</span>
              <b className={shown.failed ? "revoked" : undefined}>
                {fmt(shown.failed)}
                {shown.requests > 0 && shown.failed > 0 && <span className="muted"> · {pct(shown.failed, shown.requests)}</span>}
              </b>
            </div>
            <div className="chart-tip-row">
              <span>Tokens</span>
              <b>{shown.tokens ? compact(shown.tokens) : "–"}</b>
            </div>
            <div className="chart-tip-row">
              <span>Avg latency</span>
              <b>{shown.requests ? duration(shown.ms / shown.requests) : "–"}</b>
            </div>
          </div>
        )}
      </div>
      {metric === "requests" && (
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
      )}
    </>
  )
}

/** A period's shape in a tile: one point per day, drawn as a line over a faint fill. */
const Spark = ({ values, tone = "accent" }: { values: Array<number | null>; tone?: "accent" | "bad" | "ink" }) => {
  const points = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null)
  if (points.length < 3) return null
  const w = 120
  const h = 32
  const lo = Math.min(...points.map((p) => p.v))
  const hi = Math.max(...points.map((p) => p.v))
  const span = hi - lo || 1
  const x = (i: number) => (values.length === 1 ? 0 : (i / (values.length - 1)) * w)
  const y = (v: number) => (hi === lo ? h / 2 : 3 + (1 - (v - lo) / span) * (h - 6))
  const line = points.map((p, n) => `${n ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")
  const area = `${line} L${x(points[points.length - 1].i).toFixed(1)},${h} L${x(points[0].i).toFixed(1)},${h} Z`
  return (
    <svg className={`spark ${tone}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path className="spark-area" d={area} />
      <path className="spark-line" d={line} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/**
 * How a number compares with the period before: an arrow and the change.
 * `better` says which direction is good news; without it the change is
 * just stated.
 */
const Delta = ({
  now,
  before,
  better,
  points = false,
  period
}: {
  now: number
  before: number | undefined
  better?: "up" | "down"
  /** The values are percentages: say the difference in points, not as a ratio. */
  points?: boolean
  period: string
}) => {
  if (before === undefined || !Number.isFinite(before) || !Number.isFinite(now)) return null
  if (!points && before <= 0) return null
  const change = points ? now - before : ((now - before) / before) * 100
  const size = Math.abs(change)
  if (size < 0.5) return <span className="delta" title={`Unchanged from the ${period} before`}>→ 0%</span>
  const up = change > 0
  const tone = !better ? "" : (better === "up") === up ? "good" : "bad"
  const text = points ? `${size.toFixed(size < 10 ? 1 : 0)} pt` : size >= 1000 ? `${Math.round(now / before)}×` : `${Math.round(size)}%`
  return (
    <span className={`delta ${tone}`} title={`Against the ${period} before`}>
      {up ? "↑" : "↓"} {text}
    </span>
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

const SPANS: Record<string, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" }

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
  const [metric, setMetric] = React.useState<ChartMetric>("requests")
  const prev = usage.previous
  const span = SPANS[period] ?? period
  // One point per calendar day of the period, quiet days included, so every tile's line shares an axis.
  const dayOf = new Map(usage.byDay.map((d) => [d.day, d]))
  const perDay = dayList(String(usage.since), String(usage.until)).map((day) => dayOf.get(day))
  const sparks = perDay.length >= 5

  return (
    <>
      <div className="page-title">
        <h2>Overview</h2>
        <p>The last {span}, and whether the backends answer right now.</p>
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
          <div className="tile-head">
            <span className="label">Requests</span>
            <Delta now={total.requests} before={prev?.requests} period={span} />
          </div>
          <div className="value">{fmt(total.requests)}</div>
          <div className="sub">
            {total.requests
              ? `${fmt(Math.round(total.requests / days))} a day on average`
              : "none in this period"}
            {total.indexing.runs
              ? ` · ${plural(total.indexing.runs, "indexing run")}`
              : ""}
          </div>
          {sparks && <Spark values={perDay.map((d) => d?.requests ?? 0)} />}
        </div>
        <div
          className={`tile ${successRate !== null && successRate < 90 ? "bad" : ""}`}
        >
          <div className="tile-head">
            <span className="label">Succeeded</span>
            {total.requests > 0 && prev && prev.requests > 0 && (
              <Delta
                now={(total.ok / total.requests) * 100}
                before={(prev.ok / prev.requests) * 100}
                better="up"
                points
                period={span}
              />
            )}
          </div>
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
          {sparks && (
            <Spark
              values={perDay.map((d) => (d && d.requests ? (1 - d.failed / d.requests) * 100 : null))}
              tone={total.failed ? "bad" : "accent"}
            />
          )}
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="label">Developers active</span>
          </div>
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
              {activeKeys.length <= busyKeys
                ? "everyone with a key"
                : `${fmt(activeKeys.length - busyKeys)} idle`}
            </button>
          </div>
          {sparks && (
            <Spark values={perDay.map((d) => (d ? Object.values(d.byKey).filter((n) => n > 0).length : 0))} tone="ink" />
          )}
        </div>
        <div className="tile">
          <div className="tile-head">
            <span className="label">Tokens</span>
            {total.counted > 0 && (
              <Delta
                now={total.promptTokens + total.completionTokens}
                before={prev ? prev.promptTokens + prev.completionTokens : undefined}
                period={span}
              />
            )}
          </div>
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
          {sparks && total.counted > 0 && <Spark values={perDay.map((d) => d?.tokens ?? 0)} tone="ink" />}
        </div>
        {usage.currency && (
          <div className="tile">
            <div className="tile-head">
              <span className="label">Cost</span>
              <Delta now={total.cost ?? 0} before={prev?.cost} period={span} />
            </div>
            <div className="value">{money(total.cost ?? 0, usage.currency)}</div>
            <div className="sub">at the prices set per alias</div>
          </div>
        )}
        <div className="tile">
          <div className="tile-head">
            <span className="label">Avg latency</span>
            {total.requests > 0 && prev && prev.requests > 0 && (
              <Delta now={total.ms / total.requests} before={prev.ms / prev.requests} better="down" period={span} />
            )}
          </div>
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
          {sparks && <Spark values={perDay.map((d) => (d && d.requests ? d.ms / d.requests : null))} tone="ink" />}
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>{METRICS.find((m) => m.id === metric)?.label} per day</h2>
          <span className="periods" role="group" aria-label="What the chart counts">
            {METRICS.map((m) => (
              <button
                key={m.id}
                type="button"
                className={m.id === metric ? "on" : "ghost"}
                aria-pressed={m.id === metric}
                onClick={() => setMetric(m.id)}
              >
                {m.label}
              </button>
            ))}
          </span>
        </div>
        <RequestsChart summary={usage} series={series} metric={metric} />
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

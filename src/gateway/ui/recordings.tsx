/**
 * The Recordings page: a filterable list of recorded requests, one opened
 * in full (chat as rendered markdown, autocomplete as code in context,
 * embeddings as their inputs), the settings that decide what is kept, and
 * an export of the current filter as JSON lines.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { messageOf } from "../../common/errors"
import type { ConfigurationSnapshot } from "../configuration"
import type { RecorderSummary } from "../recording/recorder"
import type { RecordingRecord, RecordingSummary } from "../recording/store"
import { RUN_GAP_MS } from "../runs"

import { api, ApiError } from "./api"
import { compact, duration, fmt, plural, timeAgo, whenExact } from "./format"
import { CharRange, CodeBlock, CopyButton, guessLanguage, Listing, MarkdownView } from "./markdown"

const ROUTES = ["chat", "fim", "embeddings"] as const
type Route = (typeof ROUTES)[number]
const ROUTE_LABEL: Record<Route, string> = { chat: "Chat", fim: "Autocomplete", embeddings: "Embeddings" }
const OUTCOMES = ["ok", "error", "cancelled"] as const
type Outcome = (typeof OUTCOMES)[number]
const PERIODS = ["24h", "7d", "30d", "90d"] as const
type Period = (typeof PERIODS)[number]

interface ListResponse {
  records: RecordingSummary[]
  nextBefore?: string
  summary: RecorderSummary
  keys: string[]
}

/**
 * A list row: one record, or an indexing run of embedding records. The
 * list is newest-first, so consecutive embedding records from one
 * developer to one alias with no gap over `RUN_GAP_MS` fold into a run;
 * a run of one is just its record.
 */
type ListRow = { kind: "record"; record: RecordingSummary } | { kind: "run"; id: string; calls: RecordingSummary[]; failed: number; ms: number }

const groupRuns = (rows: RecordingSummary[]): ListRow[] => {
  const out: ListRow[] = []
  let run: Extract<ListRow, { kind: "run" }> | undefined
  let last: RecordingSummary | undefined
  for (const record of rows) {
    const joins =
      record.route === "embeddings" &&
      last?.route === "embeddings" &&
      last.key === record.key &&
      last.alias === record.alias &&
      Date.parse(last.at) - Date.parse(record.at) <= RUN_GAP_MS
    if (joins) {
      if (!run) {
        run = { kind: "run", id: last!.id, calls: [last!], failed: last!.outcome === "error" ? 1 : 0, ms: last!.ms }
        out[out.length - 1] = run
      }
      run.calls.push(record)
      if (record.outcome === "error") run.failed++
      run.ms += record.ms
    } else {
      run = undefined
      out.push({ kind: "record", record })
    }
    last = record
  }
  return out
}

/* -------------------------------------------------------------------------- */
/*  Small pieces                                                              */
/* -------------------------------------------------------------------------- */

const RouteTag = ({ route }: { route: Route }) => <span className={`tag route-${route}`}>{ROUTE_LABEL[route]}</span>

const OutcomePill = ({ record }: { record: Pick<RecordingSummary, "outcome" | "ended"> }) => {
  if (record.outcome === "ok") return <span className="pill-s ok">{record.ended === "client" ? "ok · stopped" : "ok"}</span>
  if (record.outcome === "cancelled") return <span className="pill-s warn">cancelled</span>
  return <span className="pill-s bad">error</span>
}

const Tokens = ({ usage }: { usage?: RecordingSummary["usage"] }) => {
  if (!usage || (usage.promptTokens === undefined && usage.completionTokens === undefined)) return <span className="muted">–</span>
  return (
    <span title={`${fmt(usage.promptTokens ?? 0)} prompt tokens, ${fmt(usage.completionTokens ?? 0)} output tokens`}>
      {compact(usage.promptTokens ?? 0)}
      <span className="muted"> → </span>
      {compact(usage.completionTokens ?? 0)}
    </span>
  )
}

/** The preview cell, with the search term lit up where it matches. */
const Preview = ({ text, term }: { text: string; term: string }) => {
  if (!term) return <>{text}</>
  const at = text.toLowerCase().indexOf(term.toLowerCase())
  if (at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + term.length)}</mark>
      {text.slice(at + term.length)}
    </>
  )
}

const Chips = <T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string; count?: number }>; onChange: (v: T) => void; label: string }) => (
  <span className="chips" role="group" aria-label={label}>
    {options.map((o) => (
      <button key={o.value} type="button" className={o.value === value ? "on" : "ghost"} onClick={() => onChange(o.value)}>
        {o.label}
        {o.count !== undefined && <span className="chip-count">{fmt(o.count)}</span>}
      </button>
    ))}
  </span>
)

/* -------------------------------------------------------------------------- */
/*  Settings                                                                  */
/* -------------------------------------------------------------------------- */

/** Settings, saved through the configuration route with its revision check. */
const RecordingSettings = ({ apiKey, summary, licensed, onSaved }: { apiKey: string; summary: RecorderSummary; licensed: boolean; onSaved: () => void }) => {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(summary.settings)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  useEffect(() => setDraft(summary.settings), [summary.settings])
  const dirty = JSON.stringify(draft) !== JSON.stringify(summary.settings)
  const active = ROUTES.filter((r) => summary.settings[r])

  const save = async () => {
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const snapshot = await api<ConfigurationSnapshot>("/twinny/v1/admin/config", apiKey)
      await api("/twinny/v1/admin/config", apiKey, {
        method: "PUT",
        body: { revision: snapshot.revision, recording: { ...snapshot.recording, chat: draft.chat, fim: draft.fim, embeddings: draft.embeddings, retentionDays: draft.retentionDays } }
      })
      setNotice(licensed ? "Saved. Recording applies to new requests." : "Saved. Nothing is recorded until the licence includes the recording feature.")
      setEditing(false)
      onSaved()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel settings-strip">
      <div className="section-heading">
        <h2>What is kept</h2>
        <span className="editor-actions">
          <span className={`pill-s ${licensed ? "ok" : "warn"}`}>{licensed ? "licensed" : "needs a licence"}</span>
          {!editing && (
            <button type="button" className="ghost mini" onClick={() => setEditing(true)}>
              change
            </button>
          )}
        </span>
      </div>
      {!editing ? (
        <p className="config-hint" style={{ margin: 0 }}>
          {active.length ? (
            <>
              Recording <b>{active.map((r) => ROUTE_LABEL[r]).join(", ")}</b> for <b>{plural(summary.settings.retentionDays, "day")}</b>
            </>
          ) : (
            <>Recording is <b>off</b> for every feature</>
          )}
          {!licensed && active.length > 0 && <> (saved, but nothing is kept without the licence feature)</>}. Developers see this
          when they connect and on their Providers tab. Stored in <code>{summary.store.kind}</code> at <code>{summary.store.location}</code>.
        </p>
      ) : (
        <>
          <fieldset className="policy-rule">
            <legend>Requests</legend>
            {ROUTES.map((route) => (
              <label key={route} className="policy-option">
                <input type="checkbox" checked={draft[route]} disabled={busy} onChange={(e) => setDraft({ ...draft, [route]: e.target.checked })} />
                <span>
                  <b>{ROUTE_LABEL[route]}</b>
                  <small>
                    {route === "chat" && "Every message in the conversation and the reply."}
                    {route === "fim" && "The code around the cursor and the completion."}
                    {route === "embeddings" && "Inputs only, never vectors."}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="config-field" style={{ maxWidth: 260, marginTop: 12 }}>
            <span>Keep records for (days)</span>
            <input type="number" min={1} max={3650} value={draft.retentionDays} disabled={busy} onChange={(e) => setDraft({ ...draft, retentionDays: Math.max(1, Math.min(3650, Number(e.target.value) || 1)) })} />
          </label>
          <div className="editor-actions" style={{ marginTop: 12 }}>
            <button className="primary" disabled={!dirty || busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              className="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(summary.settings)
                setEditing(false)
              }}
            >
              {dirty ? "Discard" : "Cancel"}
            </button>
          </div>
        </>
      )}
      {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
      {notice && <div className="success-bar" style={{ marginTop: 10, marginBottom: 0 }}>{notice}</div>}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  One record                                                                */
/* -------------------------------------------------------------------------- */

type ChatMessage = { role?: string; content?: unknown }

const contentText = (content: unknown): string => (typeof content === "string" ? content : JSON.stringify(content, null, 2))

const firstLine = (text: string, max = 110): string => {
  const line = text.trim().split("\n")[0] ?? ""
  return line.length > max ? `${line.slice(0, max)}…` : line
}

const Body = ({ text, raw, language }: { text: string; raw: boolean; language?: string }) =>
  raw || language ? <CodeBlock code={text} language={language ?? "markdown"} bare wrap /> : <MarkdownView text={text} />

/** A chat as its turns; system prompts folded, since they are long and the same every time. */
const ChatView = ({ record, raw }: { record: RecordingRecord; raw: boolean }) => {
  const request = (record.request ?? {}) as Record<string, unknown>
  const response = (record.response ?? {}) as Record<string, unknown>
  const messages = Array.isArray(request.messages) ? (request.messages as ChatMessage[]) : []
  const reply = typeof response.content === "string" ? response.content : ""
  return (
    <div className="turns">
      {messages.map((m, i) => {
        const text = contentText(m.content)
        const isJson = typeof m.content !== "string"
        if (m.role === "system") {
          return (
            <details key={i} className="turn system">
              <summary>
                <span className="role">system</span>
                <span className="muted summary-text">{firstLine(text)}</span>
                <span className="muted summary-len">{compact(text.length)} chars</span>
              </summary>
              <div className="turn-body">
                <Body text={text} raw={raw} language={isJson ? "json" : undefined} />
              </div>
            </details>
          )
        }
        return (
          <div key={i} className={`turn ${m.role ?? ""}`}>
            <div className="turn-head">
              <span className="role">{m.role ?? "?"}</span>
              <CopyButton text={text} />
            </div>
            <div className="turn-body">
              <Body text={text} raw={raw} language={isJson ? "json" : undefined} />
            </div>
          </div>
        )
      })}
      <div className="turn assistant reply">
        <div className="turn-head">
          <span className="role">
            assistant · <OutcomePill record={record} />
          </span>
          {reply && <CopyButton text={reply} />}
        </div>
        <div className="turn-body">
          {reply ? <Body text={reply} raw={raw} /> : <div className="muted">{record.outcome === "ok" ? "The reply was empty." : "No reply was produced."}</div>}
        </div>
      </div>
    </div>
  )
}

const CONTEXT_LINES = 24

/** The 0-based line that holds character `offset` of `text`. */
const lineAt = (text: string, offset: number): number => {
  let line = 0
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/**
 * An autocomplete as the file looked with the completion accepted: one
 * listing, the inserted characters marked like an added hunk, a window of
 * lines around it, and the whole file or the templated prompt a click away.
 */
const FimView = ({ record }: { record: RecordingRecord }) => {
  const request = (record.request ?? {}) as Record<string, unknown>
  const response = (record.response ?? {}) as Record<string, unknown>
  const prefix = typeof request.prefix === "string" ? request.prefix : String(request.prompt ?? "")
  const suffix = typeof request.suffix === "string" ? request.suffix : ""
  const completion = String(response.text ?? "")
  const templated = typeof request.prefix === "string" && typeof request.prompt === "string" ? request.prompt : undefined
  const [whole, setWhole] = useState(false)
  const full = `${prefix}${completion}${suffix}`
  const language = useMemo(() => guessLanguage(full), [full])

  const insert: CharRange = { start: prefix.length, end: prefix.length + completion.length }
  const lines = full.split("\n")
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  const firstLine = lineAt(full, completion.startsWith("\n") ? insert.start + 1 : insert.start)
  const lastLine = lineAt(full, Math.max(insert.start, insert.end - 1))
  const from = whole ? 0 : Math.max(0, firstLine - CONTEXT_LINES)
  const to = whole ? lines.length - 1 : Math.min(lines.length - 1, lastLine + CONTEXT_LINES)
  const shownStart = from === 0 ? 0 : lines.slice(0, from).join("\n").length + 1
  const shown = lines.slice(from, to + 1).join("\n")
  const hiddenBefore = from
  const hiddenAfter = lines.length - 1 - to
  const insertedLines = completion ? lastLine - firstLine + 1 : 0

  return (
    <div className="turns">
      <div className="code listing fim">
        <div className="code-bar">
          <span className="code-lang">
            {language === "text" ? "code" : language}
            <span className="muted"> · </span>
            {completion ? (
              <>
                completion of {compact(completion.length)} chars on {insertedLines === 1 ? `line ${firstLine + 1}` : `lines ${firstLine + 1}–${lastLine + 1}`}
              </>
            ) : (
              <span className="muted">{record.outcome === "ok" ? "empty completion" : "no completion"} at line {firstLine + 1}</span>
            )}
            <span className="muted"> · </span>
            <OutcomePill record={record} />
            {record.ended === "client" && <span className="muted"> · the editor stopped reading here</span>}
          </span>
          <span className="code-actions">
            {(hiddenBefore > 0 || hiddenAfter > 0 || whole) && (
              <button type="button" className="mini ghost" onClick={() => setWhole(!whole)}>
                {whole ? `${CONTEXT_LINES} lines around the completion` : `show all ${fmt(lines.length)} lines`}
              </button>
            )}
            {completion && <CopyButton text={completion} label="copy completion" />}
            <CopyButton text={full} label="copy file" />
          </span>
        </div>
        {hiddenBefore > 0 && <div className="fim-fold">{plural(hiddenBefore, "line")} above</div>}
        <Listing code={shown} language={language} insert={{ start: insert.start - shownStart, end: insert.end - shownStart }} startingLineNumber={from + 1} />
        {hiddenAfter > 0 && <div className="fim-fold below">{plural(hiddenAfter, "line")} below</div>}
      </div>
      {templated && (
        <details className="advanced-fields" style={{ margin: "4px 0 0" }}>
          <summary>The prompt as sent to the model, template applied ({compact(templated.length)} chars)</summary>
          <div style={{ marginTop: 8 }}>
            <CodeBlock code={templated} language="text" title="templated prompt" wrap />
          </div>
        </details>
      )}
    </div>
  )
}

const EmbeddingsView = ({ record }: { record: RecordingRecord }) => {
  const request = (record.request ?? {}) as Record<string, unknown>
  const response = (record.response ?? {}) as Record<string, unknown>
  const inputs = Array.isArray(request.input) ? request.input : [request.input]
  const count = Number(response.count ?? 0)
  return (
    <div className="turns">
      {inputs.map((input, i) => (
        <CodeBlock key={i} code={String(input ?? "")} language={guessLanguage(String(input ?? ""))} title={`input ${i + 1} of ${inputs.length}`} wrap />
      ))}
      <div className="muted">
        {plural(count, "vector")} of {fmt(Number(response.dimensions ?? 0))} dimensions returned. Vectors are never kept.
      </div>
    </div>
  )
}

interface RecordPanelProps {
  record: RecordingRecord
  index: number
  total: number
  onStep: (delta: 1 | -1) => void
  onClose: () => void
}

const RecordPanel = ({ record, index, total, onStep, onClose }: RecordPanelProps) => {
  const [raw, setRaw] = useState(false)
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "start", behavior: "smooth" })
  }, [record.id])
  const json = useMemo(() => JSON.stringify(record, null, 2), [record])
  return (
    <section className="panel record" ref={ref} aria-label="Opened record">
      <div className="section-heading">
        <h2 className="record-title">
          <RouteTag route={record.route} />
          <b>{record.key}</b>
          <span className="muted" title={record.at}>
            {whenExact(record.at)} UTC · {timeAgo(record.at)}
          </span>
        </h2>
        <span className="editor-actions">
          <span className="muted">
            {index + 1} of {fmt(total)}
          </span>
          <button type="button" className="ghost mini" disabled={index <= 0} onClick={() => onStep(-1)} title="Newer (↑ / k)">
            ↑ newer
          </button>
          <button type="button" className="ghost mini" disabled={index >= total - 1} onClick={() => onStep(1)} title="Older (↓ / j)">
            ↓ older
          </button>
          {record.route === "chat" && (
            <span className="chips" role="group" aria-label="View as">
              <button type="button" className={raw ? "ghost" : "on"} onClick={() => setRaw(false)}>
                rendered
              </button>
              <button type="button" className={raw ? "on" : "ghost"} onClick={() => setRaw(true)}>
                raw
              </button>
            </span>
          )}
          <CopyButton text={json} label="copy JSON" />
          <button type="button" className="ghost mini" onClick={onClose} title="Close (Esc)">
            close
          </button>
        </span>
      </div>
      <div className="meta">
        <span>
          <span className="meta-k">model</span>
          {record.model ?? record.alias}
          {record.model && record.model !== record.alias && <span className="muted"> as {record.alias}</span>}
        </span>
        {record.provider && (
          <span>
            <span className="meta-k">provider</span>
            {record.provider}
          </span>
        )}
        <span>
          <span className="meta-k">outcome</span>
          <OutcomePill record={record} />
        </span>
        <span>
          <span className="meta-k">took</span>
          {duration(record.ms)}
        </span>
        <span>
          <span className="meta-k">tokens</span>
          <Tokens usage={record.usage} />
        </span>
        <span>
          <span className="meta-k">id</span>
          <span className="muted">{record.id}</span>
        </span>
      </div>
      {record.route === "chat" ? <ChatView record={record} raw={raw} /> : record.route === "fim" ? <FimView record={record} /> : <EmbeddingsView record={record} />}
    </section>
  )
}

interface RecordRowProps {
  record: RecordingSummary
  selected: boolean
  now: number
  term: string
  onOpen: (id: string) => Promise<void>
  /** A call inside an expanded indexing run. */
  nested?: boolean
}

const RecordRow = ({ record: r, selected, now, term, onOpen, nested }: RecordRowProps) => (
  <tr className={`${selected ? "selected" : ""} ${nested ? "nested" : ""}`} onClick={() => void onOpen(r.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && void onOpen(r.id)}>
    <td className="muted" title={`${whenExact(r.at)} UTC`}>
      {timeAgo(r.at, now)}
    </td>
    <td>{r.key}</td>
    <td>
      <RouteTag route={r.route} />
    </td>
    <td className="muted">{r.model ?? r.alias}</td>
    <td>
      <OutcomePill record={r} />
    </td>
    <td className="num">{duration(r.ms)}</td>
    <td className="num">
      <Tokens usage={r.usage} />
    </td>
    <td className="preview">
      <Preview text={r.preview} term={term} />
    </td>
  </tr>
)

/* -------------------------------------------------------------------------- */
/*  The page                                                                  */
/* -------------------------------------------------------------------------- */

export const RecordingsPanel = ({ apiKey, features }: { apiKey: string; features: string[] }) => {
  const [route, setRoute] = useState<Route | "">("")
  const [outcome, setOutcome] = useState<Outcome | "">("")
  const [key, setKey] = useState("")
  const [period, setPeriod] = useState<Period>("7d")
  const [search, setSearch] = useState("")
  const [term, setTerm] = useState("")
  const [data, setData] = useState<ListResponse | null>(null)
  const [more, setMore] = useState<RecordingSummary[]>([])
  const [open, setOpen] = useState<RecordingRecord | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [paging, setPaging] = useState(false)
  const [exporting, setExporting] = useState<"training" | "raw" | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const licensed = features.includes("recording")

  // Typing filters after a pause, not on every key.
  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(search.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [search])

  const params = useCallback(() => {
    const p = new URLSearchParams()
    if (route) p.set("route", route)
    if (outcome) p.set("outcome", outcome)
    if (key) p.set("key", key)
    p.set("since", period)
    if (term) p.set("q", term)
    // Big pages: an indexing run folds hundreds of records into one row.
    p.set("limit", "200")
    return p
  }, [route, outcome, key, period, term])

  const autoPages = useRef(0)
  const load = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    autoPages.current = 0
    try {
      setData(await api<ListResponse>(`/twinny/v1/admin/recordings?${params().toString()}`, apiKey))
      setMore([])
      setNow(Date.now())
    } catch (e) {
      setError(e instanceof ApiError && e.status === 503 ? "This gateway was started without recording support." : messageOf(e))
    } finally {
      setLoading(false)
    }
  }, [apiKey, params])

  useEffect(() => {
    void load()
  }, [load])

  const rows = useMemo(() => (data ? [...data.records, ...more] : []), [data, more])
  const grouped = useMemo(() => groupRuns(rows), [rows])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const toggleRun = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const openIndex = open ? rows.findIndex((r) => r.id === open.id) : -1

  const loadMore = async () => {
    const before = data?.nextBefore
    if (!before || paging) return
    setPaging(true)
    try {
      const p = params()
      p.set("before", before)
      const page = await api<ListResponse>(`/twinny/v1/admin/recordings?${p.toString()}`, apiKey)
      setMore((current) => [...current, ...page.records])
      setData((current) => (current ? { ...current, nextBefore: page.nextBefore } : current))
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setPaging(false)
    }
  }

  // A page can fold into a handful of runs; fetch older pages until there
  // is something to look at, within reason.
  useEffect(() => {
    if (!data?.nextBefore || paging || loading) return
    if (grouped.length >= 15 || autoPages.current >= 3) return
    autoPages.current++
    void loadMore()
  }, [grouped, data, paging, loading])

  const show = useCallback(
    async (id: string) => {
      try {
        setOpen(await api<RecordingRecord>(`/twinny/v1/admin/recordings/${id}`, apiKey))
      } catch (e) {
        setError(messageOf(e))
      }
    },
    [apiKey]
  )

  const step = useCallback(
    (delta: 1 | -1) => {
      if (openIndex < 0) return
      const next = rows[openIndex + delta]
      if (next) void show(next.id)
    },
    [openIndex, rows, show]
  )

  // j/k and the arrows walk the list while a record is open; Esc closes it.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault()
        step(1)
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault()
        step(-1)
      } else if (e.key === "Escape") setOpen(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, step])

  // The page authenticates with a bearer header, so a plain link cannot
  // download; fetch the file and hand it to the browser.
  const exportNow = async (format: "training" | "raw") => {
    setExporting(format)
    try {
      const p = params()
      p.set("format", format)
      const response = await fetch(`/twinny/v1/admin/recordings/export?${p.toString()}`, { headers: { Authorization: `Bearer ${apiKey}` } })
      if (!response.ok) throw new Error(`The gateway answered ${response.status}.`)
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `twinny-recordings-${route || "all"}-${format}.jsonl`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setExporting(null)
    }
  }

  const filtered = !!(route || outcome || key || term)
  const clearFilters = () => {
    setRoute("")
    setOutcome("")
    setKey("")
    setSearch("")
    setTerm("")
  }
  const active = data?.summary.active ?? []
  // Chips count rows as shown: an indexing run once, not per call.
  const counts = useMemo(() => {
    const byRoute: Record<string, number> = {}
    const byOutcome: Record<string, number> = {}
    for (const row of grouped) {
      const route = row.kind === "run" ? "embeddings" : row.record.route
      const outcome = row.kind === "run" ? (row.failed ? "error" : "ok") : row.record.outcome
      byRoute[route] = (byRoute[route] ?? 0) + 1
      byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1
    }
    return { byRoute, byOutcome }
  }, [grouped])
  const runs = grouped.filter((row) => row.kind === "run").length
  // Filters and exports only when there is, or can be, something to filter:
  // on the free plan the page is its status line and the settings.
  const usable = licensed || rows.length > 0 || filtered

  return (
    <>
      <div className="page-title">
        <h2>Recordings</h2>
        <p>
          {data
            ? active.length
              ? `${plural(data.summary.store.count, "record")} kept. Recording ${active.map((r) => ROUTE_LABEL[r]).join(", ")} now.`
              : `${plural(data.summary.store.count, "record")} kept. Nothing is being recorded now.`
            : "The content of requests, for review and for training data."}
        </p>
      </div>
      {error && <div className="error-bar">{error}</div>}

      <section className="panel">
        <div className="section-heading">
          <h2>
            Records
            {data && (
              <span className="count">
                {fmt(grouped.length)}
                {data.nextBefore ? "+" : ""} shown
                {runs ? ` · ${plural(runs, "indexing run")} folded` : ""}
              </span>
            )}
          </h2>
          <span className="editor-actions">
            {usable && (
              <>
                <button className="ghost mini" disabled={!!exporting || !rows.length} onClick={() => void exportNow("training")} title="Successful, complete examples as prompt/completion JSON lines">
                  {exporting === "training" ? "exporting…" : "export training data"}
                </button>
                <button className="ghost mini" disabled={!!exporting || !rows.length} onClick={() => void exportNow("raw")} title="Every matching record as stored">
                  {exporting === "raw" ? "exporting…" : "export raw"}
                </button>
              </>
            )}
            <button className="ghost mini" disabled={loading} onClick={() => void load()}>
              {loading ? "…" : "refresh"}
            </button>
          </span>
        </div>
        {usable && (
        <div className="toolbar">
          <Chips
            label="Feature"
            value={route}
            onChange={setRoute}
            options={[{ value: "" as Route | "", label: "All" }, ...ROUTES.map((r) => ({ value: r as Route | "", label: ROUTE_LABEL[r], count: route === "" ? counts.byRoute[r] ?? 0 : undefined }))]}
          />
          <Chips
            label="Outcome"
            value={outcome}
            onChange={setOutcome}
            options={[{ value: "" as Outcome | "", label: "Any outcome" }, ...OUTCOMES.map((o) => ({ value: o as Outcome | "", label: o, count: outcome === "" ? counts.byOutcome[o] ?? 0 : undefined }))]}
          />
          <select aria-label="Developer" value={key} onChange={(e) => setKey(e.target.value)}>
            <option value="">Everyone</option>
            {(data?.keys ?? []).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <Chips label="Period" value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ value: p, label: p }))} />
          <input className="search" type="search" placeholder="search prompts and replies" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
          {filtered && (
            <button type="button" className="ghost mini" onClick={clearFilters}>
              clear filters
            </button>
          )}
        </div>
        )}
        {!rows.length ? (
          <div className="empty">
            {!data ? (
              loading ? "Loading…" : ""
            ) : filtered ? (
              <>
                Nothing matches these filters in the last {period}.{" "}
                <button type="button" className="link" onClick={clearFilters}>
                  Clear them
                </button>
                .
              </>
            ) : !active.length ? (
              licensed ? (
                "Nothing is being recorded. Switch a feature on under “What is kept” below."
              ) : (
                "Recording needs a licence with the recording feature. Settings below are saved but nothing is kept until one is installed under Plan & licence."
              )
            ) : (
              `No records in the last ${period}. Recorded requests appear here as developers use ${active.map((r) => ROUTE_LABEL[r].toLowerCase()).join(" and ")}.`
            )}
          </div>
        ) : (
          <div className="scroll">
            <table className="rows">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Feature</th>
                  <th>Model</th>
                  <th>Outcome</th>
                  <th className="num">Took</th>
                  <th className="num">Tokens</th>
                  <th>Content</th>
                </tr>
              </thead>
              <tbody>
                {grouped.map((row) => {
                  if (row.kind === "record") return <RecordRow key={row.record.id} record={row.record} selected={open?.id === row.record.id} now={now} term={term} onOpen={show} />
                  const first = row.calls[0]
                  const isOpen = expanded.has(row.id)
                  const holdsOpen = !!open && row.calls.some((c) => c.id === open.id)
                  return (
                    <React.Fragment key={row.id}>
                      <tr
                        className={`run ${holdsOpen && !isOpen ? "selected" : ""}`}
                        onClick={() => toggleRun(row.id)}
                        tabIndex={0}
                        onKeyDown={(e) => e.key === "Enter" && toggleRun(row.id)}
                        aria-expanded={isOpen}
                        title={isOpen ? "Fold the run" : "Show each call"}
                      >
                        <td className="muted" title={`${whenExact(row.calls[row.calls.length - 1].at)} – ${whenExact(first.at)} UTC`}>
                          <span className="caret">{isOpen ? "▾" : "▸"}</span>
                          {timeAgo(first.at, now)}
                        </td>
                        <td>{first.key}</td>
                        <td>
                          <RouteTag route="embeddings" />
                        </td>
                        <td className="muted">{first.model ?? first.alias}</td>
                        <td>
                          {row.failed ? <span className="pill-s bad">{plural(row.failed, "call")} failed</span> : <span className="pill-s ok">ok</span>}
                        </td>
                        <td className="num">{duration(row.ms)}</td>
                        <td className="num muted">–</td>
                        <td className="preview">
                          <b>Indexing run</b> · {plural(row.calls.length, "call")}
                        </td>
                      </tr>
                      {isOpen && row.calls.map((call) => <RecordRow key={call.id} record={call} selected={open?.id === call.id} now={now} term={term} onOpen={show} nested />)}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {data?.nextBefore && (
          <div className="editor-actions" style={{ marginTop: 10 }}>
            <button className="ghost" disabled={paging} onClick={() => void loadMore()}>
              {paging ? "loading…" : "load older"}
            </button>
            <span className="muted">Click a row to open it. ↑ ↓ move between records, Esc closes.</span>
          </div>
        )}
        {!data?.nextBefore && rows.length > 0 && <div className="hint">Click a row to open it. ↑ ↓ move between records, Esc closes.</div>}
      </section>

      {open && <RecordPanel record={open} index={openIndex} total={rows.length} onStep={step} onClose={() => setOpen(null)} />}

      {data && <RecordingSettings apiKey={apiKey} summary={data.summary} licensed={licensed} onSaved={() => void load()} />}
    </>
  )
}

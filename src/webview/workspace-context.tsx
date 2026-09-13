import React, { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import cx from "classnames"

import { EVENT_NAME } from "../common/constants"
import {
  WorkspaceHitSummary,
  WorkspaceNearMiss,
  WorkspaceSearchReport
} from "../common/messaging/protocol"

import { isSearchFinished } from "./hooks/useWorkspaceSearch"
import { emit } from "./messaging"

import styles from "./styles/workspace-context.module.css"

/** Whether the list is open is a preference, not per message. */
const OPEN_KEY = "twinny.contextPanelOpen"
/** Lines of a chunk shown before "show all". */
const PREVIEW_LINES = 4

const readOpen = (): boolean => {
  try {
    return localStorage.getItem(OPEN_KEY) === "1"
  } catch {
    return false
  }
}

const writeOpen = (open: boolean) => {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0")
  } catch {
    // A webview without storage just forgets the preference.
  }
}

/** `src/a/b.ts` as its directory and its name, so the name can stand out. */
const splitPath = (path: string): [string, string] => {
  const at = path.lastIndexOf("/")
  return at === -1 ? ["", path] : [path.slice(0, at + 1), path.slice(at + 1)]
}

const lineRange = (startLine: number, endLine: number) =>
  startLine === endLine
    ? `${startLine + 1}`
    : `${startLine + 1}–${endLine + 1}`

const formatScore = (score: number) => score.toFixed(2).replace(/^0/, "")

const formatSeconds = (ms: number) =>
  ms < 950 ? `${Math.max(ms, 1)}ms` : `${(ms / 1000).toFixed(1)}s`

/** Strips a common indent so a preview of a method body is not all margin. */
const dedent = (lines: string[]): string[] => {
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => line.match(/^\s*/)?.[0].length ?? 0)
  const indent = indents.length ? Math.min(...indents) : 0
  return lines.map((line) => line.slice(indent))
}

const openAt = (hit: WorkspaceNearMiss) =>
  emit(EVENT_NAME.twinnyOpenFile, {
    path: hit.path,
    startLine: hit.startLine,
    endLine: hit.endLine
  })

interface HitRowProps {
  hit: WorkspaceHitSummary
  /** Marks the strongest hit so the eye lands on it first. */
  best: boolean
}

const HitRow = ({ hit, best }: HitRowProps) => {
  const { t } = useTranslation()
  const [showAll, setShowAll] = useState(false)
  const [dir, name] = splitPath(hit.path)
  const lines = useMemo(() => {
    const all = hit.content.replace(/\s+$/, "").split("\n")
    // Leading blank lines say nothing about the chunk.
    const first = all.findIndex((line) => line.trim())
    return dedent(first > 0 ? all.slice(first) : all)
  }, [hit.content])
  const clipped = lines.length > PREVIEW_LINES
  const shown = showAll ? lines : lines.slice(0, PREVIEW_LINES)
  const range = lineRange(hit.startLine, hit.endLine)

  return (
    <li className={cx(styles.hit, { [styles.hitBest]: best })}>
      <button
        type="button"
        className={styles.hitHeader}
        title={t("workspace-context-open", { path: hit.path, range })}
        onClick={() => openAt(hit)}
      >
        <span className={styles.hitPath}>
          <span className={styles.hitDir}>
            <bdi dir="ltr">{dir}</bdi>
          </span>
          <span className={styles.hitName}>{name}</span>
        </span>
        <span className={styles.hitLines}>{range}</span>
        <Score score={hit.score} />
      </button>
      <div
        className={cx(styles.preview, { [styles.previewOpen]: showAll })}
        role="figure"
        aria-label={t("workspace-context-preview")}
      >
        {shown.map((line, i) => (
          <span key={i} className={styles.previewLine}>
            {line || " "}
          </span>
        ))}
      </div>
      {clipped && (
        <button
          type="button"
          className={styles.more}
          onClick={() => setShowAll((open) => !open)}
        >
          {showAll
            ? t("workspace-context-less")
            : t("workspace-context-more", { lines: lines.length - PREVIEW_LINES })}
        </button>
      )}
    </li>
  )
}

/** A hairline meter and the number: how sure the reranker was. */
const Score = ({ score }: { score: number }) => {
  const { t } = useTranslation()
  const level = score >= 0.5 ? "high" : score >= 0.2 ? "mid" : "low"
  return (
    <span
      className={cx(styles.score, styles[`score-${level}`])}
      title={t("workspace-context-score", { score: score.toFixed(3) })}
    >
      <span className={styles.meter} aria-hidden="true">
        <span
          className={styles.meterFill}
          style={{ width: `${Math.round(Math.min(1, Math.max(0, score)) * 100)}%` }}
        />
      </span>
      <span className={styles.scoreValue}>{formatScore(score)}</span>
    </span>
  )
}

const NearMissRow = ({ hit }: { hit: WorkspaceNearMiss }) => {
  const { t } = useTranslation()
  const [dir, name] = splitPath(hit.path)
  const range = lineRange(hit.startLine, hit.endLine)
  return (
    <li className={cx(styles.hit, styles.miss)}>
      <button
        type="button"
        className={styles.hitHeader}
        title={t("workspace-context-open", { path: hit.path, range })}
        onClick={() => openAt(hit)}
      >
        <span className={styles.hitPath}>
          <span className={styles.hitDir}>
            <bdi dir="ltr">{dir}</bdi>
          </span>
          <span className={styles.hitName}>{name}</span>
        </span>
        <span className={styles.hitLines}>{range}</span>
        <Score score={hit.score} />
      </button>
    </li>
  )
}

interface WorkspaceContextProps {
  report: WorkspaceSearchReport | undefined
}

/**
 * The workspace search behind a reply, shown under the "twinny" label:
 * a one-line summary that narrates the search while it runs, and behind
 * it the chunks the model was given, with the reranker's score for each,
 * a few lines of the code, and a click to open the file at that spot.
 *
 * Collapsed by default so a chat with the index on stays a chat; the open
 * state is remembered so someone who wants to see sources always does.
 */
export const WorkspaceContext = ({ report }: WorkspaceContextProps) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(readOpen)

  // Another panel toggling keeps this one in step.
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === OPEN_KEY) setOpen(readOpen())
    }
    window.addEventListener("storage", sync)
    return () => window.removeEventListener("storage", sync)
  }, [])

  const toggle = useCallback(() => {
    setOpen((current) => {
      writeOpen(!current)
      return !current
    })
  }, [])

  if (!report) return null

  const finished = isSearchFinished(report)
  const files = new Set(report.hits.map((hit) => hit.path)).size
  const summary = (() => {
    switch (report.stage) {
      case "unavailable":
        return t("workspace-context-unavailable")
      case "embedding":
        return t("workspace-context-embedding")
      case "retrieving":
        return t("workspace-context-retrieving")
      case "reranking":
        return t("workspace-context-reranking", { count: report.candidates ?? 0 })
      case "done":
        return t("workspace-context-done", {
          chunks: report.hits.length,
          files,
          count: files
        })
      case "empty":
        return t("workspace-context-empty", {
          threshold: formatScore(report.threshold)
        })
    }
  })()
  // Nothing to unfold for a search that found nothing and has no misses.
  const expandable =
    finished &&
    (report.hits.length > 0 || report.nearMisses.length > 0 || !!report.note)

  return (
    <section
      className={cx(styles.panel, {
        [styles.panelBusy]: !finished,
        [styles.panelOpen]: open && expandable
      })}
      aria-live="polite"
    >
      <button
        type="button"
        className={styles.header}
        onClick={expandable ? toggle : undefined}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
      >
        <span className={styles.glyph} aria-hidden="true">
          {finished ? (
            <span className="codicon codicon-references" />
          ) : (
            <span className={styles.spinner} />
          )}
        </span>
        <span className={styles.label}>{t("workspace-context")}</span>
        <span className={styles.summary}>{summary}</span>
        {finished && report.elapsedMs !== undefined && (
          <span className={styles.elapsed}>{formatSeconds(report.elapsedMs)}</span>
        )}
        {expandable && (
          <span
            className={cx(
              "codicon",
              open ? "codicon-chevron-down" : "codicon-chevron-right",
              styles.chevron
            )}
            aria-hidden="true"
          />
        )}
      </button>
      <span className={styles.sweep} aria-hidden="true" />
      {open && expandable && (
        <div className={styles.body}>
          {report.note && (
            <p className={styles.note}>
              <span className="codicon codicon-warning" aria-hidden="true" />
              {report.note}
            </p>
          )}
          {report.hits.length > 0 && (
            <ul className={styles.hits}>
              {report.hits.map((hit, i) => (
                <HitRow
                  key={`${hit.path}:${hit.startLine}-${hit.endLine}`}
                  hit={hit}
                  best={i === 0 && report.hits.length > 1}
                />
              ))}
            </ul>
          )}
          {report.stage === "empty" && report.nearMisses.length > 0 && (
            <>
              <p className={styles.missTitle}>
                {t("workspace-context-near-misses", {
                  count: report.candidates ?? report.nearMisses.length
                })}
              </p>
              <ul className={styles.hits}>
                {report.nearMisses.map((hit) => (
                  <NearMissRow
                    key={`${hit.path}:${hit.startLine}-${hit.endLine}`}
                    hit={hit}
                  />
                ))}
              </ul>
              <p className={styles.hint}>{t("workspace-context-empty-hint")}</p>
            </>
          )}
        </div>
      )}
    </section>
  )
}

export default WorkspaceContext

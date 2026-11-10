import React from "react"
import { useTranslation } from "react-i18next"

import { ContextFit, ModelStatus, shortTokens } from "../common/model-status"

import styles from "./styles/model-state.module.css"

/** From this share of the context the gauge shows at all. */
const SHOW_FROM = 0.25
const RING = 2 * Math.PI * 5

/** How the model sits in memory, in a few words; empty when the server does not say. */
export const useLoadedLabel = (status: ModelStatus | null): string => {
  const { t } = useTranslation()
  if (!status || status.loaded === undefined) return ""
  if (!status.loaded) return t("model-not-loaded")
  if (status.loadMs !== undefined) return t("model-loaded-in", { seconds: (status.loadMs / 1000).toFixed(1) })
  if (status.gpuShare === undefined) return t("model-loaded")
  if (status.gpuShare >= 0.995) return t("model-loaded-gpu")
  if (status.gpuShare <= 0.005) return t("model-loaded-cpu")
  return t("model-loaded-split", { share: Math.round(status.gpuShare * 100) })
}

/**
 * The two things a local model's user finds out too late, said in the
 * composer's footer before the message goes: the model is not in memory
 * (with a click to load it), and the conversation is close to, or past,
 * what the model is loaded to hold.
 */
export const ModelState = ({
  status,
  fit,
  model,
  warming,
  onWarm,
  hideLoad
}: {
  status: ModelStatus | null
  fit?: ContextFit
  model?: string
  warming: boolean
  onWarm: () => void
  /** The empty chat already offers to load the model. */
  hideLoad?: boolean
}) => {
  const { t } = useTranslation()
  const cold = !hideLoad && status?.loaded === false
  const shown = fit && fit.share >= SHOW_FROM ? fit : undefined
  const loading = !hideLoad && warming
  if (!cold && !loading && !shown) return null

  const window = status?.contextWindow ?? 0
  const fitTitle = shown
    ? t(
        shown.state === "over" ? "model-fit-over-title" : shown.state === "filling" ? "model-fit-filling-title" : "model-fit-title",
        { used: shown.tokens.toLocaleString(), window: window.toLocaleString() }
      )
    : ""

  return (
    <span className={styles.state}>
      {(cold || loading) &&
        (status?.canLoad || loading ? (
          <button
            type="button"
            className={styles.cold}
            disabled={loading}
            onClick={onWarm}
            title={status?.loadError ?? t("model-not-loaded-title", { model })}
          >
            <span className={loading ? styles.spin : styles.hollow} aria-hidden="true" />
            {loading ? t("model-loading") : status?.loadError ? t("model-load-retry") : t("model-load")}
          </button>
        ) : (
          <span className={styles.cold} title={t("model-not-loaded-title", { model })}>
            <span className={styles.hollow} aria-hidden="true" />
            {t("model-not-loaded")}
          </span>
        ))}
      {shown && (
        <span
          className={`${styles.fit} ${shown.state === "room" ? "" : styles[shown.state]}`}
          title={fitTitle}
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, Math.round(shown.share * 100))}
          aria-label={fitTitle}
        >
          <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
            <circle cx="7" cy="7" r="5" className={styles.track} />
            <circle
              cx="7"
              cy="7"
              r="5"
              className={styles.arc}
              strokeDasharray={`${Math.min(1, shown.share) * RING} ${RING}`}
              transform="rotate(-90 7 7)"
            />
          </svg>
          {shown.state === "over"
            ? t("model-fit-over", { used: shortTokens(shown.tokens), window: shortTokens(window) })
            : `${Math.round(shown.share * 100)}%`}
        </span>
      )}
    </span>
  )
}

import React from "react"
import { useTranslation } from "react-i18next"

import { ProviderTestResult } from "../../common/messaging/protocol"

import styles from "../styles/providers.module.css"

interface Props {
  result: ProviderTestResult | null
  pending?: boolean
  /** Show the full explanation, not just the one-word state. */
  verbose?: boolean
}

/** The outcome of a live test, as a compact status line. */
export const ProviderTestBadge = ({ result, pending, verbose }: Props) => {
  const { t } = useTranslation()

  if (pending) {
    return (
      <div className={`${styles.testResult} ${styles.testPending}`}>
        <i className="codicon codicon-loading codicon-modifier-spin" />
        <span>{t("testing")}</span>
      </div>
    )
  }
  if (!result) return null

  if (result.success) {
    const detail = [
      result.latencyMs !== undefined ? `${result.latencyMs} ms` : "",
      result.sample ? `“${result.sample}”` : ""
    ]
      .filter(Boolean)
      .join(" · ")
    return (
      <div className={`${styles.testResult} ${styles.testOk}`}>
        <i className="codicon codicon-check" />
        <span>
          {t("provider-test-successful")}
          {verbose && detail ? ` — ${detail}` : ""}
        </span>
      </div>
    )
  }

  return (
    <div className={`${styles.testResult} ${styles.testFailed}`}>
      <i className="codicon codicon-error" />
      <span>
        {verbose ? result.error || t("unknown-error") : t("provider-test-failed")}
      </span>
    </div>
  )
}

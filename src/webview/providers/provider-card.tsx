import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import { ProviderTestResult } from "../../common/messaging/protocol"
import { summarizeProvider } from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"

import { ProviderTestBadge } from "./provider-test-badge"

import styles from "../styles/providers.module.css"

interface Props {
  provider: TwinnyProvider
  active: boolean
  testResult?: ProviderTestResult | null
  testing?: boolean
  onActivate: () => void
  onTest: () => void
  onEdit: () => void
  onCopy: () => void
  onDelete: () => void
}

export const ProviderCard = ({
  provider,
  active,
  testResult,
  testing,
  onActivate,
  onTest,
  onEdit,
  onCopy,
  onDelete
}: Props) => {
  const { t } = useTranslation()
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  return (
    <div
      className={`${styles.card} ${active ? styles.cardActive : ""}`}
      data-testid={`provider-${provider.id}`}
    >
      <div className={styles.cardMain}>
        <button
          type="button"
          className={styles.cardSelect}
          title={active ? t("active-provider") : t("use-provider")}
          aria-pressed={active}
          onClick={onActivate}
        >
          <i
            className={`codicon codicon-${active ? "pass-filled" : "circle-large-outline"}`}
          />
        </button>
        <div className={styles.cardText}>
          <div className={styles.cardTitle}>
            <span className={styles.cardLabel}>{t(provider.label)}</span>
            {active && <span className={styles.cardBadge}>{t("active")}</span>}
          </div>
          <div className={styles.cardSummary} title={summarizeProvider(provider)}>
            {summarizeProvider(provider)}
          </div>
        </div>
        <div className={styles.cardActions}>
          <VSCodeButton
            appearance="icon"
            title={t("test-provider")}
            aria-label={t("test-provider")}
            disabled={testing}
            onClick={onTest}
          >
            <i
              className={`codicon codicon-${
                testing ? "loading codicon-modifier-spin" : "debug-start"
              }`}
            />
          </VSCodeButton>
          <VSCodeButton
            appearance="icon"
            title={t("edit-provider")}
            aria-label={t("edit-provider")}
            onClick={onEdit}
          >
            <i className="codicon codicon-edit" />
          </VSCodeButton>
          <VSCodeButton
            appearance="icon"
            title={t("copy-provider")}
            aria-label={t("copy-provider")}
            onClick={onCopy}
          >
            <i className="codicon codicon-copy" />
          </VSCodeButton>
          <VSCodeButton
            appearance="icon"
            title={t("delete-provider")}
            aria-label={t("delete-provider")}
            onClick={() => setConfirmingDelete(true)}
          >
            <i className="codicon codicon-trash" />
          </VSCodeButton>
        </div>
      </div>

      {(testing || testResult) && !confirmingDelete && (
        <ProviderTestBadge result={testResult || null} pending={testing} verbose />
      )}

      {confirmingDelete && (
        <div className={styles.confirmRow}>
          <span>{t("delete-provider-confirm", { label: t(provider.label) })}</span>
          <VSCodeButton
            appearance="secondary"
            onClick={() => setConfirmingDelete(false)}
          >
            {t("cancel")}
          </VSCodeButton>
          <VSCodeButton
            appearance="primary"
            onClick={() => {
              setConfirmingDelete(false)
              onDelete()
            }}
          >
            {t("remove")}
          </VSCodeButton>
        </div>
      )}
    </div>
  )
}

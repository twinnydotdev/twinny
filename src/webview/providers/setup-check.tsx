import React from "react"
import { useTranslation } from "react-i18next"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import { ProviderTestResult } from "../../common/messaging/protocol"
import { ProviderType } from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"

import styles from "../styles/providers.module.css"

export interface RoleStatus {
  type: ProviderType
  provider: TwinnyProvider | null
  result?: ProviderTestResult | null
  pending?: boolean
}

interface Props {
  roles: RoleStatus[]
  running: boolean
  onRun: () => void
  onAdd: (type: ProviderType) => void
  onFix: (provider: TwinnyProvider) => void
}

const ROLE_ICONS: Record<ProviderType, string> = {
  chat: "comment-discussion",
  fim: "file-code",
  embedding: "database"
}

/**
 * One line per job twinny does, with whether the provider behind it answers.
 * The first thing a new user sees on this tab, so it says what to do next
 * rather than only what is wrong.
 */
export const SetupCheck = ({ roles, running, onRun, onAdd, onFix }: Props) => {
  const { t } = useTranslation()

  const anyResult = roles.some((role) => role.result || role.pending)
  const failures = roles.filter((role) => role.result && !role.result.success)
  const missing = roles.filter((role) => !role.provider)
  const allGood =
    anyResult && !running && failures.length === 0 && missing.length === 0

  const renderStatus = (role: RoleStatus) => {
    if (!role.provider) {
      return (
        <span className={`${styles.roleState} ${styles.roleMissing}`}>
          <i className="codicon codicon-circle-slash" />
          {t("setup-not-configured")}
        </span>
      )
    }
    if (role.pending) {
      return (
        <span className={`${styles.roleState} ${styles.rolePending}`}>
          <i className="codicon codicon-loading codicon-modifier-spin" />
          {t("testing")}
        </span>
      )
    }
    if (!role.result) {
      return (
        <span className={`${styles.roleState} ${styles.roleUnknown}`}>
          <i className="codicon codicon-circle-large-outline" />
          {t("setup-not-checked")}
        </span>
      )
    }
    if (role.result.success) {
      return (
        <span className={`${styles.roleState} ${styles.roleOk}`}>
          <i className="codicon codicon-pass-filled" />
          {t("setup-working")}
          {role.result.latencyMs !== undefined && (
            <span className={styles.roleLatency}>{role.result.latencyMs} ms</span>
          )}
        </span>
      )
    }
    return (
      <span className={`${styles.roleState} ${styles.roleFailed}`}>
        <i className="codicon codicon-error" />
        {t("setup-failing")}
      </span>
    )
  }

  return (
    <section className={styles.setup}>
      <div className={styles.setupHeader}>
        <h4>{t("setup-title")}</h4>
        <VSCodeButton appearance="secondary" disabled={running} onClick={onRun}>
          <i
            className={`codicon codicon-${
              running ? "loading codicon-modifier-spin" : "beaker"
            }`}
          />
          {running ? t("testing") : t("setup-run")}
        </VSCodeButton>
      </div>

      <ul className={styles.roles}>
        {roles.map((role) => (
          <li key={role.type} className={styles.role}>
            <div className={styles.roleLine}>
              <i className={`codicon codicon-${ROLE_ICONS[role.type]}`} />
              <span className={styles.roleName}>{t(`type-${role.type}`)}</span>
              <span className={styles.roleProvider}>
                {role.provider
                  ? `${t(role.provider.label)} · ${role.provider.modelName}`
                  : ""}
              </span>
              {renderStatus(role)}
            </div>
            {!role.provider && (
              <div className={styles.roleDetail}>
                <span>{t(`setup-missing-${role.type}`)}</span>
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => onAdd(role.type)}
                >
                  {t(`add-${role.type}-provider`)}
                </button>
              </div>
            )}
            {role.provider && role.result && !role.result.success && (
              <div className={styles.roleDetail}>
                <span>{role.result.error}</span>
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => role.provider && onFix(role.provider)}
                >
                  {t("setup-fix")}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {allGood && (
        <p className={styles.setupAllGood}>
          <i className="codicon codicon-sparkle" />
          {t("setup-all-good")}
        </p>
      )}
    </section>
  )
}

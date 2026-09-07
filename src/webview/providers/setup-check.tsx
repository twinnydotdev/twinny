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

type RoleState = "missing" | "pending" | "unknown" | "ok" | "failed"

const stateOf = (role: RoleStatus): RoleState => {
  if (!role.provider) return "missing"
  if (role.pending) return "pending"
  if (!role.result) return "unknown"
  return role.result.success ? "ok" : "failed"
}

const STATE_ICONS: Record<RoleState, string> = {
  missing: "circle-slash",
  pending: "loading codicon-modifier-spin",
  unknown: "circle-large-outline",
  ok: "pass-filled",
  failed: "error"
}

const STATE_KEYS: Record<RoleState, string> = {
  missing: "setup-not-configured",
  pending: "testing",
  unknown: "setup-not-checked",
  ok: "setup-working",
  failed: "setup-failing"
}

/**
 * One row per job twinny does: which provider answers it and whether it
 * works. Clicking a row goes to the provider (or to adding one). Only a
 * job that needs attention gets a line of explanation underneath.
 */
export const SetupCheck = ({ roles, running, onRun, onAdd, onFix }: Props) => {
  const { t } = useTranslation()

  const needsNote = (role: RoleStatus) => {
    const state = stateOf(role)
    return state === "failed" || (state === "missing" && role.type !== "embedding")
  }

  return (
    <section className={styles.setup}>
      <div className={styles.setupHeader}>
        <h4>
          <i className="codicon codicon-checklist" />
          {t("setup-title")}
        </h4>
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
        {roles.map((role) => {
          const state = stateOf(role)
          const open = () => (role.provider ? onFix(role.provider) : onAdd(role.type))
          return (
            <li key={role.type} className={styles.role}>
              <button
                type="button"
                className={`${styles.roleLine} ${styles[`role-${state}`] || ""}`}
                title={role.provider ? t("setup-fix") : t(`add-${role.type}-provider`)}
                onClick={open}
              >
                <i className={`codicon codicon-${ROLE_ICONS[role.type]}`} />
                <span className={styles.roleName}>{t(`type-${role.type}`)}</span>
                {role.provider && (
                  <span className={styles.roleProvider}>
                    {t(role.provider.label)} · {role.provider.modelName}
                  </span>
                )}
                <span className={styles.roleState}>
                  <i className={`codicon codicon-${STATE_ICONS[state]}`} />
                  {t(STATE_KEYS[state])}
                </span>
              </button>
              {needsNote(role) && (
                <div className={styles.roleDetail}>
                  <span>
                    {role.provider
                      ? role.result?.error
                      : t(`setup-missing-${role.type}`)}
                  </span>
                  <button type="button" className={styles.linkButton} onClick={open}>
                    {role.provider ? t("setup-fix") : t(`add-${role.type}-provider`)}
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

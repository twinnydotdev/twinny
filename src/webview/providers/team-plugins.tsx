import React, { useState } from "react"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import { TEAM_PLUGINS_EVENT_NAME } from "../../common/constants"
import { messageOf } from "../../common/errors"
import { bridge, useServerState } from "../messaging"

import styles from "../styles/providers.module.css"

/**
 * The team gateway's page, one click away and signed in: the plugins an
 * admin shared with this developer, each opening on its own page, or the
 * whole admin page for an admin. Shown only when there is something to open.
 */
export const TeamPluginsCard = () => {
  const { data: status } = useServerState(TEAM_PLUGINS_EVENT_NAME.get)
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState("")

  // Only when there is something to open: a card with nothing to click is noise.
  if (!status?.available || (!status.admin && !status.plugins.length && !status.error)) return null

  const open = async (pluginId?: string) => {
    setOpening(pluginId ?? "")
    setError("")
    try {
      await bridge.request(TEAM_PLUGINS_EVENT_NAME.open, pluginId)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setOpening(null)
    }
  }

  const shared = status.plugins
  const title = status.admin ? "Your gateway's page" : "Your team's plugins"
  const summary = status.admin
    ? "Opens signed in, as an admin"
    : shared.length
      ? `${shared.length} shared with you · opens signed in`
      : "Opens signed in"

  return (
    <div className={`${styles.card} ${shared.length && !status.admin ? styles.cardActive : ""}`}>
      <div className={styles.cardMain}>
        <span className={styles.deviceState}>
          <i className={`codicon codicon-${status.admin ? "shield" : "extensions"}`} />
        </span>
        <div className={styles.cardText}>
          <div className={styles.cardTitle}>
            <span className={styles.cardLabel} title={status.gateway}>
              {title}
            </span>
            {!status.admin && shared.length > 0 && <span className={styles.cardBadge}>{shared.length}</span>}
          </div>
          <div className={styles.cardSummary} title={summary}>
            {summary}
          </div>
        </div>
        <div className={styles.cardActions}>
          <VSCodeButton
            appearance="secondary"
            disabled={opening !== null}
            title="Opens the gateway's page in your browser, signed in with your team key. The key is never shown or copied."
            onClick={() => void open()}
          >
            {opening === "" ? "Opening…" : "Open"}
          </VSCodeButton>
        </div>
      </div>

      {!status.admin && shared.length > 0 && (
        <ul className={styles.pluginList}>
          {shared.map((plugin) => (
            <li key={plugin.id}>
              <button type="button" disabled={opening !== null} onClick={() => void open(plugin.id)} title={`Open ${plugin.name} signed in`}>
                <span className={styles.pluginName}>{plugin.name}</span>
                {plugin.description && <span className={styles.pluginDescription}>{plugin.description}</span>}
                <i className={`codicon codicon-${opening === plugin.id ? "loading codicon-modifier-spin" : "link-external"}`} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {(error || status.error) && (
        <p className={styles.shareError} role="alert">
          {error || status.error}
        </p>
      )}
    </div>
  )
}

import React, { useEffect, useState } from "react"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import { TEAM_SHARE_EVENT_NAME } from "../../common/constants"
import { messageOf } from "../../common/errors"
import type { TeamShareBackend, TeamShareStatus } from "../../common/team"
import { bridge, useServerState } from "../messaging"

import styles from "../styles/providers.module.css"

const STATE_LABEL: Record<TeamShareStatus["state"], string> = {
  off: "Off",
  connecting: "Connecting…",
  online: "Online",
  reconnecting: "Reconnecting…"
}

const backendKey = (backend: TeamShareBackend) =>
  `${backend.provider}|${backend.apiProtocol}|${backend.apiHostname}|${backend.apiPort}`

const describeBackend = (backend: TeamShareBackend) =>
  `${backend.label} at ${backend.apiHostname}:${backend.apiPort}`

/**
 * This computer as part of the team's pool. Shown under the team banner
 * when the gateway pools teammates' computers, or while sharing is on.
 */
export const ShareCard = () => {
  const { data: status, refetch } = useServerState(TEAM_SHARE_EVENT_NAME.get)
  const [busy, setBusy] = useState(false)
  const [consenting, setConsenting] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState("")

  // The pool's wants and the local model list can change while the card
  // is open; the extension pushes changes, this is only a safety net.
  useEffect(() => {
    const timer = setInterval(refetch, 60_000)
    return () => clearInterval(timer)
  }, [refetch])

  if (!status || (!status.available && !status.enabled)) return null

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError("")
    try {
      await action()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const start = () => run(() => bridge.request(TEAM_SHARE_EVENT_NAME.start))
  const stop = () => run(() => bridge.request(TEAM_SHARE_EVENT_NAME.stop))
  const choose = () =>
    run(async () => {
      await bridge.request(TEAM_SHARE_EVENT_NAME.discover)
      setChoosing(true)
    })
  const pick = (backend: TeamShareBackend) =>
    run(async () => {
      await bridge.request(TEAM_SHARE_EVENT_NAME.setBackend, backend)
      setChoosing(false)
    })

  const sharing = status.enabled && !status.runningElsewhere
  const offered = status.wanted.filter((model) => status.models.includes(model))
  const missing = status.wanted.filter((model) => !status.models.includes(model))
  const summary = status.runningElsewhere
    ? "Sharing from another VS Code window"
    : sharing
      ? [
          STATE_LABEL[status.state],
          status.backendOk === false
            ? `${status.backend?.label ?? "The local server"} is not answering`
            : offered.length
              ? `sharing ${offered.join(", ")}`
              : status.state === "online"
                ? "none of the wanted models are local"
                : undefined,
          status.state === "online" ? `${status.served} request${status.served === 1 ? "" : "s"} served` : undefined
        ]
          .filter(Boolean)
          .join(" · ")
      : status.backend
        ? describeBackend(status.backend)
        : "Off"
  const active = sharing && status.state === "online"

  return (
    <div className={`${styles.card} ${active ? styles.cardActive : ""}`}>
      <div className={styles.cardMain}>
        <span className={`${styles.deviceState} ${active ? styles["deviceState-online"] : ""}`}>
          <i className={`codicon codicon-${sharing ? "broadcast" : "device-desktop"}`} />
        </span>
        <div className={styles.cardText}>
          <div className={styles.cardTitle}>
            <span className={styles.cardLabel} title={status.machine}>
              Share this computer with the team
            </span>
            {active && <span className={styles.cardBadge}>Sharing</span>}
          </div>
          <div className={styles.cardSummary} title={summary}>
            {summary}
          </div>
        </div>
        <div className={styles.cardActions}>
          {status.enabled ? (
            <VSCodeButton appearance="icon" title="Stop sharing" aria-label="Stop sharing" disabled={busy} onClick={() => void stop()}>
              <i className="codicon codicon-debug-stop" />
            </VSCodeButton>
          ) : (
            <VSCodeButton
              appearance="secondary"
              disabled={busy}
              title="Let teammates' requests run on this computer's local server through the gateway."
              onClick={() => setConsenting(true)}
            >
              Share
            </VSCodeButton>
          )}
        </div>
      </div>

      {consenting && !status.enabled && (
        <div className={styles.confirmRow}>
          <span>
            Teammates' prompts will run on this computer through {status.backend ? describeBackend(status.backend) : "your local server"} and are not stored here. Your gateway key identifies this computer to your admin.
          </span>
          <VSCodeButton appearance="secondary" disabled={busy} onClick={() => setConsenting(false)}>
            Cancel
          </VSCodeButton>
          <VSCodeButton
            appearance="primary"
            disabled={busy}
            onClick={() => {
              setConsenting(false)
              void start()
            }}
          >
            Start sharing
          </VSCodeButton>
        </div>
      )}

      {sharing && status.state === "online" && missing.length > 0 && (
        <p className={styles.shareHint}>
          The team is looking for {missing.join(", ")}.
          {status.backend?.provider === "ollama" && missing.length === 1 && (
            <>
              {" "}
              <code>ollama pull {missing[0]}</code> to help.
            </>
          )}
        </p>
      )}

      {(status.error || error) && (
        <p className={styles.shareError} role="alert">
          {error || status.error}
        </p>
      )}

      <div className={styles.shareFooter}>
        <span className={styles.fieldHint}>
          {status.backend ? `Shares ${describeBackend(status.backend)}` : "No local server chosen"}
        </span>
        <VSCodeButton appearance="secondary" disabled={busy} onClick={() => (choosing ? setChoosing(false) : void choose())}>
          {choosing ? "Close" : "Change server"}
        </VSCodeButton>
      </div>

      {choosing && (
        <ul className={styles.peerList}>
          {status.choices.length === 0 && <li className={styles.fieldHint}>No local model server answered.</li>}
          {status.choices.map((choice) => {
            const current = status.backend ? backendKey(choice) === backendKey(status.backend) : false
            return (
              <li key={backendKey(choice)}>
                <i className={`codicon codicon-${current ? "check" : "server"}`} />
                <span className={styles.peerName}>{describeBackend(choice)}</span>
                {!current && (
                  <VSCodeButton appearance="secondary" disabled={busy} onClick={() => void pick(choice)}>
                    Use
                  </VSCodeButton>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

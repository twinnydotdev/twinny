import React from "react"

import { AGENT_STORAGE_KEY } from "../../common/constants"
import { useGlobalContext } from "../hooks"

import styles from "../styles/mode-toggle.module.css"

export const ModeToggle = () => {
  const { context: agentActive = false, setContext: setAgentActive } =
    useGlobalContext<boolean>(AGENT_STORAGE_KEY)

  const handleToggle = () => {
    setAgentActive(!agentActive)
  }

  return (
    <div className={styles.toggleWrapper}>
      <div className={styles.modeLabel}>Agent:</div>
      <button
        onClick={handleToggle}
        className={styles.toggle}
        title={`Turn agent ${agentActive ? "off" : "on"}`}
      >
        <div className={`${styles.track} ${agentActive ? styles.active : ""}`}>
          <div
            className={`${styles.thumb} ${agentActive ? styles.active : ""}`}
          />
        </div>
      </button>
    </div>
  )
}

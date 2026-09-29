import React from "react"

import { TWINNY } from "../common/constants"
import { WorkspaceSearchReport } from "../common/messaging/protocol"

import WorkspaceContext from "./workspace-context"

import styles from "./styles/typing-indicator.module.css"

interface TypingIndicatorProps {
  /** The workspace search running for the reply that is on its way. */
  context?: WorkspaceSearchReport
}

const TypingIndicator = ({ context }: TypingIndicatorProps) => {
  return (
    <div className={styles.pending}>
      <div className={styles.label}>
        <span>{TWINNY}</span>
        <span className={styles.cursor} aria-hidden="true" />
      </div>
      {context && (
        <div className={styles.context}>
          <WorkspaceContext report={context} />
        </div>
      )}
    </div>
  )
}

export default TypingIndicator

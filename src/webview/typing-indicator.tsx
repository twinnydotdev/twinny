import React from "react"

import { TWINNY } from "../common/constants"

import styles from "./styles/typing-indicator.module.css"

const TypingIndicator = () => {
  return (
    <div className={styles.pending}>
      <span>{TWINNY}</span>
      <span className={styles.cursor} aria-hidden="true" />
    </div>
  )
}

export default TypingIndicator

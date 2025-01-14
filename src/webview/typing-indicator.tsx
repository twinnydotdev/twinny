import React from "react"

import styles from "./styles/index.module.css"

const TypingIndicator = () => {
  return (
    <div className={styles.typingIndicator}>
      <div className={styles.typingDot}></div>
      <div className={styles.typingDot}></div>
      <div className={styles.typingDot}></div>
    </div>
  )
}

export default TypingIndicator

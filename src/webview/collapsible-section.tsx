import React, { ReactNode } from "react"
import { Components } from "react-markdown"

import styles from "./styles/index.module.css"

interface CollapsibleSectionProps {
  title: string | ReactNode
  content?: string
  markdownComponents?: Components
  children?: ReactNode
}

export const CollapsibleSection = ({
  content,
  title,
  children
}: CollapsibleSectionProps) => {
  const [isExpanded, setIsExpanded] = React.useState(false)

  const handleToggle = () => {
    setIsExpanded(!isExpanded)
  }

  return (
    <div className={styles.collapseSection}>
      <div className={styles.collapseHeader} onClick={handleToggle}>
        <span>{title}</span>
        <span
          className={`codicon ${
            isExpanded ? "codicon-chevron-down" : "codicon-chevron-right"
          }`}
        />
      </div>
      <div
        className={`${styles.collapseContent} ${
          !isExpanded ? styles.collapsed : ""
        }`}
      >
        <div className={styles.fadeContent}>
          {children ? children : content}
        </div>
      </div>
    </div>
  )
}

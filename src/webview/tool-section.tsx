import React, { ReactNode } from "react"
import { Components } from "react-markdown"

import styles from "./styles/index.module.css"

interface toolDetailsProps {
  title: string | ReactNode
  content?: string
  markdownComponents?: Components
  children?: ReactNode
}

export const ToolDetails = ({
  content,
  title,
  children
}: toolDetailsProps) => {
  return (
    <div className={styles.toolDetails}>
      <div className={styles.toolHeader}>
        {title}
      </div>
      <div className={styles.toolContent} >
        {children ? children : content}
      </div>
    </div>
  )
}

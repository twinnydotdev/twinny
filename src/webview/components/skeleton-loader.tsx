import React from "react"

import styles from "../styles/skeleton-loader.module.css"

export const SkeletonLoader = () => {
  return (
    <div className={styles.skeletonContainer}>
      <div className={styles.skeletonLine}></div>
      <div className={styles.skeletonLine}></div>
      <div className={styles.skeletonLine}></div>
    </div>
  )
}

export default SkeletonLoader

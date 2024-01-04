import { createRoot } from 'react-dom/client'

import { Chat } from './chat'
import { Settings } from './settings'
import { NewSession } from './new-session'

import styles from './index.module.css'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).vscode = window.acquireVsCodeApi()

const container = document.querySelector('#root')

if (container) {
  const root = createRoot(container)
  root.render(
    <>
      <div className={styles.controlBar}>
        <NewSession />
        <Settings />
      </div>
      <Chat />
    </>
  )
}

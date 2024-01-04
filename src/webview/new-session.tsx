import { VSCodeButton } from '@vscode/webview-ui-toolkit/react'

import styles from './index.module.css'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

const key = 'lastConversation'

export const NewSession = () => {
  const handleClickClearSession = (): void => {
    global.vscode.postMessage({
      type: 'setTwinnyWorkSpaceContext',
      key,
      data: []
    })
    global.vscode.postMessage({
      type: 'getTwinnyWorkspaceContext',
      key
    })
  }

  return (
    <div className={styles.settings}>
      <VSCodeButton
        title="New chat session"
        appearance="icon"
        onClick={handleClickClearSession}
      >
        <ClearChatIcon />
      </VSCodeButton>
    </div>
  )
}

function ClearChatIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M2 21l4-4h12a2 2 0 002-2V3a2 2 0 00-2-2H4a2 2 0 00-2 2v16z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M9 6l6 6M15 6l-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

import { VSCodeButton } from '@vscode/webview-ui-toolkit/react'

import { MESSAGE_KEY, MESSAGE_NAME } from './constants'
import { ClearChatIcon } from './icons'

import styles from './index.module.css'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const NewSession = () => {
  const handleClickClearSession = (): void => {
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnySetWorkspaceContext,
      key: MESSAGE_KEY.lastConversation,
      data: []
    })
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyWorkspaceContext,
      key: MESSAGE_KEY.lastConversation
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

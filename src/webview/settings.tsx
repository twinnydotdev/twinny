import { VSCodeButton } from '@vscode/webview-ui-toolkit/react'

import { MESSAGE_NAME } from './constants'
import { SvgSettings } from './icons'

import styles from './index.module.css'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const Settings = () => {
  const handleClickSettings = (): void => {
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyOpenSettings
    })
  }

  return (
    <div className={styles.settings}>
      <VSCodeButton
        title="Open extension settings"
        appearance="icon"
        onClick={handleClickSettings}
      >
        <SvgSettings />
      </VSCodeButton>
    </div>
  )
}



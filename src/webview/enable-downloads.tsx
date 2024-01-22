import { VSCodeButton } from '@vscode/webview-ui-toolkit/react'

import { MESSAGE_KEY, MESSAGE_NAME } from '../constants'
import { DownloadIcon } from './icons'

import styles from './index.module.css'
import { useGlobalContext } from './hooks'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const EnableDownloads = () => {
  const { context: hasCancelledDownload, setContext: setDownloadsCancelled } =
    useGlobalContext<boolean>(MESSAGE_KEY.downloadCancelled)

  if (!hasCancelledDownload) {
    return null
  }

  const handleClickEnableDownloads = (): void => {
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnySetGlobalContext,
      key: MESSAGE_KEY.downloadCancelled,
      data: false
    })
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyNotification,
      data: 'twinny automatic model download enabled, restart vscode to activate.'
    })
    setDownloadsCancelled(false)
  }

  return (
    <div className={styles.settings}>
      <VSCodeButton
        title="Automatic model download disabled, click to enable"
        appearance="icon"
        onClick={handleClickEnableDownloads}
      >
        <DownloadIcon />
      </VSCodeButton>
    </div>
  )
}

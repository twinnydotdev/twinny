import { useSymmetryConnection } from './hooks'
import {
  VSCodeButton,
  VSCodePanelView,
  VSCodeDivider,
  VSCodeBadge
} from '@vscode/webview-ui-toolkit/react'

import styles from './symmetry.module.css'
import { TWINNY_COMMAND_NAME } from '../common/constants'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const Symmetry = () => {
  const {
    isConnected,
    connectToSymmetry,
    disconnectSymmetry,
    connecting,
    symmetryConnection
  } = useSymmetryConnection()

  const handleConnectSymmetry = () => connectToSymmetry()
  const handleDisconnectSymmetry = () => disconnectSymmetry()

  const handleOpenSettings = () => {
    global.vscode.postMessage({
      type: TWINNY_COMMAND_NAME.settings,
    });
  };

  const ConnectionStatus = () => {
    if (connecting) {
      return <span>Connecting, this can take a while sometimes...</span>
    }

    return (
      <span className={isConnected ? styles.connected : styles.disconnected}>
        {isConnected ? 'Connected' : 'Not connected'}
      </span>
    )
  }

  return (
    <div className={styles.symmetryContainer}>
    <h3>
      Symmetry <VSCodeBadge>Alpha</VSCodeBadge>
    </h3>
    <VSCodePanelView>
      <div className={styles.symmetryPanel}>
        <div className={styles.statusSection}>
          <p>Connection status: <ConnectionStatus /></p>
        </div>

        {isConnected && (
          <div className={styles.providerInfo}>
            <p><b>Provider name:</b> {symmetryConnection?.name}</p>
            <p><b>Provider model:</b> {symmetryConnection?.modelName}</p>
            <p><b>Provider type:</b> {symmetryConnection?.provider}</p>
          </div>
        )}

        <p>
          Symmetry is a peer-to-peer AI inference network. It enables users to
          connect directly and securely with each other. When you connect to
          Symmetry, the system attempts to match you with a provider based on
          the <a href='#' onClick={handleOpenSettings}>twinny extension settings</a> for symmetryModelName and symmetryProvider.
        </p>

        <p>
          To explore available providers on the Symmetry network or learn how
          to become a provider yourself, visit the{' '}
          <a href="https://twinny.dev/symmetry" target="_blank" rel="noopener noreferrer">
            Symmetry connections page
          </a>.
        </p>

        <div className={styles.buttonContainer}>
          <VSCodeButton onClick={isConnected ? handleDisconnectSymmetry : handleConnectSymmetry}>
            {connecting ? 'Connecting...' : isConnected ? 'Disconnect from Symmetry' : 'Connect to Symmetry'}
          </VSCodeButton>
        </div>

        <VSCodeDivider />

        <p>
          To learn more about Symmetry, visit the{' '}
          <a href="https://twinnydotdev.github.io/twinny-docs/general/symmetry" target="_blank" rel="noopener noreferrer">
            documentation
          </a>.
        </p>
      </div>
    </VSCodePanelView>
  </div>
  )
}

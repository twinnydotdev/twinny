import React from 'react'
import { useSymmetryConnection } from './hooks'
import {
  VSCodeButton,
  VSCodePanelView,
  VSCodeDivider,
  VSCodeBadge
} from '@vscode/webview-ui-toolkit/react'

import styles from './symmetry.module.css'

export const Symmetry = () => {
  const { isConnected, connectToSymmetry, disconnectSymmetry, connecting } =
    useSymmetryConnection()

  const handleConnectSymmetry = () => connectToSymmetry()
  const handleDisconnectSymmetry = () => disconnectSymmetry()

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
      <h3>Symmetry <VSCodeBadge>Alpha</VSCodeBadge></h3>
      <VSCodePanelView>
        <div className={styles.symmetryPanel}>
          <div className={styles.statusSection}>
            <p>
              Connection status: <ConnectionStatus />
            </p>
          </div>
          <div className={styles.buttonContainer}>
            {!isConnected ? (
              <VSCodeButton onClick={handleConnectSymmetry}>
                {connecting ? 'Connecting...' : 'Connect to Symmetry'}
              </VSCodeButton>
            ) : (
              <VSCodeButton onClick={handleDisconnectSymmetry}>
                Disconnect from Symmetry
              </VSCodeButton>
            )}
          </div>
          <VSCodeDivider />
          <p className={styles.alphaNotice}>
            <strong>Note:</strong> Symmetry is currently in alpha. Connections may be unstable or fail, especially when there are few active providers on the network.
          </p>
          <p>
            Symmetry is the experimental peer-to-peer network for Twinny. It aims to enable users to
            connect with each other and share computational resources, enhancing
            collaboration and distributed processing capabilities. As an alpha feature,
            it may be unreliable or change significantly in future updates.
          </p>
          <p>
            To learn more about Symmetry and its current status, visit the{' '}
            <a
              href="https://twinnydotdev.github.io/twinny-docs/general/symmetry"
              target="_blank"
              rel="noopener noreferrer"
            >
              the documentation.
            </a>.
          </p>
        </div>
      </VSCodePanelView>
    </div>
  )
}

import React from 'react'
import { useSymmetryConnection } from './hooks'
import {
  VSCodeButton,
  VSCodePanelView,
  VSCodeCheckbox,
  VSCodeLink,
} from '@vscode/webview-ui-toolkit/react'

import styles from './symmetry.module.css'

export const Symmetry = () => {
  const {
    isConnected,
    connectToSymmetry,
    disconnectSymmetry,
    setAutoConnect,
    autoConnect,
    connecting
  } = useSymmetryConnection()

  const handleConnectSymmetry = () => connectToSymmetry()
  const handleDisconnectSymmetry = () => disconnectSymmetry()
  const handleAutoConnect = () => setAutoConnect(!autoConnect)

  const ConnectionStatus = () => {
    if (connecting) {
      return (
        <span>Connecting...</span>
      )
    }

    return (
      <span className={isConnected ? styles.connected : styles.disconnected}>
        {isConnected ? 'Connected' : 'Not connected'}
      </span>
    )
  }

  return (
    <div className={styles.symmetryContainer}>
      <h3>Symmetry</h3>
      <VSCodePanelView>
        <div className={styles.symmetryPanel}>
          <p>
            Symmetry is the peer-to-peer network for Twinny. It enables users to
            connect with each other and share computational resources, enhancing
            collaboration and distributed processing capabilities.
          </p>
          <p>
            To learn more about Symmetry and its features, visit the{' '}
            <VSCodeLink href="https://twinny.dev/symmetry" target="_blank" rel="noopener noreferrer">
              official Symmetry website
            </VSCodeLink>
            . There you can find detailed documentation, usage examples, and information
            on how Symmetry integrates with Twinny to create a powerful, decentralized
            computing network.
          </p>
          <div className={styles.statusSection}>
            <p>
              Connection status: <ConnectionStatus />
            </p>
          </div>
          <label htmlFor="auto-connect" className={styles.checkboxLabel}>
            <VSCodeCheckbox
              id="auto-connect"
              name="auto-connect"
              onChange={handleAutoConnect}
              checked={autoConnect}
            />
            <span>Automatically connect to Symmetry on startup</span>
          </label>
          <div className={styles.buttonContainer}>
            {!isConnected ? (
              <VSCodeButton
                onClick={handleConnectSymmetry}
              >
                {connecting ? 'Connecting...' : 'Connect to Symmetry'}
              </VSCodeButton>
            ) : (
              <VSCodeButton onClick={handleDisconnectSymmetry}>
                Disconnect from Symmetry
              </VSCodeButton>
            )}
          </div>
        </div>
      </VSCodePanelView>
    </div>
  )
}

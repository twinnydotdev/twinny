import React from 'react'
import { useSymmetryConnection } from './hooks'
import {
  VSCodeButton,
  VSCodePanelView,
  VSCodeDivider,
  VSCodeCheckbox
} from '@vscode/webview-ui-toolkit/react'

import styles from './symmetry.module.css'
import { TWINNY_COMMAND_NAME } from '../common/constants'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const Symmetry = () => {
  const {
    connectAsProvider,
    connecting,
    connectToSymmetry,
    disconnectAsProvider,
    disconnectSymmetry,
    isConnected,
    symmetryConnection,
    symmetryProviderStatus,
    autoConnectProviderContext,
    isProviderConnected,
    setAutoConnectProviderContext
  } = useSymmetryConnection()


  const handleOpenSettings = () => {
    global.vscode.postMessage({
      type: TWINNY_COMMAND_NAME.settings
    })
  }

  const handleAutoConnectProviderChange = (
    e: React.MouseEvent<HTMLInputElement, MouseEvent>
  ) => {
    const target = e.target as HTMLInputElement
    console.log(target.checked, target.value)
    setAutoConnectProviderContext(target.checked)
  }

  const ConnectionStatus = () => (
    <span className={isConnected ? styles.connected : styles.disconnected}>
      {connecting
        ? 'Connecting...'
        : isConnected
        ? 'Connected'
        : 'Not connected'}
    </span>
  )

  const ProviderConnectionStatus = () => (
    <span
      className={isProviderConnected ? styles.connected : styles.disconnected}
    >
      {symmetryProviderStatus === 'connecting'
        ? 'Connecting...'
        : isProviderConnected
        ? 'Connected'
        : 'Not connected'}
    </span>
  )

  return (
    <div className={styles.symmetryContainer}>
      <h3>Symmetry Inference Network</h3>
      <p>
        Symmetry is a peer-to-peer AI inference network that allows secure,
        direct connections between users. When you connect as a consumer,
        Symmetry matches you with a provider based on your{' '}
        <a href="#" onClick={handleOpenSettings}>
          twinny extension settings
        </a>{' '}
        for <code>symmetryModelName</code> and <code>symmetryProvider</code>.
      </p>
      <p>
        You can also share your GPU resources by connecting to Symmetry as a
        provider using your active twinny provider configuration. All
        connections are peer to peer, encrypted end-to-end and secure.
      </p>
      <VSCodePanelView>
        <div className={styles.symmetryPanel}>
          <h4>Consumer Connection</h4>
          <div className={styles.statusSection}>
            <p>
              Status: <ConnectionStatus />
            </p>
          </div>
          {isConnected && (
            <div className={styles.providerInfo}>
              <p>
                <b>Provider name:</b> {symmetryConnection?.name}
              </p>
              <p>
                <b>Provider model:</b> {symmetryConnection?.modelName}
              </p>
              <p>
                <b>Provider type:</b> {symmetryConnection?.provider}
              </p>
            </div>
          )}
          <p>
            To explore available providers, visit the{' '}
            <a
              href="https://twinny.dev/symmetry"
              target="_blank"
              rel="noopener noreferrer"
            >
              Symmetry providers page
            </a>
            .
          </p>
          <div className={styles.buttonContainer}>
            <VSCodeButton
              onClick={isConnected ? disconnectSymmetry : connectToSymmetry}
            >
              {connecting
                ? 'Connecting...'
                : isConnected
                ? 'Disconnect'
                : 'Connect'}
            </VSCodeButton>
          </div>

          <VSCodeDivider />

          <h4>Provider Connection</h4>
          <p>
            Provider status: <ProviderConnectionStatus />
          </p>
          <div className={styles.buttonContainer}>
            <VSCodeButton
              onClick={
                isProviderConnected ? disconnectAsProvider : connectAsProvider
              }
            >
              {symmetryProviderStatus === 'connecting'
                ? 'Connecting...'
                : isProviderConnected
                ? 'Disconnect'
                : 'Connect'}
            </VSCodeButton>
          </div>
          <div className={styles.checkboxContainer}>
            <VSCodeCheckbox
              checked={autoConnectProviderContext}
              onClick={handleAutoConnectProviderChange}
            >
              Auto-connect as provider
            </VSCodeCheckbox>
          </div>
          {isProviderConnected && (
            <p>
              You should now be visible on the{' '}
              <a
                href="https://twinny.dev/symmetry"
                target="_blank"
                rel="noopener noreferrer"
              >
                Symmetry providers page
              </a>
              . For a more permanent connection, consider using the{' '}
              <code>symmetry-cli</code> package. Visit the{' '}
              <a
                href="https://github.com/twinnydotdev/symmetry-cli"
                target="_blank"
                rel="noopener noreferrer"
              >
                Symmetry CLI repository
              </a>{' '}
              to get started.
            </p>
          )}

          <VSCodeDivider />

          <p>
            For more information about Symmetry, please refer to our{' '}
            <a
              href="https://twinnydotdev.github.io/twinny-docs/general/symmetry"
              target="_blank"
              rel="noopener noreferrer"
            >
              documentation
            </a>
            .
          </p>
        </div>
      </VSCodePanelView>
    </div>
  )
}

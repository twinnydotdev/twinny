import React, { useEffect } from "react"
import { useTranslation } from "react-i18next"
import {
  VSCodeButton,
  VSCodeCheckbox,
  VSCodeDivider,
  VSCodePanelView,
} from "@vscode/webview-ui-toolkit/react"

import { useSymmetryConnection } from "./hooks"

import styles from "./styles/symmetry.module.css"

const ProviderConnectionStatus = ({
  isProviderConnected,
  status
}: {
  isProviderConnected: boolean;
  status: string | undefined;
}) => (
  <span className={isProviderConnected ? styles.connected : styles.disconnected}>
    {status === "connecting"
      ? "Connecting..."
      : isProviderConnected
        ? "Connected"
        : "Not connected"}
  </span>
)

const Step = ({ number, title, description }: { number: number; title: string; description: string | React.ReactNode }) => (
  <div className={styles.step}>
    <div className={styles.stepNumber}>{number}</div>
    <div className={styles.stepContent}>
      <div className={styles.stepTitle}>{title}</div>
      <div className={styles.stepDescription}>{description}</div>
    </div>
  </div>
)

export const Symmetry = () => {
  const { t } = useTranslation()
  const {
    connectAsProvider,
    disconnectAsProvider,
    symmetryProviderStatus,
    autoConnectProviderContext,
    isProviderConnected,
    setAutoConnectProviderContext,
    providers,
    getModels,
    selectedModel,
    setSelectedModel,
  } = useSymmetryConnection()

  const handleAutoConnectProviderChange = (
    e: React.MouseEvent<HTMLInputElement, MouseEvent>
  ) => {
    const target = e.target as HTMLInputElement
    setAutoConnectProviderContext(target.checked)
  }

  useEffect(() => {
    if (providers.length > 0 && !selectedModel) {
      setSelectedModel(providers[0])
    }
  }, [providers, selectedModel])

  useEffect(() => {
    getModels()
  }, [])

  return (
    <VSCodePanelView className={styles.symmetryContainer}>
      <div>
        <h3>Become a Symmetry Provider</h3>

        <div className={styles.stepContainer}>
          <Step
            number={1}
            title="What is a Symmetry Provider?"
            description="As a provider, you share your GPU resources with other users in the Symmetry network. All connections are peer-to-peer, encrypted end-to-end, and secure."
          />

          <Step
            number={2}
            title="Check Your Connection Status"
            description={
              <ProviderConnectionStatus
                isProviderConnected={isProviderConnected}
                status={symmetryProviderStatus}
              />
            }
          />

          <Step
            number={3}
            title="Connect to the Network"
            description={
              <>
                <div className={styles.infoText}>
                  Click the button below to connect to the Symmetry network as a provider.
                </div>
                <div className={styles.buttonContainer}>
                  <VSCodeButton
                    onClick={isProviderConnected ? disconnectAsProvider : connectAsProvider}
                  >
                    {symmetryProviderStatus === "connecting"
                      ? t("connecting")
                      : isProviderConnected
                        ? t("disconnect")
                        : t("connect")}
                  </VSCodeButton>
                </div>
              </>
            }
          />

          <Step
            number={4}
            title="Auto-Connect Settings"
            description={
              <div className={styles.checkboxContainer}>
                <VSCodeCheckbox
                  checked={autoConnectProviderContext}
                  onClick={handleAutoConnectProviderChange}
                >
                  {t("auto-connect-as-provider")}
                </VSCodeCheckbox>
              </div>
            }
          />
        </div>

        <VSCodeDivider />

        {isProviderConnected ? (
          <section>
            <h4>🎉 Successfully Connected!</h4>
            <div className={styles.infoText}>
              You are now visible on the <a href="https://twinny.dev/symmetry" target="_blank" rel="noopener noreferrer">Symmetry providers page</a>.
              Other users can connect to your provider and use your GPU resources.
            </div>
            <div className={styles.infoText}>
              <b>For a more permanent connection:</b> Consider using the <code>symmetry-cli</code> package.
              Visit the <a href="https://github.com/twinnydotdev/symmetry-cli" target="_blank" rel="noopener noreferrer">Symmetry CLI repository</a> to get started.
            </div>
          </section>
        ) : (
          <section>
            <h4>Benefits of Being a Provider</h4>
            <div className={styles.infoText}>
              • Share your GPU resources with the community
            </div>
            <div className={styles.infoText}>
              • Help others access AI capabilities
            </div>
            <div className={styles.infoText}>
              • All connections are secure and encrypted
            </div>
            <div className={styles.infoText}>
              • Easy to set up and configure
            </div>
          </section>
        )}

        <div className={styles.infoText}>
          <a href="https://twinny.dev/symmetry" target="_blank" rel="noopener noreferrer">
            Visit the Symmetry providers page
          </a> to see all available providers in the network.
        </div>
      </div>
    </VSCodePanelView>
  )
}

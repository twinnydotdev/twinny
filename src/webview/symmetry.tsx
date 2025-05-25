import React, { useEffect } from "react"
import { useTranslation } from "react-i18next"
import {
  VSCodeButton,
  VSCodeCheckbox,
  VSCodeDivider,
  VSCodePanelView,
} from "@vscode/webview-ui-toolkit/react"

import { useSymmetryConnection } from "./hooks/useSymmetryConnection"

import styles from "./styles/symmetry.module.css"

const ProviderConnectionStatus = ({
  isProviderConnected,
  status
}: {
  isProviderConnected: boolean;
  status: string | undefined;
}) => {
  const { t } = useTranslation()
  return (
    <span className={isProviderConnected ? styles.connected : styles.disconnected}>
      {status === "connecting"
        ? t("symmetry-connection-status-connecting")
        : isProviderConnected
          ? t("symmetry-connection-status-connected")
          : t("symmetry-connection-status-not-connected")}
    </span>
  )
}

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
        <h3>{t("symmetry-become-provider-title")}</h3>

        <div className={styles.stepContainer}>
          <Step
            number={1}
            title={t("symmetry-what-is-provider-title")}
            description={t("symmetry-what-is-provider-description")}
          />

          <Step
            number={2}
            title={t("symmetry-check-status-title")}
            description={
              <ProviderConnectionStatus
                isProviderConnected={isProviderConnected}
                status={symmetryProviderStatus}
              />
            }
          />

          <Step
            number={3}
            title={t("symmetry-connect-network-title")}
            description={
              <>
                <div className={styles.infoText}>
                  {t("symmetry-connect-network-description")}
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
            title={t("symmetry-auto-connect-title")}
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
            <h4>{t("symmetry-connection-success-title")}</h4>
            <div className={styles.infoText}>
              {t("symmetry-connection-success-message")}{" "}
              <a href="https://twinny.dev/symmetry" target="_blank" rel="noopener noreferrer">
                {t("symmetry-visit-providers-page-link")}
              </a>.
            </div>
            <div className={styles.infoText}>
              <b>{t("symmetry-permanent-connection-info")}</b>{" "}
              <a href="https://github.com/twinnydotdev/symmetry-cli" target="_blank" rel="noopener noreferrer">
                {t("symmetry-visit-cli-repo-link")}
              </a>
            </div>
          </section>
        ) : (
          <section>
            <h4>{t("symmetry-benefits-title")}</h4>
            <div className={styles.infoText}>
              {t("symmetry-benefit-item1")}
            </div>
            <div className={styles.infoText}>
              {t("symmetry-benefit-item2")}
            </div>
            <div className={styles.infoText}>
              {t("symmetry-benefit-item3")}
            </div>
            <div className={styles.infoText}>
              {t("symmetry-benefit-item4")}
            </div>
          </section>
        )}

        <div className={styles.infoText}>
          <a href="https://twinny.dev/symmetry" target="_blank" rel="noopener noreferrer">
            {t("symmetry-visit-providers-page-link")}
          </a>{" "}
          {/* This part of the sentence might need adjustment based on full context */}
          to see all available providers in the network.
        </div>
      </div>
    </VSCodePanelView>
  )
}

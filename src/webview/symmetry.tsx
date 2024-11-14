import React, { useEffect } from "react"
import { useTranslation } from "react-i18next"
import {
  VSCodeButton,
  VSCodeCheckbox,
  VSCodeDivider,
  VSCodeDropdown,
  VSCodeOption,
  VSCodePanelView,
} from "@vscode/webview-ui-toolkit/react"

import { useSymmetryConnection } from "./hooks"

import styles from "./styles/symmetry.module.css"

export const Symmetry = () => {
  const { t } = useTranslation()
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
    setAutoConnectProviderContext,
    models,
    selectedModel,
    setSelectedModel,
  } = useSymmetryConnection()

  const handleAutoConnectProviderChange = (
    e: React.MouseEvent<HTMLInputElement, MouseEvent>
  ) => {
    const target = e.target as HTMLInputElement
    console.log(target.checked, target.value)
    setAutoConnectProviderContext(target.checked)
  }

  const handleModelChange = (e: unknown): void => {
    const event = e as React.ChangeEvent<HTMLSelectElement>
    const modelId = Number(event.target.value)
    const newSelectedModel =
      models.find((model) => model.id === modelId) || null
    setSelectedModel(newSelectedModel)
  }

  const ConnectionStatus = () => (
    <span className={isConnected ? styles.connected : styles.disconnected}>
      {connecting
        ? "Connecting..."
        : isConnected
        ? "Connected"
        : "Not connected"}
    </span>
  )

  const ProviderConnectionStatus = () => (
    <span
      className={isProviderConnected ? styles.connected : styles.disconnected}
    >
      {symmetryProviderStatus === "connecting"
        ? "Connecting..."
        : isProviderConnected
        ? "Connected"
        : "Not connected"}
    </span>
  )

  useEffect(() => {
    if (models.length > 0 && !selectedModel) {
      setSelectedModel(models[0])
    }
  }, [models, selectedModel])

  return (
    <div className={styles.symmetryContainer}>
      <h3>
        {t("symmetry-inference-network")}
      </h3>
      <VSCodePanelView>
        <div className={styles.symmetryPanel}>
          <h4>
            {t("consumer-connection")}
          </h4>
          <div className={styles.statusSection}>
            <p>
              {t("status")}: <ConnectionStatus />
            </p>
          </div>
          {isConnected && (
            <div className={styles.providerInfo}>
              <p>
                <b>{t("provider-name")}:</b> {symmetryConnection?.name}
              </p>
              <p>
                <b>{t("model-name")}:</b> {symmetryConnection?.modelName}
              </p>
              <p>
                <b>{t("provider-type")}:</b> {symmetryConnection?.provider}
              </p>
            </div>
          )}
          {!isConnected && (
            <div className={styles.dropdownContainer}>
              <label htmlFor="modelSelect">Select a model</label>
              {models.length ? (
                <VSCodeDropdown
                  id="modelSelect"
                  value={selectedModel?.id.toString()}
                  onChange={handleModelChange}
                >
                  {Array.from(new Set(models.map((model) => model.model_name)))
                    .sort((a, b) => a.localeCompare(b))
                    .map((modelName) => {
                      const model = models.find(
                        (m) => m.model_name === modelName
                      )
                      return (
                        <VSCodeOption
                          key={modelName}
                          value={model?.id.toString() ?? ""}
                        >
                          {modelName}
                        </VSCodeOption>
                      )
                    })}
                </VSCodeDropdown>
              ) : (
                <span>
                  {t("loading-available-models")}
                </span>
              )}
            </div>
          )}
          <div className={styles.buttonContainer}>
            <VSCodeButton
              disabled={!selectedModel || connecting}
              onClick={isConnected ? disconnectSymmetry : connectToSymmetry}
            >
              {connecting
                ? t("connecting")
                : isConnected
                ? t("disconnect")
                : t("connect")}
            </VSCodeButton>
          </div>

          <VSCodeDivider />

          <h4>
            {t("provider-connection")}
          </h4>
          <p>
            {t("status")}: <ProviderConnectionStatus />
          </p>
          <div className={styles.buttonContainer}>
            <VSCodeButton
              onClick={
                isProviderConnected ? disconnectAsProvider : connectAsProvider
              }
            >
              {symmetryProviderStatus === "connecting"
                ? t("connecting")
                : isProviderConnected
                ? t("disconnect")
                : t("connect")
              }
            </VSCodeButton>
          </div>
          <div className={styles.checkboxContainer}>
            <VSCodeCheckbox
              checked={autoConnectProviderContext}
              onClick={handleAutoConnectProviderChange}
            >
              {t("auto-connect-as-provider")}
            </VSCodeCheckbox>
          </div>
          {/* TODO Use Trans component */}
          {isProviderConnected && (
            <p>
              You should now be visible on the{" "}
              <a
                href="https://twinny.dev/symmetry"
                target="_blank"
                rel="noopener noreferrer"
              >
                Symmetry providers page
              </a>
              . For a more permanent connection, consider using the{" "}
              <code>symmetry-cli</code> package. Visit the{" "}
              <a
                href="https://github.com/twinnydotdev/symmetry-cli"
                target="_blank"
                rel="noopener noreferrer"
              >
                Symmetry CLI repository
              </a>{" "}
              to get started.
            </p>
          )}

          <VSCodeDivider />
          {/* TODO Use Trans component */}
          <p>
            For more information about Symmetry, please refer to our{" "}
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
      <p>
        {t("symmetry-description")}
      </p>
      <p>
        {t("share-gpu-resources")}
      </p>
      {/* TODO Use Trans component */}
      <p>
        To explore available providers, visit the{" "}
        <a
          href="https://twinny.dev/symmetry"
          target="_blank"
          rel="noopener noreferrer"
        >
          Symmetry providers page
        </a>
        .
      </p>
    </div>
  )
}

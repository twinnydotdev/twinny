import React, { FormEventHandler, useEffect } from "react"
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

const ConnectionStatus = ({ isConnected, connecting }: { isConnected: boolean; connecting: boolean }) => (
  <span className={isConnected ? styles.connected : styles.disconnected}>
    {connecting
      ? "Connecting..."
      : isConnected
      ? "Connected"
      : "Not connected"}
  </span>
)

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

type VSCodeDropdownHandler = ((e: Event) => unknown) & FormEventHandler<HTMLElement>

const ModelSelector = ({
  models,
  selectedModel,
  onChange,
  t
}: {
  models: Array<{ id: number; model_name: string }>;
  selectedModel: { id: number } | null;
  onChange: VSCodeDropdownHandler;
  t: (key: string) => string;
}) => (
  <div className={styles.dropdownContainer}>
    <label htmlFor="modelSelect">{t("select-model")}</label>
    {models.length ? (
      <VSCodeDropdown
        id="modelSelect"
        value={selectedModel?.id.toString()}
        onChange={onChange}
      >
        {Array.from(new Set(models.map((model) => model.model_name)))
          .sort((a, b) => a.localeCompare(b))
          .map((modelName) => {
            const model = models.find((m) => m.model_name === modelName)
            return (
              <VSCodeOption key={modelName} value={model?.id.toString() ?? ""}>
                {modelName}
              </VSCodeOption>
            )
          })}
      </VSCodeDropdown>
    ) : (
      <span>{t("loading-available-models")}</span>
    )}
  </div>
)

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

  const handleModelChange: VSCodeDropdownHandler = (e) => {
    const target = e.target as HTMLSelectElement
    const modelId = Number(target.value)
    const newSelectedModel = models.find((model) => model.id === modelId) || null
    setSelectedModel(newSelectedModel)
  }

  useEffect(() => {
    if (models.length > 0 && !selectedModel) {
      const symmetryProvider = models.find(provider => provider.name === "twinny-symmetry")

      if (symmetryProvider) {
        setSelectedModel(symmetryProvider)
      } else {
        setSelectedModel(models[0])
      }
    }
  }, [models, selectedModel])

  useEffect(() => {
    getModels()
  }, [])

  return (
    <VSCodePanelView className={styles.symmetryContainer}>
      <div className={styles.symmetryPanel}>
        <h3>{t("symmetry-inference-network")}</h3>

        <section>
          <h4>{t("consumer-connection")}</h4>
          <div className={styles.statusSection}>
            <span>{t("status")}: <ConnectionStatus isConnected={isConnected} connecting={connecting} /></span>
          </div>

          {isConnected && (
            <div className={styles.providerInfo}>
              <span><b>{t("provider-name")}:</b> {symmetryConnection?.name}</span>
              <span><b>{t("model-name")}:</b> {symmetryConnection?.modelName}</span>
              <span><b>{t("provider-type")}:</b> {symmetryConnection?.provider}</span>
            </div>
          )}

          {!isConnected && (
            <ModelSelector
              models={models}
              selectedModel={selectedModel}
              onChange={handleModelChange}
              t={t}
            />
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
        </section>

        <VSCodeDivider />

        <section>
          <h4>{t("provider-connection")}</h4>
          <div className={styles.statusSection}>
            <span>{t("status")}:
              <ProviderConnectionStatus
                isProviderConnected={isProviderConnected}
                status={symmetryProviderStatus}
              />
            </span>
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

          <div className={styles.checkboxContainer}>
            <VSCodeCheckbox
              checked={autoConnectProviderContext}
              onClick={handleAutoConnectProviderChange}
            >
              {t("auto-connect-as-provider")}
            </VSCodeCheckbox>
          </div>

          {isProviderConnected && (
            <div className={styles.infoText}>
              You should now be visible on the <a href="https://twinny.dev/symmetry" target="_blank" rel="noopener noreferrer">Symmetry providers page</a>.
              For a more permanent connection, consider using the <code>symmetry-cli</code> package.
              Visit the <a href="https://github.com/twinnydotdev/symmetry-cli" target="_blank" rel="noopener noreferrer">Symmetry CLI repository</a> to get started.
            </div>
          )}
        </section>

        <VSCodeDivider />

        <footer className={styles.footer}>
          <div className={styles.infoText}>
            For more information about Symmetry, please refer to our <a href="https://twinnydotdev.github.io/twinny-docs/general/symmetry" target="_blank" rel="noopener noreferrer">documentation</a>.
          </div>
          <div className={styles.infoText}>{t("symmetry-description")}</div>
          <div className={styles.infoText}>{t("share-gpu-resources")}</div>
          <div className={styles.infoText}>
            To explore available providers, visit the <a href="https://twinny.dev/symmetry" target="_blank" rel="noopener noreferrer">Symmetry providers page</a>.
          </div>
        </footer>
      </div>
    </VSCodePanelView>
  )
}

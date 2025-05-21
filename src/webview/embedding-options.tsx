import { FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { TextFieldType } from "@vscode/webview-ui-toolkit"
import {
  VSCodeButton,
  VSCodeDivider,
  VSCodeDropdown,
  VSCodeOption,
  VSCodeTextField
} from "@vscode/webview-ui-toolkit/react"

import {
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
} from "../common/constants"
import { ClientMessage } from "../common/types"

import { useGlobalContext, useProviders } from "./hooks"

import styles from "./styles/embedding-options.module.css"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const EmbeddingOptions = () => {
  const { t } = useTranslation()
  const {
    embeddingProvider,
    getProvidersByType,
    providers,
    setActiveEmbeddingsProvider
  } = useProviders()

  const { context: rerankThreshold = 0.5, setContext: setRerankThreshold } =
    useGlobalContext<number>(EXTENSION_CONTEXT_NAME.twinnyRerankThreshold)

  const { context: maxChunkSize = "500", setContext: setMaxChunkSize } =
    useGlobalContext<string>(EXTENSION_CONTEXT_NAME.twinnyMaxChunkSize)

  const { context: minChunkSize = "200", setContext: setMinChunkSize } =
    useGlobalContext<string>(EXTENSION_CONTEXT_NAME.twinnyMinChunkSize)

  const { context: overlap = "20", setContext: setOverlap } =
    useGlobalContext<string>(EXTENSION_CONTEXT_NAME.twinnyOverlapSize)

  const { context: codeSnippets = "5", setContext: setRelevantCodeSnippets } =
    useGlobalContext<string>(EXTENSION_CONTEXT_NAME.twinnyRelevantCodeSnippets)

  const { context: filePaths = "10", setContext: setRelevantFilePaths } =
    useGlobalContext<string>(EXTENSION_CONTEXT_NAME.twinnyRelevantFilePaths)

  const embeddingProviders = Object.values(getProvidersByType("embedding"))

  const handleEmbedDocuments = () => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyEmbedDocuments
    } as ClientMessage<string[]>)
  }

  const handleThresholdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value)
    setRerankThreshold(value)
  }

  const handleMaxChunkSizeChange = (e: Event | FormEvent<HTMLElement>) => {
    const event = e as unknown as React.ChangeEvent<HTMLInputElement>
    const { value } = event.target
    setMaxChunkSize(value)
  }

  const handleMinChunkSizeChange = (e: Event | FormEvent<HTMLElement>) => {
    const event = e as unknown as React.ChangeEvent<HTMLInputElement>
    const { value } = event.target
    setMinChunkSize(value)
  }

  const handleRelevantCodeSnippetsChange = (
    e: Event | FormEvent<HTMLElement>
  ) => {
    const event = e as unknown as React.ChangeEvent<HTMLInputElement>
    const { value } = event.target
    setRelevantCodeSnippets(value)
  }

  const handleRelevantFilepathsChange = (e: Event | FormEvent<HTMLElement>) => {
    const event = e as unknown as React.ChangeEvent<HTMLInputElement>
    const { value } = event.target
    setRelevantFilePaths(value)
  }

  const handleOverlapSizeChange = (e: Event | FormEvent<HTMLElement>) => {
    const event = e as unknown as React.ChangeEvent<HTMLInputElement>
    const { value } = event.target
    setOverlap(value)
  }

  const handleChangeEmbeddingProvider = (e: unknown): void => {
    const event = e as React.ChangeEvent<HTMLSelectElement>
    const value = event.target.value
    const provider = providers[value]
    setActiveEmbeddingsProvider(provider)
  }

  if (!embeddingProviders) {
    return (
      <div className={styles.embeddingOptions}>
        <p>
          No providers found for type: 'embedding', please add an embedding
          provider...
        </p>
      </div>
    )
  }

  return (
    <div className={styles.embeddingOptions}>
      <h3>{t("embeddings")}</h3>
      <div>
        <div>{t("embedding-provider")}</div>
        <VSCodeDropdown
          value={embeddingProvider?.id}
          name="provider"
          onChange={handleChangeEmbeddingProvider}
        >
          {embeddingProviders
            .sort((a, b) => a.modelName.localeCompare(b.modelName))
            .map((provider, index) => (
              <VSCodeOption key={index} value={provider.id}>
                {`${provider.label} (${provider.modelName})`}
              </VSCodeOption>
            ))}
        </VSCodeDropdown>
      </div>
      <div>
        <div>{t("max-chunk-size")}</div>
        <VSCodeTextField
          type={TextFieldType.text}
          value={maxChunkSize}
          name="provider"
          onChange={(e) => handleMaxChunkSizeChange(e)}
        />
      </div>
      <div>
        <div>{t("min-chunk-size")}</div>
        <VSCodeTextField
          value={minChunkSize}
          name="provider"
          onChange={(e) => handleMinChunkSizeChange(e)}
        />
      </div>
      <div>
        <div>{t("overlap-size")}</div>
        <VSCodeTextField
          value={overlap}
          name="provider"
          onChange={(e) => handleOverlapSizeChange(e)}
        />
      </div>
      <div>
        <VSCodeButton
          onClick={handleEmbedDocuments}
          className={styles.embedDocumentsButton}
        >
          {t("embed-documents")}
        </VSCodeButton>
      </div>
      <VSCodeDivider />
      <div>
        <div>{t("relevant-code-snippets")}</div>
        <VSCodeTextField
          value={codeSnippets}
          name="provider"
          onChange={(e) => handleRelevantCodeSnippetsChange(e)}
        />
        <small>{t("number-code-snippets")}</small>
      </div>
      <div>
        <div>Filepaths</div>
        <VSCodeTextField
          value={filePaths}
          name="provider"
          onChange={(e) => handleRelevantFilepathsChange(e)}
        />
        <small>{t("number-code-filepaths")}</small>
      </div>
      <div>
        <div>
          <label htmlFor="threshold">
            {t("rerank-threshold")} ({rerankThreshold})
          </label>
        </div>
        <input
          className={styles.slider}
          type="range"
          onChange={handleThresholdChange}
          id="threshold"
          name="threshold"
          min="0.05"
          max="0.15"
          value={rerankThreshold}
          step="0.01"
        />
        <div className={styles.sliderLabel}>
          <small>{t("rerank-threshold-description")}</small>
        </div>
      </div>
    </div>
  )
}

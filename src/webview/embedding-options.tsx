import {
  VSCodeButton,
  VSCodeDropdown,
  VSCodeOption,
  VSCodeCheckbox
} from '@vscode/webview-ui-toolkit/react'

import { EVENT_NAME, EXTENSION_CONTEXT_NAME } from '../common/constants'
import { ClientMessage } from '../common/types'
import { useGlobalContext, useProviders, useWorkSpaceContext } from './hooks'
import styles from './index.module.css'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const EmbeddingOptions = () => {
  const {
    embeddingProvider,
    getProvidersByType,
    providers,
    setActiveEmbeddingsProvider
  } = useProviders()

  const { context: enableRagContext, setContext: setEnableRagContext } =
    useWorkSpaceContext<boolean>(EXTENSION_CONTEXT_NAME.twinnyEnableRag)

  const { context: rerankThreshold = 0.1, setContext: setRerankThreshold } =
    useGlobalContext<number>(EXTENSION_CONTEXT_NAME.twinnyRerankThreshold)

  const embeddingProviders = Object.values(getProvidersByType('embedding'))

  const handleEmbedDocuments = () => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyEmbedDocuments
    } as ClientMessage<string[]>)
  }

  const handleThresholdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value)
    setRerankThreshold(value)
  }

  const handleChangeEmbeddingProvider = (e: unknown): void => {
    const event = e as React.ChangeEvent<HTMLSelectElement>
    const value = event.target.value
    const provider = providers[value]
    setActiveEmbeddingsProvider(provider)
  }

  const handleChangeEnableRag = (e: unknown): void => {
    const event = e as React.ChangeEvent<HTMLInputElement>
    const value = event.target.checked
    setEnableRagContext(() => {
      global.vscode.postMessage({
        type: EVENT_NAME.twinnySetWorkspaceContext,
        key: EXTENSION_CONTEXT_NAME.twinnyEnableRag,
        data: value
      } as ClientMessage)
      return value
    })
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
      <div>
        <div>Embedding provider</div>
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
        <div>
          <label htmlFor="threshold">
            Rerank probability threshold ({rerankThreshold})
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
          <small>
            The lower the threshold, the more likely a result is to be included.
          </small>
        </div>
      </div>
      <div>
        <div className={styles.vscodeCheckbox}>
          <label htmlFor="enableRag">
            <VSCodeCheckbox
              id="enableRag"
              name="enableRag"
              onClick={handleChangeEnableRag}
              checked={enableRagContext}
            ></VSCodeCheckbox>
            <span>Enable retrieval augmented generation (RAG)</span>
          </label>
        </div>
      </div>
      <div>
        <VSCodeButton
          onClick={handleEmbedDocuments}
          className={styles.embedDocumentsButton}
        >
          Embed workspace documents
        </VSCodeButton>
      </div>
    </div>
  )
}

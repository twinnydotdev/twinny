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

  const { context: rerankThreshold, setContext: setRerankThreshold } =
    useGlobalContext<number>(EXTENSION_CONTEXT_NAME.twinnyRerankThreshold, 0.007)

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

  return (
    <div className={styles.embeddingOptions}>
      <p>
        <div>Select embedding provider</div>
        <VSCodeDropdown
          value={embeddingProvider?.id}
          name="provider"
          onChange={handleChangeEmbeddingProvider}
        >
          {Object.values(getProvidersByType('embedding'))
            .sort((a, b) => a.modelName.localeCompare(b.modelName))
            .map((provider, index) => (
              <VSCodeOption key={index} value={provider.id}>
                {`${provider.label} (${provider.modelName})`}
              </VSCodeOption>
            ))}
        </VSCodeDropdown>
      </p>
      <p>
        <>
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
            min="0.002"
            max="0.01"
            value={rerankThreshold}
            step="0.0002"
          />
          <div>
            <small>
              The lower the threshold, the more documents will be returned (can
              be changed at any time).
            </small>
          </div>
        </>
      </p>
      <p>
        <div className={styles.vscodeCheckbox}>
          <label htmlFor="enableRag">
            <VSCodeCheckbox
              id="enableRag"
              name="enableRag"
              onClick={handleChangeEnableRag}
              checked={enableRagContext}
            ></VSCodeCheckbox>
            <span>
              Enable RAG (Retrival Augmented Generation)
            </span>
          </label>
        </div>
      </p>
      <p>
        <VSCodeButton
          onClick={handleEmbedDocuments}
          className={styles.embedDocumentsButton}
        >
          Embed workspace documents
        </VSCodeButton>
      </p>
    </div>
  )
}

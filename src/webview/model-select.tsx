import { VSCodeDropdown } from '@vscode/webview-ui-toolkit/react'
import { useOllamaModels } from './hooks'

import styles from './index.module.css'

export const ModelSelect = () => {
  const { models } = useOllamaModels()

  if (!models?.length) {
    return null
  }

  return (
    <div>
      <VSCodeDropdown className={styles.modelSelect}>
        {models?.map((model, index) => {
          return <option key={`${index}`}>{model.name}</option>
        })}
      </VSCodeDropdown>
    </div>
  )
}

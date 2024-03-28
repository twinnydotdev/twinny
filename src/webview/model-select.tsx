import {
  VSCodeDivider,
  VSCodeDropdown,
  VSCodeTextField
} from '@vscode/webview-ui-toolkit/react'

import { useModels } from './hooks'
import { getModelShortName } from './utils'
import { SETTING_KEY } from '../common/constants'

import styles from './index.module.css'
import { ApiProviders } from '../common/types'

interface ModelSelectProps {
  apiProvider: string | undefined
}

export const ModelSelect = ({ apiProvider }: ModelSelectProps) => {
  const { models, saveModel, fimModelName, chatModelName } = useModels()

  const handleOnChangeChat = (e: unknown): void => {
    const event = e as React.ChangeEvent<HTMLSelectElement>
    const selectedValue = event?.target.value || ''
    saveModel(selectedValue)(SETTING_KEY.chatModelName)
  }

  const handleOnChangeFim = (e: unknown): void => {
    const event = e as React.ChangeEvent<HTMLSelectElement>
    const selectedValue = event?.target.value || ''
    saveModel(selectedValue)(SETTING_KEY.fimModelName)
  }

  // TODO: Refactor to map
  if (apiProvider !== ApiProviders.Ollama) {
    return (
      <form className={styles.modelSelect}>
        <div>
          <label>Chat</label>
          <VSCodeTextField
            type="text"
            value={chatModelName || ''}
            onChange={handleOnChangeChat}
          />
        </div>
        <div>
          <label>Fill-in-middle</label>
          <VSCodeTextField
            type="text"
            value={fimModelName || ''}
            onChange={handleOnChangeFim}
          />
        </div>
      </form>
    )
  }

  return (
    <div className={styles.modelSelect}>
      <div>
        <label>Chat</label>
        <VSCodeDropdown onChange={handleOnChangeChat} value={chatModelName}>
          {models?.map((model, index) => {
            return (
              <option value={model.name} key={`${index}`}>
                {getModelShortName(model.name)}
              </option>
            )
          })}
        </VSCodeDropdown>
      </div>
      <div>
        <label>Fill-in-middle</label>
        <VSCodeDropdown onChange={handleOnChangeFim} value={fimModelName}>
          {models?.map((model, index) => {
            return (
              <option value={model.name} key={`${index}`}>
                {getModelShortName(model.name)}
              </option>
            )
          })}
        </VSCodeDropdown>
        <VSCodeDivider />
      </div>
    </div>
  )
}

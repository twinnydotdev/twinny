import { VSCodeDivider, VSCodeDropdown } from '@vscode/webview-ui-toolkit/react'

import { useOllamaModels } from './hooks'
import { getModelShortName } from './utils'
import { SETTING_KEY } from '../constants'

import styles from './index.module.css'

export const ModelSelect = () => {
  const { models, saveModel, fimModelName, chatModelName } = useOllamaModels()

  if (!models?.length) {
    return null
  }

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

import {
  VSCodeDivider,
  VSCodeDropdown,
  VSCodeTextField
} from '@vscode/webview-ui-toolkit/react'

import { useConfigurationSetting, useModels } from './hooks'
import { getModelShortName } from './utils'
import { SETTING_KEY } from '../common/constants'

import styles from './index.module.css'
import { ApiProviders } from '../common/types'

export const ModelSelect = () => {
  const { models, saveModel, fimModelName, chatModelName } = useModels()
  const { configurationSetting: apiProvider } = useConfigurationSetting(
    SETTING_KEY.apiProvider
  )
  const { configurationSetting: apiProviderFim } = useConfigurationSetting(
    SETTING_KEY.apiProviderFim
  )

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

  const isOllamaChat = apiProvider === ApiProviders.Ollama
  const isOllamaFim = apiProviderFim === ApiProviders.Ollama

  return (
    <div className={styles.twinnyForm}>
      {!isOllamaChat ? (
        <form className={styles.twinnyForm}>
          <div>
            <label>Chat</label>
            <VSCodeTextField
              type="text"
              value={chatModelName || ''}
              onChange={handleOnChangeChat}
            />
          </div>
        </form>
      ) : (
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
      )}
      {!isOllamaFim ? (
        <form className={styles.twinnyForm}>
          <div>
            <label>Fill-in-middle</label>
            <VSCodeTextField
              type="text"
              value={fimModelName || ''}
              onChange={handleOnChangeFim}
            />
          </div>
        </form>
      ) : (
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
      )}
    </div>
  )
}

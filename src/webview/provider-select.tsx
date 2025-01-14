import React from "react"
import { useTranslation } from "react-i18next"
import {
  VSCodeDropdown,
  VSCodeOption,
  VSCodeTextField
} from "@vscode/webview-ui-toolkit/react"

import { GLOBAL_STORAGE_KEY } from "../common/constants"
import { apiProviders } from "../common/types"

import { useGlobalContext, useModels, useOllamaModels, useProviders } from "./hooks"

import styles from "./styles/providers.module.css"

export const ProviderSelect = () => {
  const { t } = useTranslation()
  const ollamaModels = useOllamaModels()
  const { models } = useModels()
  const { getProvidersByType, setActiveChatProvider, providers, chatProvider } =
    useProviders()

  const providerModels =
    chatProvider?.provider === apiProviders.OpenAICompatible
      ? ollamaModels.models?.map(({ name }) => name) || []
      : models[chatProvider?.provider as keyof typeof models]?.models || []

  const {
    context: selectedModel,
    setContext: setSelectedModel
  } = useGlobalContext<string>(GLOBAL_STORAGE_KEY.selectedModel)

  React.useEffect(() => {
    if (chatProvider && providerModels.length && !selectedModel) {
      const defaultModel = providerModels[0]
      setSelectedModel(defaultModel)
      setActiveChatProvider({
        ...chatProvider,
        modelName: defaultModel
      })
    }
  }, [chatProvider?.id, providerModels.length])

  const handleChangeChatProvider = (e: unknown): void => {
    const event = e as React.ChangeEvent<HTMLSelectElement>
    const value = event.target.value
    const provider = providers[value]
    const defaultModel = models[provider.provider as keyof typeof models]?.models?.[0] || provider.modelName
    setSelectedModel(defaultModel)
    setActiveChatProvider({
      ...provider,
      modelName: defaultModel
    })
  }

  return (
    <div className={styles.providerSelector}>
      <div>
        <VSCodeDropdown
          value={chatProvider?.id || ""}
          name="provider"
          onChange={handleChangeChatProvider}
        >
          {Object.values(getProvidersByType("chat"))
            .sort((a, b) => a.modelName.localeCompare(b.modelName))
            .map((provider, index) => (
              <VSCodeOption key={index} value={provider.id}>
                {`${provider.label} (${provider.modelName})`}
              </VSCodeOption>
            ))}
        </VSCodeDropdown>
      </div>
      <div>
        {chatProvider?.id && providerModels.length > 0 ? (
          <VSCodeDropdown
            value={selectedModel || providerModels[0] || ""}
            name="model"
            onChange={(e: unknown) => {
              const event = e as React.ChangeEvent<HTMLSelectElement>
              setSelectedModel(event.target.value)
              if (chatProvider) {
                setActiveChatProvider({
                  ...chatProvider,
                  modelName: event.target.value
                })
              }
            }}
          >
            {(selectedModel && !providerModels.includes(selectedModel)
              ? [selectedModel, ...providerModels]
              : providerModels
            ).map((model: string, index: number) => (
              <VSCodeOption key={index} value={model}>
                {model}
              </VSCodeOption>
            ))}
          </VSCodeDropdown>
        ) : (
          <VSCodeTextField
            value={selectedModel || chatProvider?.modelName || ""}
            placeholder={t("Enter model name")}
            onChange={(e: unknown) => {
              const event = e as React.ChangeEvent<HTMLInputElement>
              const value = event.target.value.trim()
              if (!value) return
              setSelectedModel(value)
              if (chatProvider) {
                setActiveChatProvider({
                  ...chatProvider,
                  modelName: value
                })
              }
            }}
          />
        )}
      </div>
    </div>
  )
}

import React, { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  VSCodeDropdown,
  VSCodeOption,
  VSCodeTextField} from "@vscode/webview-ui-toolkit/react"

import { API_PROVIDERS, GLOBAL_STORAGE_KEY } from "../common/constants"
import { SymmetryModelProvider } from "../common/types"

import { useGlobalContext, useModels, useOllamaModels, useProviders, useSymmetryConnection } from "./hooks"

import styles from "./styles/providers.module.css"

// Simple loader component for model loading
const ModelLoader = () => {
  const { t } = useTranslation()
  const [dots, setDots] = useState("")

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prevDots) => {
        switch (prevDots) {
          case "":
            return "."
          case ".":
            return ".."
          case "..":
            return "..."
          default:
            return ""
        }
      })
    }, 500)

    return () => clearInterval(interval)
  }, [])

  return (
    <div className={styles.modelLoader}>
      <span className={styles.loaderText}>{t("Loading models")}{dots}</span>
    </div>
  )
}

export const ProviderSelect = () => {
  const { t } = useTranslation()
  const ollamaModels = useOllamaModels()
  const { models } = useModels()
  const { providers: symmetryProviders } = useSymmetryConnection()
  const { getProvidersByType, setActiveChatProvider, providers, chatProvider } =
    useProviders()

  const chatProviders = Object.values(getProvidersByType("chat"))
    .sort((a, b) => a.modelName.localeCompare(b.modelName))

  const isActiveProviderInList = chatProvider && chatProviders.some(p => p.id === chatProvider.id)
  const effectiveProvider = isActiveProviderInList ? chatProvider : (chatProviders[0] || null)

  React.useEffect(() => {
    if (chatProvider && !isActiveProviderInList && chatProviders.length > 0) {
      const firstProvider = chatProviders[0]
      const defaultModel = models[firstProvider.provider as keyof typeof models]?.models?.[0] || firstProvider.modelName
      setActiveChatProvider({
        ...firstProvider,
        modelName: defaultModel
      })
    }
  }, [chatProvider, chatProviders, isActiveProviderInList])

  const providerModels =
    effectiveProvider?.provider === API_PROVIDERS.Ollama
      ? ollamaModels.models?.map(({ name }) => name) || []
      : effectiveProvider?.provider === API_PROVIDERS.Twinny
        ? symmetryProviders.map((provider: SymmetryModelProvider) => provider.model_name) || []
        : models[effectiveProvider?.provider as keyof typeof models]?.models || []

  const {
    context: selectedModel,
    setContext: setSelectedModel
  } = useGlobalContext<string>(GLOBAL_STORAGE_KEY.selectedModel)

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
          value={effectiveProvider?.id || ""}
          name="provider"
          onChange={handleChangeChatProvider}
        >
          {chatProviders.map((provider, index) => (
            <VSCodeOption key={index} value={provider.id}>
              {provider.label}
            </VSCodeOption>
          ))}
        </VSCodeDropdown>
      </div>
      <div>
        {effectiveProvider?.id && providerModels.length > 0 ? (
          <VSCodeDropdown
            value={selectedModel || providerModels[0] || ""}
            name="model"
            onChange={(e: unknown) => {
              const event = e as React.ChangeEvent<HTMLSelectElement>
              setSelectedModel(event.target.value)
              if (effectiveProvider) {
                setActiveChatProvider({
                  ...effectiveProvider,
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
        ) : effectiveProvider?.provider === API_PROVIDERS.Twinny && symmetryProviders.length === 0 ? (
          <ModelLoader />
        ) : (
          <VSCodeTextField
            value={selectedModel || effectiveProvider?.modelName || ""}
            placeholder={t("enter-model-name")}
            onChange={(e: unknown) => {
              const event = e as React.ChangeEvent<HTMLInputElement>
              const value = event.target.value.trim()
              if (!value) return
              setSelectedModel(value)
              if (effectiveProvider) {
                setActiveChatProvider({
                  ...effectiveProvider,
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

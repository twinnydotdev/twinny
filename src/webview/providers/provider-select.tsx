import React from "react"
import { useTranslation } from "react-i18next"
import {
  VSCodeDropdown,
  VSCodeOption,
  VSCodeTextField} from "@vscode/webview-ui-toolkit/react"

import { EVENT_NAME } from "../../common/constants"
import { usesEndpoint } from "../../common/provider-validation"
import { useModels } from "../hooks/useModels"
import { useProviders } from "../hooks/useProviders"
import { emit } from "../messaging"

import styles from "../styles/providers.module.css"

export const ProviderSelect = () => {
  const { t } = useTranslation()
  const { models } = useModels()
  const {
    getProvidersByType,
    setActiveChatProvider,
    providers,
    chatProvider,
    listModels
  } = useProviders()

  const chatProviders = Object.values(getProvidersByType("chat"))
    .sort((a, b) => a.modelName.localeCompare(b.modelName))

  const isActiveProviderInList = chatProvider && chatProviders.some(p => p.id === chatProvider.id)
  const effectiveProvider = isActiveProviderInList ? chatProvider : (chatProviders[0] || null)

  // A provider's own model comes first; the catalogue only fills a blank.
  const modelFor = (provider: { provider: string; modelName: string }) =>
    provider.modelName ||
    models[provider.provider as keyof typeof models]?.models?.[0] ||
    ""

  React.useEffect(() => {
    if (chatProvider && !isActiveProviderInList && chatProviders.length > 0) {
      const firstProvider = chatProviders[0]
      setActiveChatProvider({
        ...firstProvider,
        modelName: modelFor(firstProvider)
      })
    }
  }, [chatProvider, chatProviders, isActiveProviderInList])

  // A server (local, or a paired device) is asked what it has; a hosted
  // API's models come from the catalogue.
  const servesModels =
    !!effectiveProvider && usesEndpoint(effectiveProvider.provider, "chat")
  const [endpointModels, setEndpointModels] = React.useState<string[]>([])
  const endpointKey = effectiveProvider
    ? [
        effectiveProvider.id,
        effectiveProvider.provider,
        effectiveProvider.apiProtocol,
        effectiveProvider.apiHostname,
        effectiveProvider.apiPort,
        effectiveProvider.apiPath,
        effectiveProvider.deviceId
      ].join("|")
    : ""
  React.useEffect(() => {
    if (!effectiveProvider || !servesModels) {
      setEndpointModels([])
      return
    }
    let cancelled = false
    listModels(effectiveProvider).then((result) => {
      if (!cancelled) setEndpointModels(result.models)
    })
    return () => {
      cancelled = true
    }
  }, [endpointKey])

  const providerModels = servesModels
    ? endpointModels
    : models[effectiveProvider?.provider as keyof typeof models]?.models || []

  // The active provider is the one source of truth for the model, so this
  // dropdown, the providers tab and a device's chips always agree.
  const selectedModel = effectiveProvider?.modelName || ""

  const handleChangeChatProvider = (e: unknown): void => {
    const event = e as React.ChangeEvent<HTMLSelectElement>
    const value = event.target.value
    const provider = providers[value]
    setActiveChatProvider({
      ...provider,
      modelName: modelFor(provider)
    })
  }

  if (chatProviders.length === 0) {
    return (
      <div className={styles.noProviderNotice}>
        <i className="codicon codicon-warning" />
        <span>{t("no-chat-provider")}</span>
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => emit(EVENT_NAME.twinnyOpenProviders)}
        >
          {t("set-up-provider")}
        </button>
      </div>
    )
  }

  return (
    <div className={styles.providerSelector}>
      <div className={styles.providerSelectorProvider}>
        <i
          className="codicon codicon-server-environment"
          title={t("chat-provider")}
        />
        <VSCodeDropdown
          value={effectiveProvider?.id || ""}
          name="provider"
          onChange={handleChangeChatProvider}
        >
          {chatProviders.map((provider, index) => (
            <VSCodeOption key={index} value={provider.id}>
              {t(provider.label)}
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
              if (effectiveProvider && event.target.value !== selectedModel) {
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
        ) : (
          <VSCodeTextField
            value={selectedModel}
            placeholder={t("enter-model-name")}
            onChange={(e: unknown) => {
              const event = e as React.ChangeEvent<HTMLInputElement>
              const value = event.target.value.trim()
              if (!value || value === selectedModel) return
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

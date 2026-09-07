import { useCallback, useEffect, useState } from "react"

import { PROVIDER_EVENT_NAME } from "../../common/constants"
import {
  ProviderModelList,
  ProviderSaveResult,
  ProviderTestResult
} from "../../common/messaging/protocol"
import { ProviderType } from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"
import { bridge, emit, useServerEvent } from "../messaging"

const failed = (error: unknown): ProviderTestResult => ({
  success: false,
  error: error instanceof Error ? error.message : String(error)
})

export const useProviders = () => {
  const [providers, setProviders] = useState<Record<string, TwinnyProvider>>({})
  const [chatProvider, setChatProvider] = useState<TwinnyProvider | null>(null)
  const [fimProvider, setFimProvider] = useState<TwinnyProvider | null>(null)
  const [embeddingProvider, setEmbeddingProvider] =
    useState<TwinnyProvider | null>(null)

  useServerEvent(PROVIDER_EVENT_NAME.getAllProviders, (all) =>
    setProviders(all || {})
  )
  useServerEvent(PROVIDER_EVENT_NAME.getActiveChatProvider, (provider) =>
    setChatProvider(provider || null)
  )
  useServerEvent(PROVIDER_EVENT_NAME.getActiveFimProvider, (provider) =>
    setFimProvider(provider || null)
  )
  useServerEvent(PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider, (provider) =>
    setEmbeddingProvider(provider || null)
  )

  useEffect(() => {
    emit(PROVIDER_EVENT_NAME.getAllProviders)
    emit(PROVIDER_EVENT_NAME.getActiveChatProvider)
    emit(PROVIDER_EVENT_NAME.getActiveFimProvider)
    emit(PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider)
  }, [])

  const getProvidersByType = useCallback(
    (type: string) =>
      Object.values(providers).filter((provider) => provider.type === type),
    [providers]
  )

  const activeProviders: Record<ProviderType, TwinnyProvider | null> = {
    chat: chatProvider,
    fim: fimProvider,
    embedding: embeddingProvider
  }

  const setActiveProvider = useCallback(
    (type: ProviderType, provider: TwinnyProvider) => {
      const channel = {
        chat: PROVIDER_EVENT_NAME.setActiveChatProvider,
        fim: PROVIDER_EVENT_NAME.setActiveFimProvider,
        embedding: PROVIDER_EVENT_NAME.setActiveEmbeddingsProvider
      }[type]
      emit(channel, provider)
    },
    []
  )

  return {
    activeProviders,
    chatProvider,
    embeddingProvider,
    fimProvider,
    getProvidersByType,
    providers,
    setActiveProvider,
    copyProvider: (p: TwinnyProvider) =>
      emit(PROVIDER_EVENT_NAME.copyProvider, p),
    removeProvider: (p: TwinnyProvider) =>
      emit(PROVIDER_EVENT_NAME.removeProvider, p),
    resetProviders: () => emit(PROVIDER_EVENT_NAME.resetProvidersToDefaults),
    /** Adds a provider; the reply says whether it was accepted. */
    saveProvider: (p: TwinnyProvider): Promise<ProviderSaveResult> =>
      bridge.request(PROVIDER_EVENT_NAME.addProvider, p),
    updateProvider: (p: TwinnyProvider): Promise<ProviderSaveResult> =>
      bridge.request(PROVIDER_EVENT_NAME.updateProvider, p),
    /** Sends one real request to the provider and reports what happened. */
    testProvider: (p: TwinnyProvider): Promise<ProviderTestResult> =>
      bridge.request(PROVIDER_EVENT_NAME.testProvider, p).catch(failed),
    /** Asks the provider's own endpoint which models it serves. */
    listModels: (p: TwinnyProvider): Promise<ProviderModelList> =>
      bridge
        .request(PROVIDER_EVENT_NAME.listProviderModels, p)
        .catch((error) => ({ models: [], error: failed(error).error })),
    setActiveChatProvider: (p: TwinnyProvider) =>
      emit(PROVIDER_EVENT_NAME.setActiveChatProvider, p),
    setActiveEmbeddingsProvider: (p: TwinnyProvider) =>
      emit(PROVIDER_EVENT_NAME.setActiveEmbeddingsProvider, p),
    setActiveFimProvider: (p: TwinnyProvider) =>
      emit(PROVIDER_EVENT_NAME.setActiveFimProvider, p),
    triggerExportProviders: () => emit(PROVIDER_EVENT_NAME.exportProviders),
    triggerImportProviders: () => emit(PROVIDER_EVENT_NAME.importProviders)
  }
}

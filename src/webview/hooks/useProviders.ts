import { useEffect, useState } from "react"

import { PROVIDER_EVENT_NAME } from "../../common/constants"
import { TwinnyProvider } from "../../common/types"
import { emit, useServerEvent } from "../messaging"

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
  useServerEvent(PROVIDER_EVENT_NAME.getActiveFimProvider, (provider) => {
    if (provider) setFimProvider(provider)
  })
  useServerEvent(PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider, (provider) => {
    if (provider) setEmbeddingProvider(provider)
  })

  useEffect(() => {
    emit(PROVIDER_EVENT_NAME.getAllProviders)
    emit(PROVIDER_EVENT_NAME.getActiveChatProvider)
    emit(PROVIDER_EVENT_NAME.getActiveFimProvider)
    emit(PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider)
  }, [])

  const getProvidersByType = (type: string) =>
    Object.values(providers).filter((provider) => provider.type === type)

  return {
    chatProvider,
    embeddingProvider,
    fimProvider,
    getProvidersByType,
    providers,
    copyProvider: (p: TwinnyProvider) =>
      emit(PROVIDER_EVENT_NAME.copyProvider, p),
    removeProvider: (p: TwinnyProvider) =>
      emit(PROVIDER_EVENT_NAME.removeProvider, p),
    resetProviders: () => emit(PROVIDER_EVENT_NAME.resetProvidersToDefaults),
    saveProvider: (p: TwinnyProvider) =>
      emit(PROVIDER_EVENT_NAME.addProvider, p),
    setActiveChatProvider: (p: TwinnyProvider) =>
      emit(PROVIDER_EVENT_NAME.setActiveChatProvider, p),
    setActiveEmbeddingsProvider: (p: TwinnyProvider) =>
      emit(PROVIDER_EVENT_NAME.setActiveEmbeddingsProvider, p),
    setActiveFimProvider: (p: TwinnyProvider) =>
      emit(PROVIDER_EVENT_NAME.setActiveFimProvider, p),
    updateProvider: (p: TwinnyProvider) =>
      emit(PROVIDER_EVENT_NAME.updateProvider, p),
    triggerExportProviders: () => emit(PROVIDER_EVENT_NAME.exportProviders),
    triggerImportProviders: () => emit(PROVIDER_EVENT_NAME.importProviders)
  }
}

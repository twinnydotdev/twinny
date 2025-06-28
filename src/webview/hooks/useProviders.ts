import { useEffect, useState } from "react"

import { PROVIDER_EVENT_NAME } from "../../common/constants"
import { ClientMessage, ServerMessage } from "../../common/types"
import { TwinnyProvider } from "../../extension/provider-manager"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const useProviders = () => {
  const [providers, setProviders] = useState<Record<string, TwinnyProvider>>({})
  const [chatProvider, setChatProvider] = useState<TwinnyProvider | null>(null)
  const [fimProvider, setFimProvider] = useState<TwinnyProvider | null>(null)
  const [embeddingProvider, setEmbeddingProvider] =
    useState<TwinnyProvider | null>(null)
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<
      Record<string, TwinnyProvider> | TwinnyProvider
    > = event.data
    if (message?.type === PROVIDER_EVENT_NAME.getAllProviders) {
      const providers = message.data as Record<string, TwinnyProvider>
      setProviders(providers || {})
    }
    if (message?.type === PROVIDER_EVENT_NAME.getActiveChatProvider) {
      const provider = message.data as TwinnyProvider
      setChatProvider(provider || null)
    }
    if (message?.type === PROVIDER_EVENT_NAME.getActiveFimProvider) {
      if (message.data) {
        const provider = message.data as TwinnyProvider
        setFimProvider(provider)
      }
    }
    if (message?.type === PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider) {
      if (message.data) {
        const provider = message.data as TwinnyProvider
        setEmbeddingProvider(provider)
      }
    }
    return () => window.removeEventListener("message", handler)
  }

  const saveProvider = (provider: TwinnyProvider) => {
    global.vscode.postMessage({
      type: PROVIDER_EVENT_NAME.addProvider,
      data: provider
    } as ClientMessage<TwinnyProvider>)
  }

  const copyProvider = (provider: TwinnyProvider) => {
    global.vscode.postMessage({
      type: PROVIDER_EVENT_NAME.copyProvider,
      data: provider
    } as ClientMessage<TwinnyProvider>)
  }

  const updateProvider = (provider: TwinnyProvider) => {
    global.vscode.postMessage({
      type: PROVIDER_EVENT_NAME.updateProvider,
      data: provider
    } as ClientMessage<TwinnyProvider>)
  }

  const removeProvider = (provider: TwinnyProvider) => {
    global.vscode.postMessage({
      type: PROVIDER_EVENT_NAME.removeProvider,
      data: provider
    } as ClientMessage<TwinnyProvider>)
  }

  const setActiveFimProvider = (provider: TwinnyProvider) => {
    global.vscode.postMessage({
      type: PROVIDER_EVENT_NAME.setActiveFimProvider,
      data: provider
    } as ClientMessage<TwinnyProvider>)
  }

  const setActiveEmbeddingsProvider = (provider: TwinnyProvider) => {
    global.vscode.postMessage({
      type: PROVIDER_EVENT_NAME.setActiveEmbeddingsProvider,
      data: provider
    } as ClientMessage<TwinnyProvider>)
  }

  const setActiveChatProvider = (provider: TwinnyProvider) => {
    global.vscode.postMessage({
      type: PROVIDER_EVENT_NAME.setActiveChatProvider,
      data: provider
    } as ClientMessage<TwinnyProvider>)
  }

  const getProvidersByType = (type: string) => {
    return Object.values(providers).filter(
      (provider) => provider.type === type
    ) as TwinnyProvider[]
  }

  const resetProviders = () => {
    global.vscode.postMessage({
      type: PROVIDER_EVENT_NAME.resetProvidersToDefaults
    } as ClientMessage<TwinnyProvider>)
  }

  useEffect(() => {
    global.vscode.postMessage({
      type: PROVIDER_EVENT_NAME.getAllProviders
    })
    global.vscode.postMessage({
      type: PROVIDER_EVENT_NAME.getActiveChatProvider
    })
    global.vscode.postMessage({
      type: PROVIDER_EVENT_NAME.getActiveFimProvider
    })
    global.vscode.postMessage({
      type: PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider
    })
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [])

  return {
    chatProvider,
    copyProvider,
    embeddingProvider,
    fimProvider,
    getProvidersByType,
    providers,
    removeProvider,
    resetProviders,
    saveProvider,
    setActiveChatProvider,
    setActiveEmbeddingsProvider,
    setActiveFimProvider,
    updateProvider,
    triggerExportProviders, // Added
    triggerImportProviders  // Added
  }
}

// New functions to trigger export/import
const triggerExportProviders = () => {
  global.vscode.postMessage({
    type: PROVIDER_EVENT_NAME.exportProviders
  } as ClientMessage<unknown>) // data can be unknown or undefined if not sending payload
}

const triggerImportProviders = () => {
  global.vscode.postMessage({
    type: PROVIDER_EVENT_NAME.importProviders
  } as ClientMessage<unknown>) // data can be unknown or undefined if not sending payload
}

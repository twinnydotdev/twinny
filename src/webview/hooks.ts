import { useEffect, useState } from 'react'

import {
  CONVERSATION_EVENT_NAME,
  WORKSPACE_STORAGE_KEY,
  EVENT_NAME,
  PROVIDER_EVENT_NAME,
  EXTENSION_SESSION_NAME
} from '../common/constants'
import {
  ApiModel,
  ClientMessage,
  Conversation,
  LanguageType,
  ServerMessage,
  SymmetryConnection,
  ThemeType
} from '../common/types'
import { TwinnyProvider } from '../extension/provider-manager'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const useSelection = (onSelect?: () => void) => {
  const [selection, setSelection] = useState('')
  const handler = (event: MessageEvent) => {
    const message: ServerMessage = event.data
    if (message?.type === EVENT_NAME.twinnyTextSelection) {
      setSelection(message?.value.completion.trim())
      onSelect?.()
    }
  }

  useEffect(() => {
    window.addEventListener('message', handler)
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyTextSelection
    })
    return () => window.removeEventListener('message', handler)
  }, [])

  return selection
}

export const useGlobalContext = <T>(key: string) => {
  const [context, setContextState] = useState<T | undefined>()

  const handler = (event: MessageEvent) => {
    const message: ServerMessage = event.data
    if (message?.type === `${EVENT_NAME.twinnyGlobalContext}-${key}`) {
      setContextState(event.data.value)
    }
  }

  const setContext = (value: T) => {
    setContextState(value)
    global.vscode.postMessage({
      type: EVENT_NAME.twinnySetGlobalContext,
      key,
      data: value
    })
  }

  useEffect(() => {
    window.addEventListener('message', handler)

    global.vscode.postMessage({
      type: EVENT_NAME.twinnyGlobalContext,
      key
    })

    return () => window.removeEventListener('message', handler)
  }, [])

  return { context, setContext }
}

export const useSessionContext = <T>(key: string) => {
  const [context, setContext] = useState<T>()

  const handler = (event: MessageEvent) => {
    const message: ServerMessage = event.data
    if (message?.type === `${EVENT_NAME.twinnySessionContext}-${key}`) {
      setContext(event.data.value)
    }
  }

  useEffect(() => {
    window.addEventListener('message', handler)
    global.vscode.postMessage({
      type: EVENT_NAME.twinnySessionContext,
      key
    })
    return () => window.removeEventListener('message', handler)
  }, [])

  return { context, setContext }
}

export const useWorkSpaceContext = <T>(key: string) => {
  const [context, setContext] = useState<T>()

  const handler = (event: MessageEvent) => {
    const message: ServerMessage = event.data
    if (message?.type === `${EVENT_NAME.twinnyWorkspaceContext}-${key}`) {
      setContext(event.data.value)
    }
  }

  useEffect(() => {
    window.addEventListener('message', handler)
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyWorkspaceContext,
      key
    })

    return () => window.removeEventListener('message', handler)
  }, [])

  return { context, setContext }
}

export const useTheme = () => {
  const [theme, setTheme] = useState<ThemeType | undefined>()
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<ThemeType> = event.data
    if (message?.type === EVENT_NAME.twinnySendTheme) {
      setTheme(message?.value.data)
    }
    return () => window.removeEventListener('message', handler)
  }
  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnySendTheme
    })
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])
  return theme
}

export const useLanguage = (): LanguageType | undefined => {
  const [language, setLanguage] = useState<LanguageType | undefined>()
  const handler = (event: MessageEvent) => {
    const message: ServerMessage = event.data
    if (message?.type === EVENT_NAME.twinnySendLanguage) {
      setLanguage(message?.value.data)
    }
    return () => window.removeEventListener('message', handler)
  }
  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnySendLanguage
    })
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])
  return language
}

export const useTemplates = () => {
  const [templates, setTemplates] = useState<string[]>()
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<string[]> = event.data
    if (message?.type === EVENT_NAME.twinnyListTemplates) {
      setTemplates(message?.value.data)
    }
    return () => window.removeEventListener('message', handler)
  }

  const saveTemplates = (templates: string[]) => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnySetWorkspaceContext,
      key: WORKSPACE_STORAGE_KEY.selectedTemplates,
      data: templates
    } as ClientMessage<string[]>)
  }

  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyListTemplates
    })
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])
  return { templates, saveTemplates }
}

export const useProviders = () => {
  const [providers, setProviders] = useState<Record<string, TwinnyProvider>>({})
  const [chatProvider, setChatProvider] = useState<TwinnyProvider>()
  const [fimProvider, setFimProvider] = useState<TwinnyProvider>()
  const [embeddingProvider, setEmbeddingProvider] = useState<TwinnyProvider>()
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<
      Record<string, TwinnyProvider> | TwinnyProvider
    > = event.data
    if (message?.type === PROVIDER_EVENT_NAME.getAllProviders) {
      if (message.value.data) {
        const providers = message.value.data as Record<string, TwinnyProvider>
        setProviders(providers)
      }
    }
    if (message?.type === PROVIDER_EVENT_NAME.getActiveChatProvider) {
      if (message.value.data) {
        const provider = message.value.data as TwinnyProvider
        setChatProvider(provider)
      }
    }
    if (message?.type === PROVIDER_EVENT_NAME.getActiveFimProvider) {
      if (message.value.data) {
        const provider = message.value.data as TwinnyProvider
        setFimProvider(provider)
      }
    }
    if (message?.type === PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider) {
      if (message.value.data) {
        const provider = message.value.data as TwinnyProvider
        setEmbeddingProvider(provider)
      }
    }
    return () => window.removeEventListener('message', handler)
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
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
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
    updateProvider
  }
}

export const useConfigurationSetting = (key: string) => {
  const [configurationSetting, setConfigurationSettings] = useState<
    string | boolean | number
  >()

  const handler = (event: MessageEvent) => {
    const message: ServerMessage<string | boolean | number> = event.data
    if (
      message?.type === EVENT_NAME.twinnyGetConfigValue &&
      message.value.type === key
    ) {
      setConfigurationSettings(message?.value.data)
    }
  }

  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyGetConfigValue,
      key
    })
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [key])

  return { configurationSetting }
}

export const useConversationHistory = () => {
  const [conversations, setConversations] = useState<
    Record<string, Conversation>
  >({})
  const [conversation, setConversation] = useState<Conversation>()

  const getConversations = () => {
    global.vscode.postMessage({
      type: CONVERSATION_EVENT_NAME.getConversations
    } as ClientMessage<string>)
  }

  const getActiveConversation = () => {
    global.vscode.postMessage({
      type: CONVERSATION_EVENT_NAME.getActiveConversation
    })
  }

  const removeConversation = (conversation: Conversation) => {
    global.vscode.postMessage({
      type: CONVERSATION_EVENT_NAME.removeConversation,
      data: conversation
    } as ClientMessage<Conversation>)
  }

  const setActiveConversation = (conversation: Conversation | undefined) => {
    global.vscode.postMessage({
      type: CONVERSATION_EVENT_NAME.setActiveConversation,
      data: conversation
    } as ClientMessage<Conversation | undefined>)
    setConversation(conversation)
  }

  const saveLastConversation = (conversation: Conversation | undefined) => {
    global.vscode.postMessage({
      type: CONVERSATION_EVENT_NAME.saveConversation,
      data: conversation
    } as ClientMessage<Conversation>)
  }

  const clearAllConversations = () => {
    global.vscode.postMessage({
      type: CONVERSATION_EVENT_NAME.clearAllConversations
    } as ClientMessage<string>)
  }

  const handler = (event: MessageEvent) => {
    const message = event.data
    if (message.value?.data) {
      if (message?.type === CONVERSATION_EVENT_NAME.getConversations) {
        setConversations(message.value.data)
      }
      if (message?.type === CONVERSATION_EVENT_NAME.getActiveConversation) {
        setConversation(message.value.data as Conversation)
      }
    }
  }

  useEffect(() => {
    getConversations()
    getActiveConversation()
    window.addEventListener('message', handler)

    return () => window.removeEventListener('message', handler)
  }, [])

  return {
    conversations,
    conversation,
    getConversations,
    removeConversation,
    saveLastConversation,
    clearAllConversations,
    setActiveConversation
  }
}

export const useOllamaModels = () => {
  const [models, setModels] = useState<ApiModel[] | undefined>([])
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<ApiModel[]> = event.data
    if (message?.type === EVENT_NAME.twinnyFetchOllamaModels) {
      setModels(message?.value.data)
    }
    return () => window.removeEventListener('message', handler)
  }

  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyFetchOllamaModels
    })
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  return { models }
}

const useAutosizeTextArea = (
  chatRef: React.RefObject<HTMLTextAreaElement> | null,
  value: string
) => {
  useEffect(() => {
    if (chatRef?.current) {
      chatRef.current.style.height = '0px'
      const scrollHeight = chatRef.current.scrollHeight
      chatRef.current.style.height = `${scrollHeight + 5}px`
    }
  }, [chatRef, value])
}

export const useSymmetryConnection = () => {
  const [autoConnect, setAutoConnect] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const {
    context: symmetryConnectionSession,
    setContext: setSymmetryConnectionSession
  } = useSessionContext<SymmetryConnection>(
    EXTENSION_SESSION_NAME.twinnySymmetryConnection
  )

  const connectToSymmetry = () => {
    setConnecting(true)
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyConnectSymmetry
    } as ClientMessage)
  }

  const disconnectSymmetry = () => {
    setConnecting(true)
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyDisconnectSymmetry
    } as ClientMessage)
  }

  const handler = (event: MessageEvent) => {
    const message: ServerMessage<SymmetryConnection> = event.data
    if (message?.type === EVENT_NAME.twinnyConnectedToSymmetry) {
      setConnecting(false)
      setSymmetryConnectionSession(message.value.data)
    }
    if (message?.type === EVENT_NAME.twinnyDisconnectedFromSymmetry) {
      setConnecting(false)
      setSymmetryConnectionSession(undefined)
    }
    return () => window.removeEventListener('message', handler)
  }

  useEffect(() => {
    if (symmetryConnectionSession !== undefined) {
      setSymmetryConnectionSession(symmetryConnectionSession)
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  return {
    connectToSymmetry,
    disconnectSymmetry,
    isConnected: symmetryConnectionSession !== undefined,
    autoConnect,
    setAutoConnect,
    connecting,
    symmetryConnection: symmetryConnectionSession
  }
}

export default useAutosizeTextArea

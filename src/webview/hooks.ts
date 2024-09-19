/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  RefAttributes,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import tippy, { Instance as TippyInstance } from 'tippy.js'
import { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'
import { MentionNodeAttrs } from '@tiptap/extension-mention'
import { ReactRenderer } from '@tiptap/react'

import {
  CONVERSATION_EVENT_NAME,
  WORKSPACE_STORAGE_KEY,
  EVENT_NAME,
  PROVIDER_EVENT_NAME,
  EXTENSION_SESSION_NAME,
  GLOBAL_STORAGE_KEY,
  GITHUB_EVENT_NAME
} from '../common/constants'
import {
  ApiModel,
  ClientMessage,
  Conversation,
  FileItem,
  GitHubPr,
  LanguageType,
  ServerMessage,
  SymmetryConnection,
  SymmetryModelProvider,
  ThemeType
} from '../common/types'
import { TwinnyProvider } from '../extension/provider-manager'
import { MentionList, MentionListProps, MentionListRef } from './mention-list'

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
    if (message?.type === `${EVENT_NAME.twinnyGetWorkspaceContext}-${key}`) {
      setContext(event.data.value)
    }
  }

  useEffect(() => {
    window.addEventListener('message', handler)
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyGetWorkspaceContext,
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

export const useLoading = () => {
  const [loader, setLoader] = useState<string | undefined>()
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<string> = event.data
    if (message?.type === EVENT_NAME.twinnySendLoader) {
      setLoader(message?.value.data)
    }
    return () => window.removeEventListener('message', handler)
  }
  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnySendLoader
    })
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])
  return loader
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

export const useGithubPRs = () => {
  const [prs, setPRs] = useState<Array<GitHubPr>>([])
  const [isLoading, setIsLoading] = useState<boolean>(false)

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data
      if (message.type === GITHUB_EVENT_NAME.getPullRequests) {
        setPRs(message.value.data)
        setIsLoading(false)
      }
    }

    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  const getPrs = (owner: string | undefined, repo: string | undefined) => {
    setIsLoading(true)
    global.vscode.postMessage({
      type: GITHUB_EVENT_NAME.getPullRequests,
      data: { owner, repo }
    })
  }

  const startReview = (
    owner: string | undefined,
    repo: string | undefined,
    selectedPR: number,
    title: string
  ) => {
    if (selectedPR === null) return

    global.vscode.postMessage({
      type: GITHUB_EVENT_NAME.getPullRequestReview,
      data: { owner, repo, number: selectedPR, title }
    })
  }

  return {
    prs,
    isLoading,
    getPrs,
    startReview
  }
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
      if (message?.type === CONVERSATION_EVENT_NAME.setActiveConversation) {
        setConversation(message.value.data)
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

export const useFilePaths = () => {
  const filePaths = useRef<string[] | undefined>()

  const handler = (event: MessageEvent) => {
    const message: ServerMessage<string[]> = event.data
    if (
      !filePaths.current?.length &&
      message?.type === EVENT_NAME.twinnyFileListResponse
    ) {
      filePaths.current = message.value.data // response sets the list from vscode backend
    }
  }

  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyFileListRequest
    })

    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  return {
    filePaths: filePaths.current || []
  }
}

export const useSuggestion = () => {
  const { filePaths } = useFilePaths()

  const getFilePaths = useCallback(() => filePaths, [filePaths])

  const items = useCallback(
    ({ query }: { query: string }) => {
      const filePaths = getFilePaths()
      const fileItems: FileItem[] = filePaths.map((path) => ({
        name: path.split('/').pop() || '',
        path: path
      }))
      const defaultItems: FileItem[] = [
        { name: 'workspace', path: 'workspace' },
        { name: 'problems', path: 'problems' }
      ]
      return Promise.resolve(
        [...defaultItems, ...fileItems]
          .filter((item) =>
            item.name.toLowerCase().startsWith(query.toLowerCase())
          )
          .slice(0, 10)
      )
    },
    [getFilePaths]
  )

  const render = useCallback(() => {
    let reactRenderer: ReactRenderer<
      MentionListRef,
      MentionListProps & RefAttributes<MentionListRef>
    >
    let popup: TippyInstance[]

    return {
      onStart: (props: SuggestionProps<MentionNodeAttrs>) => {
        reactRenderer = new ReactRenderer(MentionList, {
          props,
          editor: props.editor
        })

        const getReferenceClientRect = props.clientRect as () => DOMRect

        popup = tippy('body', {
          getReferenceClientRect,
          appendTo: () => document.body,
          content: reactRenderer.element,
          showOnCreate: true,
          interactive: true,
          trigger: 'manual',
          placement: 'bottom-start'
        })
      },

      onUpdate(props: SuggestionProps<MentionNodeAttrs>) {
        reactRenderer.updateProps(props)

        if (popup) {
          popup[0].setProps({
            getReferenceClientRect: props.clientRect as () => DOMRect
          })
        }
      },

      onKeyDown(props: SuggestionKeyDownProps) {
        if (props.event.key === 'Escape') {
          popup[0].hide()
          return true
        }

        if (!reactRenderer.ref) return false

        return reactRenderer.ref.onKeyDown(props)
      },

      onExit() {
        if (popup) {
          popup[0].destroy()
          reactRenderer.destroy()
        }
      }
    }
  }, [])

  const suggestion = useMemo(
    () => ({
      items,
      render
    }),
    [items, render]
  )

  return {
    suggestion,
    filePaths
  }
}

export const useSymmetryConnection = () => {
  const [connecting, setConnecting] = useState(false)
  const [models, setModels] = useState<SymmetryModelProvider[]>([])
  const [selectedModel, setSelectedModel] =
    useState<SymmetryModelProvider | null>(null)
  const {
    context: symmetryConnectionSession,
    setContext: setSymmetryConnectionSession
  } = useSessionContext<SymmetryConnection>(
    EXTENSION_SESSION_NAME.twinnySymmetryConnection
  )

  const {
    context: symmetryProviderStatus,
    setContext: setSymmetryProviderStatus
  } = useSessionContext<string>(
    EXTENSION_SESSION_NAME.twinnySymmetryConnectionProvider
  )

  const {
    context: autoConnectProviderContext,
    setContext: setAutoConnectProviderContext
  } = useGlobalContext<boolean>(GLOBAL_STORAGE_KEY.autoConnectSymmetryProvider)

  const isProviderConnected = symmetryProviderStatus === 'connected'

  const connectToSymmetry = () => {
    setConnecting(true)
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyConnectSymmetry,
      data: selectedModel
    } as ClientMessage<SymmetryModelProvider>)
  }

  const disconnectSymmetry = () => {
    setConnecting(true)
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyDisconnectSymmetry
    } as ClientMessage)
  }

  const connectAsProvider = () => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyStartSymmetryProvider
    } as ClientMessage)
  }

  const disconnectAsProvider = () => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyStopSymmetryProvider
    } as ClientMessage)
  }

  const handler = (event: MessageEvent) => {
    const message: ServerMessage<
      SymmetryConnection | string | SymmetryModelProvider[]
    > = event.data
    if (message?.type === EVENT_NAME.twinnyConnectedToSymmetry) {
      setConnecting(false)
      setSymmetryConnectionSession(message.value.data as SymmetryConnection)
    }
    if (message?.type === EVENT_NAME.twinnyDisconnectedFromSymmetry) {
      setConnecting(false)
      setSymmetryConnectionSession(undefined)
    }
    if (message?.type === EVENT_NAME.twinnySendSymmetryMessage) {
      setSymmetryProviderStatus(message?.value.data as string)
    }

    if (message?.type === EVENT_NAME.twinnySymmetryModeles) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setModels(message?.value.data as unknown as SymmetryModelProvider[])
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

  useEffect(() => {
    if (
      autoConnectProviderContext &&
      symmetryProviderStatus === 'disconnected'
    ) {
      connectAsProvider()
    }
  }, [autoConnectProviderContext, symmetryProviderStatus, connectAsProvider])

  return {
    autoConnectProviderContext,
    connectAsProvider,
    models,
    selectedModel,
    setSelectedModel,
    connecting,
    connectToSymmetry,
    disconnectAsProvider,
    disconnectSymmetry,
    isConnected: symmetryConnectionSession !== undefined,
    isProviderConnected,
    setAutoConnectProviderContext,
    symmetryConnection: symmetryConnectionSession,
    symmetryProviderStatus
  }
}

export default useAutosizeTextArea

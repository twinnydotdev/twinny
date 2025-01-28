/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  RefAttributes,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react"
import { MentionNodeAttrs } from "@tiptap/extension-mention"
import { ReactRenderer } from "@tiptap/react"
import { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion"
import Fuse from "fuse.js"
import i18next from "i18next"
import tippy, { Instance as TippyInstance } from "tippy.js"

import {
  CONVERSATION_EVENT_NAME,
  EVENT_NAME,
  EXTENSION_SESSION_NAME,
  GITHUB_EVENT_NAME,
  GLOBAL_STORAGE_KEY,
  PROVIDER_EVENT_NAME,
  topLevelItems,
  WORKSPACE_STORAGE_KEY
} from "../common/constants"
import {
  ApiModel,
  CategoryType,
  ClientMessage,
  Conversation,
  FileItem,
  GitHubPr,
  LanguageType,
  ServerMessage,
  SymmetryConnection,
  SymmetryModelProvider,
  ThemeType
} from "../common/types"
import { TwinnyProvider } from "../extension/provider-manager"

import { MentionList, MentionListProps, MentionListRef } from "./mention-list"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const useSelection = (onSelect?: () => void) => {
  const [selection, setSelection] = useState("")
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<string> = event.data
    if (message?.type === EVENT_NAME.twinnyTextSelection) {
      const selection = message?.data?.trim()
      setSelection(selection || "")
      onSelect?.()
    }
  }

  useEffect(() => {
    window.addEventListener("message", handler)
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyTextSelection
    })
    return () => window.removeEventListener("message", handler)
  }, [])

  return selection
}

export const useGlobalContext = <T>(key: string) => {
  const [context, setContextState] = useState<T | undefined>()

  const handler = (event: MessageEvent) => {
    const message: ServerMessage = event.data
    if (message?.type === `${EVENT_NAME.twinnyGlobalContext}-${key}`) {
      setContextState(event.data.data)
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
    window.addEventListener("message", handler)

    global.vscode.postMessage({
      type: EVENT_NAME.twinnyGlobalContext,
      key
    })

    return () => window.removeEventListener("message", handler)
  }, [])

  return { context, setContext }
}

export const useSessionContext = <T>(key: string) => {
  const [context, setContext] = useState<T>()

  const handler = (event: MessageEvent) => {
    const message: ServerMessage = event.data
    if (message?.type === `${EVENT_NAME.twinnySessionContext}-${key}`) {
      setContext(event.data.data)
    }
  }

  useEffect(() => {
    window.addEventListener("message", handler)
    global.vscode.postMessage({
      type: EVENT_NAME.twinnySessionContext,
      key
    })
    return () => window.removeEventListener("message", handler)
  }, [])

  return { context, setContext }
}

export const useWorkSpaceContext = <T>(key: string) => {
  const [context, setContext] = useState<T>()

  const handler = (event: MessageEvent) => {
    const message: ServerMessage = event.data
    if (message?.type === `${EVENT_NAME.twinnyGetWorkspaceContext}-${key}`) {
      setContext(event.data.data)
    }
  }

  useEffect(() => {
    window.addEventListener("message", handler)
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyGetWorkspaceContext,
      key
    })

    return () => window.removeEventListener("message", handler)
  }, [])

  return { context, setContext }
}

export const useTheme = () => {
  const [theme, setTheme] = useState<ThemeType>("Dark")
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<ThemeType> = event.data
    if (message?.type === EVENT_NAME.twinnySendTheme) {
      setTheme(message?.data)
    }
  }
  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnySendTheme
    })
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [])
  return theme
}

export const useLoading = () => {
  const [loader, setLoader] = useState<string | undefined>()
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<string> = event.data
    if (message?.type === EVENT_NAME.twinnySendLoader) {
      setLoader(message?.data)
    }
    return () => window.removeEventListener("message", handler)
  }
  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnySendLoader
    })
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [])
  return loader
}

export const useLanguage = (): LanguageType | undefined => {
  const [language, setLanguage] = useState<LanguageType>()
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<LanguageType> = event.data
    if (message?.type === EVENT_NAME.twinnySendLanguage) {
      const language = message.data
      if (language) {
        setLanguage(language)
      }
    }
    return () => window.removeEventListener("message", handler)
  }
  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnySendLanguage
    })
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [])
  return language
}

export const useTemplates = () => {
  const [templates, setTemplates] = useState<string[]>()
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<string[]> = event.data
    if (message?.type === EVENT_NAME.twinnyListTemplates) {
      setTemplates(message?.data)
    }
    return () => window.removeEventListener("message", handler)
  }

  const saveTemplates = (templates: string[]) => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnySetWorkspaceContext,
      key: WORKSPACE_STORAGE_KEY.selectedTemplates,
      data: templates
    } as ClientMessage<string[]>)
  }

  const editDefaultTemplates = () => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyEditDefaultTemplates
    })
  }

  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyListTemplates
    })
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [])
  return { templates, saveTemplates, editDefaultTemplates }
}

export const useGithubPRs = () => {
  const [prs, setPRs] = useState<Array<GitHubPr>>([])
  const [isLoading, setIsLoading] = useState<boolean>(false)

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data
      if (message.type === GITHUB_EVENT_NAME.getPullRequests) {
        setPRs(message.data)
        setIsLoading(false)
      }
    }

    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
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
    updateProvider
  }
}

export const useModels = () => {
  const [models, setModels] = useState<Record<string, any>>({})

  const handler = (event: MessageEvent) => {
    const message: ServerMessage<ApiModel[]> = event.data
    if (message?.type === EVENT_NAME.twinnyGetModels) {
      setModels(message?.data)
    }
    return () => window.removeEventListener("message", handler)
  }

  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyGetModels
    })
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [])

  return { models }
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
    const message = event.data as ServerMessage<
      Record<string, Conversation> | Conversation
    >
    if (message?.data) {
      if (message?.type === CONVERSATION_EVENT_NAME.getConversations) {
        setConversations(message.data as Record<string, Conversation>)
      }
      if (message?.type === CONVERSATION_EVENT_NAME.setActiveConversation) {
        setConversation(message.data as Conversation)
      }
    }
  }

  useEffect(() => {
    getConversations()
    getActiveConversation()
    window.addEventListener("message", handler)

    return () => window.removeEventListener("message", handler)
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
      setModels(message?.data)
    }
    return () => window.removeEventListener("message", handler)
  }

  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyFetchOllamaModels
    })
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [])

  return { models }
}

export const useAutosizeTextArea = (
  chatRef: React.RefObject<HTMLTextAreaElement> | null,
  value: string
) => {
  useEffect(() => {
    if (chatRef?.current) {
      chatRef.current.style.height = "0px"
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
      filePaths.current = message.data
    }
  }

  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyFileListRequest
    })

    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [])

  return {
    filePaths: filePaths.current || []
  }
}

export const useSuggestion = () => {
  const { filePaths } = useFilePaths()

  const getFilePaths = useCallback(() => filePaths, [filePaths])

  const suggestionItems = useCallback(
    ({ query }: { query: string }) => {
      const filePaths = getFilePaths()
      const fileItems = createFileItems(filePaths)
      const allItems = [...topLevelItems, ...fileItems]

      const fuse = new Fuse(allItems, {
        keys: ["name", "path"],
        threshold: 0.4,
        includeScore: true
      })

      const filteredItems = query
        ? fuse.search(query).map(result => result.item)
        : allItems

      const groupedItems = groupItemsByCategory(filteredItems)
      const sortedItems = sortItemsByCategory(groupedItems)

      return Promise.resolve(sortedItems)
    },
    [getFilePaths]
  )

  const createFileItems = (filePaths: string[]): FileItem[] =>
    filePaths.map((path) => ({
      name: path.split("/").pop() || "",
      path,
      category: "files"
    }))

  const groupItemsByCategory = (
    items: FileItem[]
  ): Record<string, FileItem[]> =>
    items.reduce((acc, item) => {
      acc[item.category] = [...(acc[item.category] || []), item]
      return acc
    }, {} as Record<string, FileItem[]>)

  const orderedCategories: CategoryType[] = ["workspace", "problems", "files"]

  const sortItemsByCategory = (
    groupedItems: Record<string, FileItem[]>
  ): FileItem[] =>
    orderedCategories.flatMap((category) => groupedItems[category] || [])

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

        popup = tippy("body", {
          getReferenceClientRect,
          appendTo: () => document.body,
          content: reactRenderer.element,
          showOnCreate: true,
          interactive: true,
          trigger: "manual",
          placement: "top-start"
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
        if (props.event.key === "Escape") {
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
      items: suggestionItems,
      render
    }),
    [suggestionItems, render]
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

  const isProviderConnected = symmetryProviderStatus === "connected"

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

  const getModels = () => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyGetSymmetryModels
    })
  }

  const handler = (event: MessageEvent) => {
    const message: ServerMessage<
      SymmetryConnection | string | SymmetryModelProvider[]
    > = event.data
    if (message?.type === EVENT_NAME.twinnyConnectedToSymmetry) {
      setConnecting(false)
      setSymmetryConnectionSession(message.data as SymmetryConnection)
    }
    if (message?.type === EVENT_NAME.twinnyDisconnectedFromSymmetry) {
      setConnecting(false)
      setSymmetryConnectionSession(undefined)
    }
    if (message?.type === EVENT_NAME.twinnySendSymmetryMessage) {
      setSymmetryProviderStatus(message?.data as string)
    }

    if (message?.type === EVENT_NAME.twinnySymmetryModels) {
      setModels(message?.data as SymmetryModelProvider[])
    }
    return () => window.removeEventListener("message", handler)
  }

  useEffect(() => {
    if (symmetryConnectionSession !== undefined) {
      setSymmetryConnectionSession(symmetryConnectionSession)
    }
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [])

  useEffect(() => {
    if (
      autoConnectProviderContext &&
      symmetryProviderStatus === "disconnected"
    ) {
      connectAsProvider()
    }
  }, [autoConnectProviderContext, symmetryProviderStatus, connectAsProvider])

  return {
    autoConnectProviderContext,
    connectAsProvider,
    connecting,
    connectToSymmetry,
    disconnectAsProvider,
    disconnectSymmetry,
    getModels,
    isConnected: symmetryConnectionSession !== undefined,
    isProviderConnected,
    models,
    selectedModel,
    setAutoConnectProviderContext,
    setSelectedModel,
    symmetryConnection: symmetryConnectionSession,
    symmetryProviderStatus
  }
}

export const useLocale = () => {
  const [locale, setLocale] = useState<string>("en")
  const [renderKey, setRenderKey] = useState<number>(0)
  useEffect(() => {
    const messageHandler = (event: MessageEvent) => {
      if (event.data.type === EVENT_NAME.twinnySetLocale) {
        i18next.changeLanguage(event.data.data)
        setLocale(event.data.data)
        setRenderKey((prev: number) => prev + 1)
      }
    }

    global.vscode.postMessage({ type: EVENT_NAME.twinntGetLocale })

    window.addEventListener("message", messageHandler)
    return () => window.removeEventListener("message", messageHandler)
  }, [i18next])
  return { locale, renderKey }
}

export const useEvent = (
  eventName: string,
  handler: ((event: any) => void) | null,
  target: Window | HTMLElement = window
) => {
  useEffect(() => {
    if (!handler || !target) return

    target.addEventListener(eventName, handler)
    return () => target.removeEventListener(eventName, handler)
  }, [eventName, handler, target])
}

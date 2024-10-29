import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Mention from "@tiptap/extension-mention"
import Placeholder from "@tiptap/extension-placeholder"
import { Editor, EditorContent, JSONContent,useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import {
  VSCodeBadge,
  VSCodeButton,
  VSCodeDivider,
  VSCodePanelView,
} from "@vscode/webview-ui-toolkit/react"
import cn from "classnames"

import {
  ASSISTANT,
  EVENT_NAME,
  USER,
  WORKSPACE_STORAGE_KEY,
} from "../common/constants"
import {
  ClientMessage,
  MentionType,
  Message as MessageType,
  ServerMessage,
} from "../common/types"

import { EmbeddingOptions } from "./embedding-options"
import useAutosizeTextArea, {
  useConversationHistory,
  useSelection,
  useSuggestion,
  useSymmetryConnection,
  useTheme,
  useWorkSpaceContext,
} from "./hooks"
import {
  DisabledAutoScrollIcon,
  EnabledAutoScrollIcon,
} from "./icons"
import ChatLoader from "./loader"
import { Message } from "./message"
import { ProviderSelect } from "./provider-select"
import { Suggestions } from "./suggestions"
import { CustomKeyMap, getCompletionContent } from "./utils"

import styles from "./styles/index.module.css"

interface ChatProps {
  fullScreen?: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const Chat = (props: ChatProps): JSX.Element => {
  const { fullScreen } = props
  const generatingRef = useRef(false)
  const editorRef = useRef<Editor | null>(null)
  const stopRef = useRef(false)
  const theme = useTheme()
  const [isLoading, setIsLoading] = useState(false)
  const [messages, setMessages] = useState<MessageType[] | undefined>()
  const [completion, setCompletion] = useState<MessageType | null>()
  const markdownRef = useRef<HTMLDivElement>(null)
  const { symmetryConnection } = useSymmetryConnection()

  const { context: autoScrollContext, setContext: setAutoScrollContext } =
    useWorkSpaceContext<boolean>(WORKSPACE_STORAGE_KEY.autoScroll)
  const { context: showProvidersContext, setContext: setShowProvidersContext } =
    useWorkSpaceContext<boolean>(WORKSPACE_STORAGE_KEY.showProviders)
  const {
    context: showEmbeddingOptionsContext,
    setContext: setShowEmbeddingOptionsContext,
  } = useWorkSpaceContext<boolean>(WORKSPACE_STORAGE_KEY.showEmbeddingOptions)
  const { conversation, saveLastConversation, setActiveConversation } =
    useConversationHistory()

  const chatRef = useRef<HTMLTextAreaElement>(null)

  const scrollToBottom = () => {
    if (!autoScrollContext) return
    setTimeout(() => {
      if (markdownRef.current) {
        markdownRef.current.scrollTop = markdownRef.current.scrollHeight
      }
    }, 200)
  }

  const selection = useSelection(scrollToBottom)

  const handleCompletionEnd = (message: ServerMessage) => {
    if (message.value) {
      setMessages((prev) => {
        const messages = [
          ...(prev || []),
          {
            role: ASSISTANT,
            content: getCompletionContent(message),
          },
        ]

        saveLastConversation({
          ...conversation,
          messages: messages,
        })
        return messages
      })
      setTimeout(() => {
        editorRef.current?.commands.focus()
        stopRef.current = false
      }, 200)
    }
    setCompletion(null)
    setIsLoading(false)
    generatingRef.current = false
  }

  const handleAddTemplateMessage = (message: ServerMessage) => {
    if (stopRef.current) {
      generatingRef.current = false
      return
    }
    generatingRef.current = true
    setIsLoading(false)
    scrollToBottom()
    setMessages((prev) => [
      ...(prev || []),
      {
        role: USER,
        content: message.value.completion as string,
      },
    ])
  }

  const handleCompletionMessage = (message: ServerMessage) => {
    if (stopRef.current) {
      generatingRef.current = false
      return
    }
    setCompletion({
      role: ASSISTANT,
      content: getCompletionContent(message),
    })
    scrollToBottom()
  }

  const handleLoadingMessage = () => {
    setIsLoading(true)
    if (autoScrollContext) scrollToBottom()
  }

  const messageEventHandler = (event: MessageEvent) => {
    const message: ServerMessage = event.data
    switch (message.type) {
      case EVENT_NAME.twinnyAddMessage: {
        handleAddTemplateMessage(message)
        break
      }
      case EVENT_NAME.twinnyOnCompletion: {
        handleCompletionMessage(message)
        break
      }
      case EVENT_NAME.twinnyOnLoading: {
        handleLoadingMessage()
        break
      }
      case EVENT_NAME.twinnyOnEnd: {
        handleCompletionEnd(message)
        break
      }
      case EVENT_NAME.twinnyStopGeneration: {
        setCompletion(null)
        generatingRef.current = false
        setIsLoading(false)
        chatRef.current?.focus()
        setActiveConversation(undefined)
        setMessages([])
        setTimeout(() => {
          stopRef.current = false
        }, 1000)
      }
    }
  }

  const handleStopGeneration = () => {
    stopRef.current = true
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyStopGeneration,
    } as ClientMessage)
    setCompletion(null)
    setIsLoading(false)
    generatingRef.current = false
    setTimeout(() => {
      chatRef.current?.focus()
      stopRef.current = false
    }, 200)
  }

  const handleRegenerateMessage = (index: number): void => {
    setIsLoading(true)
    setMessages((prev) => {
      if (!prev) return prev
      const updatedMessages = prev.slice(0, index)

      global.vscode.postMessage({
        type: EVENT_NAME.twinnyChatMessage,
        data: updatedMessages,
      } as ClientMessage)

      return updatedMessages
    })
  }

  const handleDeleteMessage = (index: number): void => {
    setMessages((prev) => {
      if (!prev || prev.length === 0) return prev

      if (prev.length === 2) return prev

      const updatedMessages = [
        ...prev.slice(0, index),
        ...prev.slice(index + 2),
      ]

      saveLastConversation({
        ...conversation,
        messages: updatedMessages,
      })

      return updatedMessages
    })
  }

  const handleEditMessage = (message: string, index: number): void => {
    setIsLoading(true)
    setMessages((prev) => {
      if (!prev) return prev

      const updatedMessages = [
        ...prev.slice(0, index),
        { ...prev[index], content: message },
      ]

      global.vscode.postMessage({
        type: EVENT_NAME.twinnyChatMessage,
        data: updatedMessages,
      } as ClientMessage)

      return updatedMessages
    })
  }

  const getMentions = () => {
    const mentions: MentionType[] = []
    editorRef.current?.getJSON().content?.forEach((node) => {
      if (node.type === "paragraph" && Array.isArray(node.content)) {
        node.content.forEach((innerNode: JSONContent) => {
          if (innerNode.type === "mention" && innerNode.attrs) {
            mentions.push({
              name:
                innerNode.attrs.label ||
                innerNode.attrs.id.split("/").pop() ||
                "",
              path: innerNode.attrs.id,
            })
          }
        })
      }
    })

    return mentions
  }

  const replaceMentionsInText = useCallback(
    (text: string, mentions: MentionType[]): string => {
      return mentions.reduce(
        (result, mention) => result.replace(mention.path, `@${mention.name}`),
        text
      )
    },
    []
  )

  const handleSubmitForm = () => {
    const input = editorRef.current?.getText().trim()

    if (!input || generatingRef.current) return

    generatingRef.current = true

    const mentions = getMentions()

    setIsLoading(true)
    clearEditor()
    setMessages((prevMessages) => {
      const updatedMessages = [
        ...(prevMessages || []),
        { role: USER, content: replaceMentionsInText(input, mentions) },
      ]

      const clientMessage: ClientMessage<MessageType[], MentionType[]> = {
        type: EVENT_NAME.twinnyChatMessage,
        data: updatedMessages,
        meta: mentions,
      }

      global.vscode.postMessage(clientMessage)

      saveLastConversation({
        ...conversation,
        messages: updatedMessages,
      })
      return updatedMessages
    })

    setTimeout(() => {
      if (markdownRef.current) {
        markdownRef.current.scrollTop = markdownRef.current.scrollHeight
      }
    }, 200)
  }

  const clearEditor = useCallback(() => {
    editorRef.current?.commands.clearContent()
  }, [])

  const handleToggleAutoScroll = () => {
    setAutoScrollContext((prev) => {
      global.vscode.postMessage({
        type: EVENT_NAME.twinnySetWorkspaceContext,
        key: WORKSPACE_STORAGE_KEY.autoScroll,
        data: !prev,
      } as ClientMessage)

      if (!prev) scrollToBottom()

      return !prev
    })
  }

  const handleToggleProviderSelection = () => {
    if (showEmbeddingOptionsContext) handleToggleEmbeddingOptions()
    setShowProvidersContext((prev) => {
      global.vscode.postMessage({
        type: EVENT_NAME.twinnySetWorkspaceContext,
        key: WORKSPACE_STORAGE_KEY.showProviders,
        data: !prev,
      } as ClientMessage)
      return !prev
    })
  }

  const handleToggleEmbeddingOptions = () => {
    if (showProvidersContext) handleToggleProviderSelection()
    setShowEmbeddingOptionsContext((prev) => {
      global.vscode.postMessage({
        type: EVENT_NAME.twinnySetWorkspaceContext,
        key: WORKSPACE_STORAGE_KEY.showEmbeddingOptions,
        data: !prev,
      } as ClientMessage)
      return !prev
    })
  }

  const handleScrollBottom = () => {
    if (markdownRef.current) {
      markdownRef.current.scrollTop = markdownRef.current.scrollHeight
    }
  }

  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyHideBackButton,
    })
  }, [])

  useEffect(() => {
    window.addEventListener("message", messageEventHandler)
    editorRef.current?.commands.focus()
    scrollToBottom()
    return () => {
      window.removeEventListener("message", messageEventHandler)
    }
  }, [autoScrollContext])

  useEffect(() => {
    if (conversation?.messages?.length) {
      return setMessages(conversation.messages)
    }
  }, [conversation?.id, autoScrollContext, showProvidersContext])

  const { suggestion, filePaths } = useSuggestion()

  const memoizedSuggestion = useMemo(
    () => suggestion,
    [JSON.stringify(filePaths)]
  )

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        Mention.configure({
          HTMLAttributes: {
            class: "mention",
          },
          suggestion: memoizedSuggestion,
          renderText({ node }) {
            if (node.attrs.name) {
              return `${node.attrs.name ?? node.attrs.id}`
            }
            return node.attrs.id ?? ""
          },
        }),
        CustomKeyMap.configure({
          handleSubmitForm,
          clearEditor,
        }),
        Placeholder.configure({
          placeholder: "How can twinny help you today?",
        }),
      ],
    },
    [memoizedSuggestion]
  )

  useAutosizeTextArea(chatRef, editorRef.current?.getText() || "")

  useEffect(() => {
    if (editor) editorRef.current = editor
    editorRef.current?.commands.focus()
  }, [editor])

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.extensionManager.extensions.forEach((extension) => {
        if (extension.name === "mention") {
          extension.options.suggestion = memoizedSuggestion
        }
      })
    }
  }, [memoizedSuggestion])

  const handleNewConversation = () => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyNewConversation,
    })
  }

  return (
    <VSCodePanelView>
      <div className={styles.container}>
        {!!fullScreen && (
          <div className={styles.fullScreenActions}>
            <VSCodeButton
              onClick={handleNewConversation}
              appearance="icon"
              title="New conversation"
            >
              <i className="codicon codicon-comment-discussion" />
            </VSCodeButton>
          </div>
        )}
        <h4 className={styles.title}>
          {conversation?.title
            ? conversation?.title
            : generatingRef.current && <span>New conversation</span>}
        </h4>
        <div
          className={cn({
            [styles.markdown]: !fullScreen,
            [styles.markdownFullScreen]: fullScreen,
          })}
          ref={markdownRef}
        >
          {messages?.map((message, index) => (
            <Message
              key={index}
              onRegenerate={handleRegenerateMessage}
              onUpdate={handleEditMessage}
              onDelete={handleDeleteMessage}
              isLoading={isLoading || generatingRef.current}
              isAssistant={index % 2 !== 0}
              conversationLength={messages?.length}
              message={message}
              theme={theme}
              index={index}
            />
          ))}
          {isLoading && !generatingRef.current && !completion ? (
            <ChatLoader />
          ) : (
            !!completion && (
              <Message
                isLoading={false}
                isAssistant
                theme={theme}
                message={{
                  ...completion,
                  role: ASSISTANT,
                }}
              />
            )
          )}
        </div>
        {!!selection.length && (
          <Suggestions isDisabled={!!generatingRef.current} />
        )}
        {showProvidersContext && !symmetryConnection && <ProviderSelect />}
        {showProvidersContext && showEmbeddingOptionsContext && (
          <VSCodeDivider />
        )}
        {showEmbeddingOptionsContext && !symmetryConnection && (
          <EmbeddingOptions />
        )}
        <div className={styles.chatOptions}>
          <div>
            <VSCodeButton
              onClick={handleToggleAutoScroll}
              title="Toggle auto scroll on/off"
              appearance="icon"
            >
              {autoScrollContext ? (
                <EnabledAutoScrollIcon />
              ) : (
                <DisabledAutoScrollIcon />
              )}
            </VSCodeButton>
            <VSCodeButton
              title="Scroll down to the bottom"
              appearance="icon"
              onClick={handleScrollBottom}
            >
              <span className="codicon codicon-arrow-down"></span>
            </VSCodeButton>
            <VSCodeBadge>{selection?.length}</VSCodeBadge>
          </div>
          <div>
            {generatingRef.current && !symmetryConnection && (
              <VSCodeButton
                type="button"
                appearance="icon"
                onClick={handleStopGeneration}
                aria-label="Stop generation"
              >
                <span className="codicon codicon-debug-stop"></span>
              </VSCodeButton>
            )}
            {!symmetryConnection && (
              <>
                <VSCodeButton
                  title="Embedding options"
                  appearance="icon"
                  onClick={handleToggleEmbeddingOptions}
                >
                  <span className="codicon codicon-database"></span>
                </VSCodeButton>
                <VSCodeButton
                  title="Select active providers"
                  appearance="icon"
                  onClick={handleToggleProviderSelection}
                >
                  <span className="codicon codicon-keyboard"></span>
                </VSCodeButton>
              </>
            )}
            {!!symmetryConnection && (
              <a
                href={`https://twinny.dev/symmetry/?id=${symmetryConnection.id}`}
              >
                <VSCodeBadge
                  title={`Connected to symmetry network provider ${symmetryConnection?.name}, model ${symmetryConnection?.modelName}, provider ${symmetryConnection?.provider}`}
                >
                  ⚡️ {symmetryConnection?.name}
                </VSCodeBadge>
              </a>
            )}
          </div>
        </div>
        <form>
          <div className={styles.chatBox}>
            <EditorContent
              placeholder="How can twinny help you today?"
              className={styles.tiptap}
              editor={editorRef.current}
            />
            <div
              role="button"
              onClick={handleSubmitForm}
              className={styles.chatSubmit}
            >
              <span className="codicon codicon-send"></span>
            </div>
          </div>
        </form>
      </div>
    </VSCodePanelView>
  )
}

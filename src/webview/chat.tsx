import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Virtuoso, VirtuosoHandle } from "react-virtuoso"
import Mention from "@tiptap/extension-mention"
import Placeholder from "@tiptap/extension-placeholder"
import { Editor, EditorContent, JSONContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import {
  VSCodeBadge,
  VSCodeButton,
  VSCodePanelView
} from "@vscode/webview-ui-toolkit/react"
import cn from "classnames"
import DOMPurify from "dompurify"

import { EVENT_NAME, USER } from "../common/constants"
import {
  ChatCompletionMessage,
  ClientMessage,
  MentionType,
  ServerMessage
} from "../common/types"

import {
  useAutosizeTextArea,
  useConversationHistory,
  useFileContext,
  useSelection,
  useSuggestion,
  useSymmetryConnection,
  useTheme
} from "./hooks"
import { Message as MessageComponent } from "./message"
import { ProviderSelect } from "./provider-select"
import { Suggestions } from "./suggestions"
import TypingIndicator from "./typing-indicator"
import { CustomKeyMap } from "./utils"

import styles from "./styles/index.module.css"

interface ChatProps {
  fullScreen?: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

const MemoizedMessageComponent = React.memo(MessageComponent)
const MemoizedVSCodeButton = React.memo(VSCodeButton)

export const Chat = (props: ChatProps): JSX.Element => {
  const { fullScreen } = props
  const generatingRef = useRef(false)
  const editorRef = useRef<Editor | null>(null)
  const stopRef = useRef(false)
  const theme = useTheme()
  const selection = useSelection()
  const { t } = useTranslation()
  const [isLoading, setIsLoading] = useState(false)
  const [messages, setMessages] = useState<ChatCompletionMessage[]>([])
  const [completion, setCompletion] = useState<ChatCompletionMessage | null>()
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const { symmetryConnection } = useSymmetryConnection()
  const { files, removeFile } = useFileContext()
  const shouldScrollRef = useRef(true)
  const [isAtBottom, setIsAtBottom] = useState(true)

  const { conversation, saveLastConversation, setActiveConversation } =
    useConversationHistory()

  const chatRef = useRef<HTMLTextAreaElement>(null)


  const handleAddMessage = (message: ServerMessage<ChatCompletionMessage>) => {
    if (!message.data) {
      setCompletion(null)
      setIsLoading(false)
      generatingRef.current = false
      return
    }

    setMessages((prev) => {
      if (message.data.id) {
        const existingIndex = prev?.findIndex((m) => m.id === message.data.id)

        if (existingIndex !== -1) {
          const updatedMessages = [...(prev || [])]
          updatedMessages[existingIndex || 0] = message.data

          saveLastConversation({
            ...conversation,
            messages: updatedMessages
          })
          return updatedMessages
        }
      }

      const messages = [...(prev || []), message.data]
      saveLastConversation({
        ...conversation,
        messages: messages
      })
      return messages
    })

    setTimeout(() => {
      editorRef.current?.commands.focus()
      stopRef.current = false
    }, 200)

    setCompletion(null)
    setIsLoading(false)
  }

  const handleCompletionMessage = (
    message: ServerMessage<ChatCompletionMessage>
  ) => {
    setCompletion(message.data)
  }

  const handleLoadingMessage = () => {
    setIsLoading(true)
  }

  const messageEventHandler = (event: MessageEvent) => {
    const message: ServerMessage = event.data
    switch (message.type) {
      case EVENT_NAME.twinnyAddMessage: {
        handleAddMessage(message as ServerMessage<ChatCompletionMessage>)
        break
      }
      case EVENT_NAME.twinnyOnCompletion: {
        handleCompletionMessage(message as ServerMessage<ChatCompletionMessage>)
        break
      }
      case EVENT_NAME.twinnyOnLoading: {
        handleLoadingMessage()
        break
      }
      case EVENT_NAME.twinnyNewConversation: {
        setMessages([])
        setCompletion(null)
        setActiveConversation(undefined)
        generatingRef.current = false
        setIsLoading(false)
        chatRef.current?.focus()
        setTimeout(() => {
          stopRef.current = false
        }, 1000)
        break
      }
      case EVENT_NAME.twinnyStopGeneration: {
        setIsLoading(false)
        setCompletion(null)
        stopRef.current = false
        generatingRef.current = false
        setTimeout(() => {
          chatRef.current?.focus()
        }, 200)
      }
    }
  }

  const handleStopGeneration = useCallback(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyStopGeneration
    } as ClientMessage)
  }, [])

  const handleRegenerateMessage = (
    index: number,
    mentions: MentionType[] | undefined
  ): void => {
    generatingRef.current = true
    setIsLoading(true)
    setMessages((prev) => {
      if (!prev) return prev
      const updatedMessages = prev.slice(0, index)

      global.vscode.postMessage({
        type: EVENT_NAME.twinnyChatMessage,
        data: updatedMessages,
        meta: mentions
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
        ...prev.slice(index + 2)
      ]

      saveLastConversation({
        ...conversation,
        messages: updatedMessages
      })

      return updatedMessages
    })
  }

  const handleEditMessage = (
    message: string,
    index: number,
    mentions: MentionType[] | undefined
  ): void => {
    generatingRef.current = true
    setIsLoading(true)
    setMessages((prev) => {
      if (!prev) return prev

      const updatedMessages = [
        ...prev.slice(0, index),
        { ...prev[index], content: message }
      ]

      global.vscode.postMessage({
        type: EVENT_NAME.twinnyChatMessage,
        data: updatedMessages,
        meta: mentions
      } as ClientMessage)

      console.log("here")

      return updatedMessages
    })
  }

  const getMentions = useCallback(() => {
    const mentions: MentionType[] = []
    editorRef.current?.getJSON().content?.forEach((node) => {
      if (node.type === "paragraph" && Array.isArray(node.content)) {
        node.content.forEach((innerNode: JSONContent) => {
          if (innerNode.type === "mention" && innerNode.attrs) {
            mentions.push({
              name: innerNode.attrs.label,
              path: innerNode.attrs.id
            })
          }
        })
      }
    })

    return mentions
  }, [])

  const clearEditor = useCallback(() => {
    editorRef.current?.commands.clearContent()
  }, [])

  const handleSubmitForm = useCallback(() => {
    const input = editorRef.current?.getHTML()

    if (!input || generatingRef.current) return

    generatingRef.current = true

    const mentions = getMentions()

    setIsLoading(true)
    clearEditor()

    setMessages((prevMessages) => {
      const updatedMessages: ChatCompletionMessage[] = [
        ...(prevMessages || []),
        { role: USER, content: input }
      ]

      const clientMessage: ClientMessage<
        ChatCompletionMessage[],
        MentionType[]
      > = {
        type: EVENT_NAME.twinnyChatMessage,
        data: updatedMessages,
        meta: mentions
      }

      saveLastConversation({
        ...conversation,
        messages: updatedMessages
      })

      global.vscode.postMessage(clientMessage)

      return updatedMessages
    })

    shouldScrollRef.current = true
  }, [])

  const handleNewConversation = useCallback(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyNewConversation
    })
  }, [])

  const handleOpenFile = useCallback((filePath: string) => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyOpenFile,
      data: filePath
    })
  }, [])

  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyHideBackButton
    })
  }, [])

  useEffect(() => {
    window.addEventListener("message", messageEventHandler)
    editorRef.current?.commands.focus()
    return () => {
      window.removeEventListener("message", messageEventHandler)
    }
  }, [])

  useEffect(() => {
    if (conversation?.messages?.length) {
      setMessages(conversation.messages)
    }
  }, [conversation?.id])

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
            class: "mention"
          },
          suggestion: memoizedSuggestion,
          renderText({ node }) {
            return node.attrs.label
          }
        }),
        CustomKeyMap.configure({
          handleSubmitForm,
          clearEditor
        }),
        Placeholder.configure({
          placeholder: t("placeholder")
        })
      ]
    },
    [memoizedSuggestion, handleSubmitForm, clearEditor, t]
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

  const renderFileItem = useCallback(
    (file: { path: string; name: string }) => (
      <div
        key={file.path}
        title={file.path}
        className={styles.fileItem}
        onClick={() => handleOpenFile(file.path)}
      >
        {file.name}
        <span
          onClick={(e) => {
            e.stopPropagation()
            removeFile(file.path)
          }}
          data-id={file.path}
          className="codicon codicon-close"
        />
      </div>
    ),
    [handleOpenFile, removeFile]
  )

  const itemContent = (index: number, message: ChatCompletionMessage) => {
    const isUserMessage = message.role === "user"
    const isAgentMessage = message.role === "assistant"
    const isLastMessage = index === messages?.length - 1

    const renderMessage = (role: string, key: string, props: object) => (
      <MemoizedMessageComponent
        key={`${role}-${key}`}
        isAssistant={role === "assistant"}
        message={message}
        theme={theme}
        index={index}
        {...props}
      />
    )

    const props = {
      conversationLength: messages?.length,
      isLoading: isLoading || generatingRef.current,
      messages: messages,
      onDelete: handleDeleteMessage,
      onEdit: handleEditMessage,
      onRegenerate: handleRegenerateMessage,
    }

    return (
      <>
        {isUserMessage && renderMessage("user", `${index - 1}`, props)}
        {isAgentMessage && renderMessage("assistant", `${index}`, props)}
        {completion &&
          isLastMessage &&
          renderMessage("assistant", `${index}`, {
            ...props,
            message: completion
          })}
        {isLoading && !completion && isLastMessage && (
          <div className={cn(styles.message, styles.assistantMessage)}>
            <TypingIndicator />
          </div>
        )}
      </>
    )
  }

  const scrollToBottom = useCallback((behavior?: ScrollBehavior | undefined) => {
    virtuosoRef.current?.scrollTo({
      top: Number.MAX_SAFE_INTEGER,
      behavior: behavior || "auto"
    })
  }, [])

  useEffect(() => {
    if (virtuosoRef.current && isAtBottom) {
      scrollToBottom()
    }
  }, [completion, messages, scrollToBottom, isAtBottom])

  return (
    <VSCodePanelView>
      <div className={styles.container}>
        {!!fullScreen && (
          <div className={styles.fullScreenActions}>
            <MemoizedVSCodeButton
              onClick={handleNewConversation}
              appearance="icon"
              title={t("new-conversation")}
            >
              <i className="codicon codicon-comment-discussion" />
            </MemoizedVSCodeButton>
          </div>
        )}
        <h4 className={styles.title}>
          {conversation?.title ? (
            <span
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(conversation?.title)
              }}
            />
          ) : (
            generatingRef.current && <span>New conversation</span>
          )}
        </h4>
        {!!files.length && (
          <div className={styles.fileItems}>{files.map(renderFileItem)}</div>
        )}
        <Virtuoso
          ref={virtuosoRef}
          data={messages}
          initialTopMostItemIndex={messages?.length}
          defaultItemHeight={800}
          atBottomStateChange={setIsAtBottom}
          itemContent={itemContent}
          atBottomThreshold={20}
          alignToBottom
        />
        {!!selection.length && (
          <Suggestions isDisabled={!!generatingRef.current} />
        )}
        <div className={styles.chatOptions}>
          <div>
            {!isAtBottom && (
              <div className={styles.scrollToBottom}>
                <MemoizedVSCodeButton
                  appearance="icon"
                  onClick={() => scrollToBottom("smooth")}
                  title={t("scroll-to-bottom")}
                >
                  <i className="codicon codicon-arrow-down" />
                </MemoizedVSCodeButton>
              </div>
            )}
            {generatingRef.current && !symmetryConnection && (
              <MemoizedVSCodeButton
                type="button"
                appearance="icon"
                onClick={handleStopGeneration}
                aria-label={t("stop-generation")}
              >
                <span className="codicon codicon-debug-stop"></span>
              </MemoizedVSCodeButton>
            )}
          </div>
          <div>
            <VSCodeBadge>{selection?.length}</VSCodeBadge>
            {!!symmetryConnection && (
              <VSCodeBadge
                title={`Connected to symmetry network provider ${symmetryConnection?.name}, model ${symmetryConnection?.modelName}, provider ${symmetryConnection?.provider}`}
              >
                ⚡️ {symmetryConnection?.name}
              </VSCodeBadge>
            )}
          </div>
        </div>
        <form>
          <div className={styles.chatBox}>
            <EditorContent
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
        {!symmetryConnection && <ProviderSelect />}
      </div>
    </VSCodePanelView>
  )
}

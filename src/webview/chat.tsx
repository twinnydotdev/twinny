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
import * as cheerio from "cheerio"
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
import MessageItem from "./message-item"
import { ProviderSelect } from "./provider-select"
import { Suggestions } from "./suggestions"
import { CustomKeyMap } from "./utils"

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
  const selection = useSelection()
  const { t } = useTranslation()
  const [isLoading, setIsLoading] = useState(false)
  const [messages, setMessages] = useState<ChatCompletionMessage[]>([])
  const [completion, setCompletion] = useState<ChatCompletionMessage | null>()
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const { symmetryConnection } = useSymmetryConnection()
  const { files, removeFile } = useFileContext()
  const [isBottom, setIsBottom] = useState(false)

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
        {
          ...prev[index],
          content: message
            .replace(/<p>/g, "")
            .replace(/<\/p>/g, "<br>")
            .replace(/<br>$/, "")
        }
      ]

      global.vscode.postMessage({
        type: EVENT_NAME.twinnyChatMessage,
        data: updatedMessages,
        meta: mentions
      } as ClientMessage)

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
    const input = editorRef.current
      ?.getHTML()
      .replace(/<p>/g, "")
      .replace(/<\/p>/g, "<br>")
      .replace(/<br>$/, "")

    const text = cheerio
      .load(input || "")
      .root()
      .text()
      .trim()

    if (!text || generatingRef.current || !input) return

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

  const scrollToBottom = useCallback(() => {
    virtuosoRef.current?.scrollTo({
      top: Infinity,
      behavior: "auto"
    })
  }, [])

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

  const itemContent = useCallback(
    (index: number) => (
      <MessageItem
        key={`message-list-${index}`}
        handleDeleteMessage={handleDeleteMessage}
        handleEditMessage={handleEditMessage}
        handleRegenerateMessage={handleRegenerateMessage}
        isLoading={isLoading}
        message={messages[index]}
        index={index}
        completion={completion}
        theme={theme}
        generatingRef={generatingRef}
        messages={messages}
      />
    ),
    [
      handleDeleteMessage,
      handleEditMessage,
      handleRegenerateMessage,
      isLoading,
      messages,
      completion,
      theme,
      generatingRef
    ]
  )

  return (
    <VSCodePanelView>
      <div className={styles.container}>
        {!!fullScreen && (
          <div className={styles.fullScreenActions}>
            <VSCodeButton
              onClick={handleNewConversation}
              appearance="icon"
              title={t("new-conversation")}
            >
              <i className="codicon codicon-comment-discussion" />
            </VSCodeButton>
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
          followOutput
          ref={virtuosoRef}
          data={messages}
          initialTopMostItemIndex={messages?.length}
          defaultItemHeight={800}
          itemContent={itemContent}
          atBottomThreshold={20}
          atBottomStateChange={(bottom) => setIsBottom(bottom)}
          alignToBottom
        />
        {!!selection.length && (
          <Suggestions isDisabled={!!generatingRef.current} />
        )}
        <div className={styles.chatOptions}>
          <div>
            {!isBottom && (
              <div className={styles.scrollToBottom}>
                <VSCodeButton
                  appearance="icon"
                  onClick={scrollToBottom}
                  title={t("scroll-to-bottom")}
                >
                  <i className="codicon codicon-arrow-down" />
                </VSCodeButton>
              </div>
            )}
            {generatingRef.current && !symmetryConnection && (
              <VSCodeButton
                type="button"
                appearance="icon"
                onClick={handleStopGeneration}
                aria-label={t("stop-generation")}
              >
                <span className="codicon codicon-debug-stop"></span>
              </VSCodeButton>
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

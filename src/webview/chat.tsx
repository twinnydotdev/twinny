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
import { v4 as uuidv4 } from "uuid"

import { EVENT_NAME, USER } from "../common/constants"
import {
  ChatCompletionMessage,
  ClientMessage,
  ImageAttachment,
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
import { createCustomImageExtension } from "./image-extension"
import MessageItem from "./message-item"
import { ProviderSelect } from "./provider-select"
import { Suggestions } from "./suggestions"
import { CustomKeyMap } from "./utils"

import styles from "./styles/chat.module.css"

interface ChatProps {
  fullScreen?: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const Chat = (props: ChatProps): JSX.Element => {
  const { fullScreen } = props
  const generatingRef = useRef(false)
  const editorRef = useRef<Editor | null>(null)
  const imagesRef = useRef<ImageAttachment[]>([])
  const stopRef = useRef(false)
  const theme = useTheme()
  const selection = useSelection()
  const { t } = useTranslation()
  const [isLoading, setIsLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
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
        generatingRef.current = true
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
        setActiveConversation({
          id: uuidv4(),
          title: "New conversation",
          messages: []
        });
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
        meta: mentions,
        key: conversation?.id
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
    mentions: MentionType[] | undefined,
    images?: ImageAttachment[]
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
            .replace(/<br>$/, ""),
          images: images && images.length > 0 ? images : undefined
        }
      ]

      global.vscode.postMessage({
        type: EVENT_NAME.twinnyChatMessage,
        data: updatedMessages,
        meta: mentions,
        key: conversation?.id
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

    const conversationId = conversation?.id || uuidv4();

    setMessages((prevMessages) => {
      const updatedMessages: ChatCompletionMessage[] = [
        ...(prevMessages || []),
        {
          role: USER,
          content: input,
          images: imagesRef.current.length > 0 ? imagesRef.current : undefined
        }
      ]

      const currentConversation = {
        id: conversationId,
        messages: updatedMessages,
        title: conversation?.title || "New conversation"
      };

      const clientMessage: ClientMessage<
        ChatCompletionMessage[],
        MentionType[]
      > = {
        type: EVENT_NAME.twinnyChatMessage,
        data: updatedMessages,
        meta: mentions,
        key: conversationId,
      }

      imagesRef.current = []
      saveLastConversation(currentConversation)
      setActiveConversation(currentConversation)

      global.vscode.postMessage(clientMessage)

      return updatedMessages
    })
  }, [
    conversation?.id,
  ])

  const handleNewConversation = useCallback(() => {
    setActiveConversation({
      id: uuidv4(),
      title: "New conversation",
      messages: []
    });

    global.vscode.postMessage({
      type: EVENT_NAME.twinnyNewConversation
    })
  }, [setActiveConversation])

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
    if (editorRef.current) {
      global.vscode.postMessage({ type: EVENT_NAME.twinnySidebarReady })
    }
  }, [editorRef.current])

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


  const CustomImageExtension = createCustomImageExtension((id: string) => {
    imagesRef.current = imagesRef.current.filter(img => img.id !== id)
  })

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
        CustomImageExtension.configure({
          allowBase64: true,
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
    [memoizedSuggestion, handleSubmitForm, clearEditor, t, imagesRef]
  )

  const handleImageUpload = useCallback((file: File) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const base64 = e.target?.result as string
      const imageData = base64.startsWith("data:") ? base64 : `data:${file.type};base64,${base64.split(",").pop()}`
      const id = crypto.randomUUID()
      const newImage = { id, data: imageData, type: file.type }

      imagesRef.current = [...imagesRef.current, newImage]

      const { state } = editor?.view || {}

      if (state) {
        if (state.selection.empty && state.selection.$head.pos === state.doc.content.size) {
          editor?.chain().focus().createParagraphNear().run()
        }

        editor?.chain().focus().insertContent({
          type: "image",
          attrs: { src: imageData, id }
        }).run()

        editor?.chain().focus().createParagraphNear().run()
      } else {
        editor?.chain().focus().insertContent({
          type: "image",
          attrs: { src: imageData, id }
        }).run()
      }
    }
    reader.readAsDataURL(file)
  }, [editor])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files).filter(file => file.type.startsWith("image/"))
    files.forEach(handleImageUpload)
  }, [handleImageUpload])

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLFormElement>) => {
    const items = Array.from(e.clipboardData?.items || [])
    const imageItem = items.find(item => item.type.startsWith("image/"))

    if (imageItem) {
      e.preventDefault()
      const file = imageItem.getAsFile()
      if (file) handleImageUpload(file)
      return
    }

  }, [handleImageUpload])

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter(file => file.type.startsWith("image/"))
    files.forEach(handleImageUpload)
    e.target.value = ""
  }, [handleImageUpload])

  const handleDeleteImage = (id: string) => {
    imagesRef.current = imagesRef.current.filter(img => img.id !== id)
  }

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
        completion={completion}
        generatingRef={generatingRef}
        handleDeleteImage={handleDeleteImage}
        handleDeleteMessage={handleDeleteMessage}
        handleEditMessage={handleEditMessage}
        handleRegenerateMessage={handleRegenerateMessage}
        index={index}
        isLoading={isLoading}
        message={messages[index]}
        messages={messages}
        theme={theme}
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
        <form onDrop={handleDrop} onPaste={handlePaste}>
          <div className={styles.chatBox}>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              accept="image/*"
              multiple
              style={{ display: "none" }}
            />
            <EditorContent
              className={styles.tiptap}
              editor={editorRef.current}
            />
            <div className={styles.chatButtons}>
              <VSCodeButton
                appearance="icon"
                role="button"
                onClick={handleFileSelect}
                title={t("upload-image")}
              >
                <span className="codicon codicon-device-camera" />
              </VSCodeButton>
              <VSCodeButton
                appearance="icon"
                role="button"
                onClick={handleSubmitForm}
                title={t("send")}
              >
                <span className="codicon codicon-send"></span>
              </VSCodeButton>
            </div>
          </div>
        </form>
        {!symmetryConnection && <ProviderSelect />}
      </div>
    </VSCodePanelView>
  )
}

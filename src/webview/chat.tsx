import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Virtuoso, VirtuosoHandle } from "react-virtuoso"
import Mention from "@tiptap/extension-mention"
import Placeholder from "@tiptap/extension-placeholder"
import { Editor, EditorContent, JSONContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { VSCodeButton, VSCodePanelView } from "@vscode/webview-ui-toolkit/react"
import * as cheerio from "cheerio"
import cx from "classnames"
import { v4 as uuidv4 } from "uuid"

import { ASSISTANT, EVENT_NAME, USER } from "../common/constants"
import {
  AnyContextItem,
  ChatCompletionMessage,
  ImageAttachment,
  MentionType,
  ToolStepView
} from "../common/types"

import { useAgentMode } from "./hooks/useAgentMode"
import { useAutoRun } from "./hooks/useAutoRun"
import { useAutosizeTextArea } from "./hooks/useAutosizeTextArea"
import { useConversationHistory } from "./hooks/useConversationHistory"
import { useProviders } from "./hooks/useProviders"
import { useSelection } from "./hooks/useSelection"
import { useSuggestion } from "./hooks/useSuggestion"
import { useToolSteps } from "./hooks/useToolSteps"
import { useWorkspaceContext } from "./hooks/useWorkspaceContext"
import { useWorkspaceSearch } from "./hooks/useWorkspaceSearch"
import { ProviderSelect } from "./providers/provider-select"
import { EmptyChat } from "./empty-chat"
import { createCustomImageExtension } from "./image-extension"
import MessageItem from "./message-item"
import { emit, useServerEvent } from "./messaging"
import { Shortcuts } from "./shortcuts"
import { Suggestions } from "./suggestions"
import { answerToolStep } from "./tool-steps"
import { conversationMarkdown } from "./transcript"
import { CustomKeyMap, getThinkingMessage } from "./utils"

import styles from "./styles/chat.module.css"

const COMPOSER_MIN_HEIGHT = 44
const COMPOSER_HEIGHT_KEY = "twinny.composerHeight"
const PROMPT_HISTORY_KEY = "twinny.promptHistory"
const PROMPT_HISTORY_LIMIT = 50
/** Two presses of Esc this close together clear the draft. */
const DOUBLE_ESCAPE_MS = 800
/** Where a key belongs to whatever has focus, not to the chat. */
const KEY_OWNERS =
  "input, textarea, select, .ProseMirror, [contenteditable='true'], " +
  "vscode-text-field, vscode-text-area, vscode-dropdown"

const loadPromptHistory = (): string[] => {
  try {
    const stored = JSON.parse(localStorage.getItem(PROMPT_HISTORY_KEY) || "[]")
    return Array.isArray(stored) ? stored.filter((p) => typeof p === "string") : []
  } catch {
    return []
  }
}

interface QueuedMessage {
  id: string
  /** As the composer had it, so it can go back there. */
  html: string
  /** As sent: paragraphs joined with line breaks. */
  input: string
  text: string
  mentions: MentionType[]
  images: ImageAttachment[]
}

interface ChatProps {
  fullScreen?: boolean
  active?: boolean
}

export const Chat = (props: ChatProps): JSX.Element => {
  const { fullScreen, active = true } = props
  const generatingRef = useRef(false)
  const editorRef = useRef<Editor | null>(null)
  const imagesRef = useRef<ImageAttachment[]>([])
  const stopRef = useRef(false)
  const selection = useSelection()
  const { t } = useTranslation()
  const [isLoading, setIsLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [messages, setMessages] = useState<ChatCompletionMessage[]>([])
  // Nothing can answer without a chat provider, so the composer is off
  // until one is set; the empty transcript says where to set it.
  const { chatProvider, ready: providersReady } = useProviders()
  const chatDisabled = providersReady && !chatProvider
  const [completion, setCompletion] = useState<ChatCompletionMessage | null>()
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const { contextItems, removeContextItem } = useWorkspaceContext()
  const {
    report: searchReport,
    clear: clearSearchReport,
    take: takeSearchReport
  } = useWorkspaceSearch()
  // Kept as the events arrive, not on render, so a step that comes in
  // right behind a chunk of text is placed after that chunk.
  const completionRef = useRef<ChatCompletionMessage | null | undefined>()
  completionRef.current = completion
  const { steps: toolSteps, clear: clearToolSteps, take: takeToolSteps } = useToolSteps(
    () => getThinkingMessage(String(completionRef.current?.content ?? "")).message
  )
  const [isBottom, setIsBottom] = useState(false)
  const { agentMode, toggleAgentMode } = useAgentMode()
  const { autoRun, autoRunAvailable, toggleAutoRun } = useAutoRun()

  const { conversation, saveLastConversation, setActiveConversation } =
    useConversationHistory()

  const chatRef = useRef<HTMLTextAreaElement>(null)
  const editorWrapRef = useRef<HTMLDivElement>(null)
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null)
  // Sent prompts, oldest first, recalled with the arrow keys. `recallIndex`
  // counts back from the newest; -1 is the draft being typed.
  const promptHistoryRef = useRef<string[]>(loadPromptHistory())
  const recallIndexRef = useRef(-1)
  const draftRef = useRef("")
  const [showShortcuts, setShowShortcuts] = useState(false)
  /*
   * Messages typed while a reply is running: each goes out when the one
   * before it is answered. Stopping the reply puts them back in the
   * composer instead, since what they followed on from was cut short.
   */
  const [queued, setQueued] = useState<QueuedMessage[]>([])
  const queuedRef = useRef<QueuedMessage[]>([])
  const userStoppedRef = useRef(false)
  const showShortcutsRef = useRef(false)
  const lastEscapeRef = useRef(0)
  const hintTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const [hint, setHint] = useState<string | null>(null)
  const [composerHeight, setComposerHeight] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem(COMPOSER_HEIGHT_KEY))
    return stored > 0 ? stored : null
  })

  const handleAddMessage = (added: ChatCompletionMessage | undefined) => {
    if (!added) {
      setCompletion(null)
      setIsLoading(false)
      generatingRef.current = false
      return
    }

    // A reply keeps the workspace search that fed it, so the sources stay
    // with the message once it is saved. A new user turn starts afresh.
    let incoming = added
    if (added.role === ASSISTANT) {
      const context = takeSearchReport()
      const steps = takeToolSteps()
      incoming = { ...added, ...(context ? { context } : {}), ...(steps ? { toolSteps: steps } : {}) }
    } else {
      clearSearchReport()
      clearToolSteps()
    }

    setMessages((prev) => {
      if (incoming.id) {
        const existingIndex = prev?.findIndex((m) => m.id === incoming.id)

        if (existingIndex !== -1) {
          const updatedMessages = [...(prev || [])]
          updatedMessages[existingIndex || 0] = incoming

          saveLastConversation({
            ...conversation,
            messages: updatedMessages
          })
          return updatedMessages
        }
      }

      const messages = [...(prev || []), incoming]
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

  useServerEvent(EVENT_NAME.twinnyAddMessage, (incoming) => {
    generatingRef.current = true
    handleAddMessage(incoming)
  })

  useServerEvent(EVENT_NAME.twinnyOnCompletion, (incoming) => {
    completionRef.current = incoming
    setCompletion(incoming)
  })

  useServerEvent(EVENT_NAME.twinnyOnLoading, () => setIsLoading(true))

  useServerEvent(EVENT_NAME.twinnyNewConversation, () => {
    updateQueue([])
    setMessages([])
    setCompletion(null)
    clearSearchReport()
    clearToolSteps()
    setActiveConversation({
      id: uuidv4(),
      title: t("chat-new-conversation-title"),
      messages: []
    })
    generatingRef.current = false
    setIsLoading(false)
    chatRef.current?.focus()
    setTimeout(() => {
      stopRef.current = false
    }, 1000)
  })

  useServerEvent(EVENT_NAME.twinnyStopGeneration, () => {
    setIsLoading(false)
    setCompletion(null)
    stopRef.current = false
    generatingRef.current = false
    const stopped = userStoppedRef.current
    userStoppedRef.current = false
    const [next, ...rest] = queuedRef.current
    if (next && !stopped) {
      updateQueue(rest)
      // After this event's own state updates, so the reply is in the transcript first.
      setTimeout(() => sendRef.current(next), 0)
      return
    }
    if (next) restoreQueue()
    setTimeout(() => {
      chatRef.current?.focus()
    }, 200)
  })

  const updateQueue = (next: QueuedMessage[]) => {
    queuedRef.current = next
    setQueued(next)
  }

  /* Queued messages back in the composer, after anything already typed there. */
  const restoreQueue = () => {
    const editor = editorRef.current
    const waiting = queuedRef.current
    updateQueue([])
    if (!editor || !waiting.length) return
    const draft = editor.isEmpty ? "" : editor.getHTML()
    editor.commands.setContent(draft + waiting.map((message) => message.html).join(""), false)
    imagesRef.current = [...imagesRef.current, ...waiting.flatMap((message) => message.images)]
    editor.commands.focus("end")
  }

  const handleStopGeneration = useCallback(() => {
    userStoppedRef.current = true
    emit(EVENT_NAME.twinnyStopGeneration)
  }, [])

  const handleRegenerateMessage = (
    index: number,
    mentions: MentionType[] | undefined
  ): void => {
    generatingRef.current = true
    setIsLoading(true)
    clearSearchReport()
    clearToolSteps()
    setMessages((prev) => {
      if (!prev) return prev
      const updatedMessages = prev.slice(0, index)

      emit(EVENT_NAME.twinnyChatMessage, {
        messages: updatedMessages,
        mentions: mentions || [],
        conversationId: conversation?.id
      })

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
    clearSearchReport()
    clearToolSteps()
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
          images: images && images.length > 0 ? images : undefined,
          // The user rewrote it: what a feature recorded no longer applies.
          prompt: undefined
        }
      ]

      emit(EVENT_NAME.twinnyChatMessage, {
        messages: updatedMessages,
        mentions: mentions || [],
        conversationId: conversation?.id
      })

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

  /* Images are left out: they are large and belong to the turn they were sent with. */
  const rememberPrompt = (html: string) => {
    const prompt = html.replace(/<img[^>]*>/g, "").trim()
    recallIndexRef.current = -1
    if (!prompt) return
    const history = promptHistoryRef.current.filter((p) => p !== prompt)
    history.push(prompt)
    promptHistoryRef.current = history.slice(-PROMPT_HISTORY_LIMIT)
    try {
      localStorage.setItem(
        PROMPT_HISTORY_KEY,
        JSON.stringify(promptHistoryRef.current)
      )
    } catch {
      // A full or blocked store only costs the history.
    }
  }

  /** Step through sent prompts; false leaves the key to the editor. */
  const recallPrompt = useCallback((step: -1 | 1, isEmpty: boolean) => {
    const editor = editorRef.current
    const history = promptHistoryRef.current
    const index = recallIndexRef.current
    if (!editor || !history.length) return false
    if (index === -1 && (step === 1 || !isEmpty)) return false

    if (index === -1) draftRef.current = editor.getHTML()
    const next = Math.min(history.length - 1, index - step)
    if (next === index) return true
    recallIndexRef.current = next
    editor.commands.setContent(
      next === -1 ? draftRef.current : history[history.length - 1 - next],
      false
    )
    editor.commands.focus("end")
    return true
  }, [])

  const clearEditor = useCallback(() => {
    editorRef.current?.commands.clearContent()
  }, [])

  const setShortcuts = useCallback((open: boolean) => {
    showShortcutsRef.current = open
    setShowShortcuts(open)
  }, [])

  /* The draft goes into the prompt history, so the up arrow brings it back. */
  const clearDraft = useCallback(() => {
    const editor = editorRef.current
    if (!editor || editor.isEmpty) return false
    rememberPrompt(editor.getHTML())
    imagesRef.current = []
    editor.commands.clearContent()
    return true
  }, [])

  /* A command or change waiting on the user, answered from the keys. */
  const waitingStepRef = useRef<ToolStepView>()
  waitingStepRef.current = toolSteps.find((step) => step.status === "waiting")
  const approveWaiting = useCallback((how: "run" | "always" | "skip") => {
    const step = waitingStepRef.current
    if (!step) return false
    answerToolStep(step, how)
    return true
  }, [])

  const stopIfGenerating = useCallback(() => {
    if (!generatingRef.current) return false
    userStoppedRef.current = true
    emit(EVENT_NAME.twinnyStopGeneration)
    return true
  }, [])

  /*
   * Esc closes the shortcuts, else skips what a tool is waiting on, else
   * stops a reply, else clears the draft on the second press. False leaves
   * the key to the editor.
   */
  const handleEscape = useCallback(() => {
    if (showShortcutsRef.current) {
      setShortcuts(false)
      return true
    }
    if (approveWaiting("skip")) return true
    if (stopIfGenerating()) return true
    const editor = editorRef.current
    if (!editor || editor.isEmpty) return false

    clearTimeout(hintTimerRef.current)
    if (Date.now() - lastEscapeRef.current < DOUBLE_ESCAPE_MS) {
      lastEscapeRef.current = 0
      setHint(null)
      return clearDraft()
    }
    lastEscapeRef.current = Date.now()
    setHint(t("shortcuts-esc-again"))
    hintTimerRef.current = setTimeout(() => setHint(null), DOUBLE_ESCAPE_MS)
    return true
  }, [approveWaiting, clearDraft, setShortcuts, stopIfGenerating, t])

  /* Ctrl+C with nothing selected; with a selection it is still a copy. */
  const handleInterrupt = useCallback(() => {
    if (!window.getSelection()?.isCollapsed) return false
    return stopIfGenerating() || clearDraft()
  }, [clearDraft, stopIfGenerating])

  const toggleShortcuts = useCallback(() => {
    setShortcuts(!showShortcutsRef.current)
    return true
  }, [setShortcuts])

  const scrollTranscript = useCallback((direction: -1 | 1) => {
    virtuosoRef.current?.scrollBy({
      top: direction * window.innerHeight * 0.6
    })
    return true
  }, [])

  useEffect(() => () => clearTimeout(hintTimerRef.current), [])

  /** One message to the model: into the transcript and out to the extension. */
  const sendMessage = (message: QueuedMessage) => {
    generatingRef.current = true
    setIsLoading(true)
    clearSearchReport()
    clearToolSteps()

    const conversationId = conversation?.id || uuidv4()

    setMessages((prevMessages) => {
      const updatedMessages: ChatCompletionMessage[] = [
        ...(prevMessages || []),
        {
          role: USER,
          content: message.input,
          images: message.images.length > 0 ? message.images : undefined
        }
      ]

      const currentConversation = {
        id: conversationId,
        messages: updatedMessages,
        title: conversation?.title || t("chat-new-conversation-title")
      }

      saveLastConversation(currentConversation)
      setActiveConversation(currentConversation)

      emit(EVENT_NAME.twinnyChatMessage, {
        messages: updatedMessages,
        mentions: message.mentions,
        conversationId
      })

      return updatedMessages
    })
  }
  // The queue sends from an event handler; it always reaches this render's.
  const sendRef = useRef(sendMessage)
  sendRef.current = sendMessage

  /** Sends the composer's message, or queues it while a reply is running. */
  const handleSubmitForm = useCallback(() => {
    const html = editorRef.current?.getHTML() || ""
    const input = html
      .replace(/<p>/g, "")
      .replace(/<\/p>/g, "<br>")
      .replace(/<br>$/, "")

    const text = cheerio
      .load(input || "")
      .root()
      .text()
      .trim()

    if (!text || !input || chatDisabled) return

    const message: QueuedMessage = {
      id: uuidv4(),
      html,
      input,
      text,
      mentions: getMentions(),
      images: imagesRef.current
    }
    imagesRef.current = []
    clearEditor()
    rememberPrompt(html)

    if (generatingRef.current) {
      updateQueue([...queuedRef.current, message])
      return
    }
    sendRef.current(message)
  }, [chatDisabled])

  /*
   * A stopped reply is picked up by asking for the rest. The transcript
   * shows a short "Continue"; the model is told not to start over.
   */
  const handleContinue = useCallback(() => {
    if (generatingRef.current || chatDisabled) return
    generatingRef.current = true
    setIsLoading(true)
    clearSearchReport()
    clearToolSteps()
    setMessages((prev) => {
      const updatedMessages: ChatCompletionMessage[] = [
        ...(prev || []),
        {
          role: USER,
          content: t("reply-continue"),
          prompt:
            "Continue exactly where your last reply stopped. " +
            "Do not repeat anything you already wrote."
        }
      ]
      saveLastConversation({ ...conversation, messages: updatedMessages })
      emit(EVENT_NAME.twinnyChatMessage, {
        messages: updatedMessages,
        mentions: [],
        conversationId: conversation?.id
      })
      return updatedMessages
    })
  }, [conversation, chatDisabled, clearSearchReport, clearToolSteps, t])

  const handleOpenAsMarkdown = useCallback(() => {
    if (!messages.length) return
    emit(EVENT_NAME.twinnyNewDocument, {
      content: conversationMarkdown(conversation?.title, messages),
      language: "markdown"
    })
  }, [conversation?.title, messages])

  // The sidebar's title-bar menu asks; the panel has its own button.
  useServerEvent(EVENT_NAME.twinnyExportConversation, handleOpenAsMarkdown)

  const handleNewConversation = useCallback(() => {
    setActiveConversation({
      id: uuidv4(),
      title: t("chat-new-conversation-title"),
      messages: []
    })

    emit(EVENT_NAME.twinnyNewConversation)
  }, [setActiveConversation, t])

  // The composer's key map outlives a render, so it calls through a ref.
  const newConversationRef = useRef(handleNewConversation)
  newConversationRef.current = handleNewConversation

  const startNewConversation = useCallback(() => {
    stopIfGenerating()
    newConversationRef.current()
    return true
  }, [stopIfGenerating])

  useServerEvent(EVENT_NAME.twinnyShowShortcuts, () => setShortcuts(true))

  /*
   * The same keys with the focus on the transcript rather than the composer.
   * Anything typed there goes to the composer.
   */
  useEffect(() => {
    if (!active) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.altKey) return
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest(KEY_OWNERS)) return

      let handled = false
      if (e.ctrlKey) {
        if (e.shiftKey) return
        if (e.key === "c") {
          handled = handleInterrupt()
        } else if (e.key === "l") {
          handled = startNewConversation()
        }
      } else if (e.key === "Escape") {
        handled = handleEscape()
      } else if (e.key === "?") {
        handled = toggleShortcuts()
      } else if (e.key.length === 1 && e.key !== " " && !chatDisabled) {
        // Not handled: the key itself lands in the composer.
        if (!target?.closest("button, vscode-button, a, summary")) {
          editorRef.current?.commands.focus("end")
        }
      }
      if (handled) e.preventDefault()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [
    active,
    chatDisabled,
    handleEscape,
    handleInterrupt,
    startNewConversation,
    toggleShortcuts
  ])

  const handleOpenFile = useCallback((filePath: string) => {
    emit(EVENT_NAME.twinnyOpenFile, filePath)
  }, [])

  // Coming back to the chat hides the other tabs' back button and puts the
  // cursor in the composer, as opening it did when it was remounted.
  useEffect(() => {
    if (!active) return
    emit(EVENT_NAME.twinnyHideBackButton)
    editorRef.current?.commands.focus()
  }, [active])

  useEffect(() => {
    if (editorRef.current) emit(EVENT_NAME.twinnySidebarReady)
  }, [editorRef.current])

  useEffect(() => {
    editorRef.current?.commands.focus()
  }, [])

  // Switching conversation shows its messages, including none for a new one.
  useEffect(() => {
    if (conversation?.id) setMessages(conversation.messages || [])
  }, [conversation?.id])

  const { suggestion, filePaths } = useSuggestion()

  const memoizedSuggestion = useMemo(
    () => suggestion,
    [JSON.stringify(filePaths)]
  )

  const CustomImageExtension = createCustomImageExtension((id: string) => {
    imagesRef.current = imagesRef.current.filter((img) => img.id !== id)
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
          allowBase64: true
        }),
        CustomKeyMap.configure({
          handleSubmitForm,
          clearEditor,
          recallPrompt,
          escape: handleEscape,
          approve: approveWaiting,
          interrupt: handleInterrupt,
          newConversation: startNewConversation,
          toggleShortcuts,
          toggleAgentMode,
          scrollTranscript
        }),
        Placeholder.configure({
          placeholder: t("placeholder"),
          // Still shown while the composer is off for want of a provider.
          showOnlyWhenEditable: false
        })
      ],
      // Typing into a recalled prompt makes it the draft.
      onUpdate: () => {
        recallIndexRef.current = -1
        lastEscapeRef.current = 0
        if (showShortcutsRef.current) setShortcuts(false)
      }
    },
    [
      memoizedSuggestion,
      handleSubmitForm,
      clearEditor,
      recallPrompt,
      handleEscape,
      handleInterrupt,
      startNewConversation,
      t,
      imagesRef
    ]
  )

  useEffect(() => {
    editor?.setEditable(!chatDisabled)
  }, [editor, chatDisabled])

  const handleImageUpload = useCallback(
    (file: File) => {
      const reader = new FileReader()
      reader.onload = (e) => {
        const base64 = e.target?.result as string
        const imageData = base64.startsWith("data:")
          ? base64
          : `data:${file.type};base64,${base64.split(",").pop()}`
        const id = crypto.randomUUID()
        const newImage = { id, data: imageData, type: file.type }

        imagesRef.current = [...imagesRef.current, newImage]

        const { state } = editor?.view || {}

        if (state) {
          if (
            state.selection.empty &&
            state.selection.$head.pos === state.doc.content.size
          ) {
            editor?.chain().focus().createParagraphNear().run()
          }

          editor
            ?.chain()
            .focus()
            .insertContent({
              type: "image",
              attrs: { src: imageData, id }
            })
            .run()

          editor?.chain().focus().createParagraphNear().run()
        } else {
          editor
            ?.chain()
            .focus()
            .insertContent({
              type: "image",
              attrs: { src: imageData, id }
            })
            .run()
        }
      }
      reader.readAsDataURL(file)
    },
    [editor]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const files = Array.from(e.dataTransfer.files).filter((file) =>
        file.type.startsWith("image/")
      )
      files.forEach(handleImageUpload)
    },
    [handleImageUpload]
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLFormElement>) => {
      const items = Array.from(e.clipboardData?.items || [])
      const imageItem = items.find((item) => item.type.startsWith("image/"))

      if (imageItem) {
        e.preventDefault()
        const file = imageItem.getAsFile()
        if (file) handleImageUpload(file)
        return
      }
    },
    [handleImageUpload]
  )

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []).filter((file) =>
        file.type.startsWith("image/")
      )
      files.forEach(handleImageUpload)
      e.target.value = ""
    },
    [handleImageUpload]
  )

  const handleDeleteImage = (id: string) => {
    imagesRef.current = imagesRef.current.filter((img) => img.id !== id)
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

  useEffect(() => {
    if (composerHeight === null) {
      localStorage.removeItem(COMPOSER_HEIGHT_KEY)
      return
    }
    localStorage.setItem(COMPOSER_HEIGHT_KEY, String(composerHeight))
  }, [composerHeight])

  /*
   * Dragging the strip above the composer grows the typing area upwards,
   * so a long prompt can be written without the transcript being in the way.
   */
  const handleResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const wrap = editorWrapRef.current
      if (!wrap) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      resizeRef.current = {
        startY: e.clientY,
        startHeight: wrap.getBoundingClientRect().height
      }
    },
    []
  )

  const handleResizeMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const resize = resizeRef.current
      if (!resize) return
      const max = Math.max(COMPOSER_MIN_HEIGHT, window.innerHeight - 140)
      const height = resize.startHeight + (resize.startY - e.clientY)
      setComposerHeight(Math.min(max, Math.max(COMPOSER_MIN_HEIGHT, height)))
    },
    []
  )

  /* Anywhere in the box is fair game for a click: focus the editor at the end. */
  const handleComposerMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      if (target.closest("button, input, a, .ProseMirror")) return
      e.preventDefault()
      editorRef.current?.commands.focus("end")
    },
    []
  )

  const handleResizeEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!resizeRef.current) return
      resizeRef.current = null
      e.currentTarget.releasePointerCapture(e.pointerId)
    },
    []
  )

  const scrollToBottom = useCallback(() => {
    virtuosoRef.current?.scrollTo({
      top: Infinity,
      behavior: "auto"
    })
  }, [])

  const renderContextItem = useCallback(
    (item: AnyContextItem) => {
      let codicon = ""
      const displayName = item.name
      const title =
        "selectionRange" in item
          ? `${item.path} (lines ${item.selectionRange.startLine + 1}-${
              item.selectionRange.endLine + 1
            })`
          : item.path

      if (item.category === "files") {
        codicon = "codicon codicon-file-code"
      } else if (item.category === "selection") {
        codicon = "codicon codicon-symbol-snippet"
      }

      return (
        <div
          key={item.id}
          title={title}
          className={styles.contextItem}
          onClick={() => handleOpenFile(item.path)}
        >
          <span className={`${codicon} ${styles.contextItemIcon}`}></span>
          <span className={styles.contextItemName}>{displayName}</span>
          <span
            onClick={(e) => {
              e.stopPropagation()
              removeContextItem(item.id)
            }}
            data-id={item.id}
            className={cx("codicon codicon-close", styles.contextItemClose)}
          />
        </div>
      )
    },
    [handleOpenFile, removeContextItem]
  )

  const itemContent = useCallback(
    (index: number) => (
      <MessageItem
        key={`message-list-${index}`}
        completion={completion}
        context={searchReport}
        steps={toolSteps}
        generatingRef={generatingRef}
        handleDeleteImage={handleDeleteImage}
        handleDeleteMessage={handleDeleteMessage}
        handleEditMessage={handleEditMessage}
        handleRegenerateMessage={handleRegenerateMessage}
        handleContinue={handleContinue}
        index={index}
        isLoading={isLoading}
        message={messages[index]}
        messages={messages}
      />
    ),
    [
      handleDeleteMessage,
      handleEditMessage,
      handleRegenerateMessage,
      handleContinue,
      isLoading,
      messages,
      completion,
      searchReport,
      toolSteps,
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
            <VSCodeButton
              onClick={handleOpenAsMarkdown}
              appearance="icon"
              disabled={!messages.length}
              title={t("open-as-markdown")}
            >
              <i className="codicon codicon-markdown" />
            </VSCodeButton>
          </div>
        )}
        {!!contextItems.length && (
          <div className={styles.contextItems}>
            {contextItems.map(renderContextItem)}
          </div>
        )}
        <div className={styles.transcript}>
          {messages.length === 0 ? (
            <EmptyChat />
          ) : (
            <Virtuoso
              followOutput
              style={{ height: "100%" }}
              ref={virtuosoRef}
              data={messages}
              initialTopMostItemIndex={messages?.length}
              defaultItemHeight={800}
              itemContent={itemContent}
              atBottomThreshold={20}
              atBottomStateChange={(bottom) => setIsBottom(bottom)}
              alignToBottom
            />
          )}
        </div>
        {!!selection.length && (
          <Suggestions isDisabled={!!generatingRef.current || chatDisabled} />
        )}
        <div className={styles.chatOptions}>
          <div>
            {!isBottom && messages.length > 0 && (
              <VSCodeButton
                appearance="icon"
                onClick={scrollToBottom}
                title={t("scroll-to-bottom")}
              >
                <i className="codicon codicon-arrow-down" />
              </VSCodeButton>
            )}
          </div>
          {hint ? (
            <span className={styles.selectionCount}>{hint}</span>
          ) : (
            !!selection.length && (
              <span className={styles.selectionCount}>
                {t("selection-chars", { chars: selection.length })}
              </span>
            )
          )}
        </div>
        <div className={cx(styles.composer, { [styles.agentBusy]: agentMode && (isLoading || generatingRef.current) })}>
          {showShortcuts && <Shortcuts />}
          {!!queued.length && (
            <ol className={styles.queue} aria-label={t("queued-title")}>
              {queued.map((message) => (
                <li key={message.id} className={styles.queued}>
                  <span className={styles.queuedLabel}>{t("queued")}</span>
                  <span className={styles.queuedText} title={message.text}>
                    {message.text}
                  </span>
                  <button
                    type="button"
                    className={styles.queuedRemove}
                    onClick={() =>
                      updateQueue(queuedRef.current.filter((entry) => entry.id !== message.id))
                    }
                    title={t("queued-remove")}
                    aria-label={t("queued-remove")}
                  >
                    <i className="codicon codicon-close" />
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div
            role="separator"
            aria-orientation="horizontal"
            title={t("resize-composer")}
            className={styles.resizeHandle}
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
            onPointerCancel={handleResizeEnd}
            onDoubleClick={() => setComposerHeight(null)}
          >
            <span className={styles.resizeGrip} />
          </div>
          <form onDrop={handleDrop} onPaste={handlePaste}>
            <div
              className={cx(styles.chatBox, {
                [styles.chatBoxDisabled]: chatDisabled,
                [styles.agent]: agentMode
              })}
              title={chatDisabled ? t("chat-disabled-no-provider") : undefined}
              onMouseDown={handleComposerMouseDown}
            >
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept="image/*"
                multiple
                style={{ display: "none" }}
              />
              <span className={styles.prompt} aria-hidden="true">
                {agentMode ? <>&#10095;&#10095;</> : <>&#10095;</>}
              </span>
              <div
                ref={editorWrapRef}
                className={styles.editorWrap}
                style={
                  composerHeight === null
                    ? undefined
                    : { height: composerHeight, maxHeight: composerHeight }
                }
              >
                <EditorContent
                  className={styles.tiptap}
                  editor={editorRef.current}
                />
              </div>
              <div className={styles.modeSwitches}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={agentMode}
                  disabled={chatDisabled}
                  className={cx(styles.agentToggle, { [styles.agentToggleOn]: agentMode })}
                  onClick={toggleAgentMode}
                  title={t(agentMode ? "agent-mode-on-title" : "agent-mode-off-title")}
                >
                  <span className={styles.agentDot} aria-hidden="true" />
                  {t(agentMode ? "agent-mode-on" : "agent-mode")}
                </button>
                {agentMode && autoRunAvailable && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={autoRun}
                    disabled={chatDisabled}
                    className={cx(styles.agentToggle, { [styles.agentToggleOn]: autoRun })}
                    onClick={toggleAutoRun}
                    title={t(autoRun ? "auto-run-on-title" : "auto-run-off-title")}
                  >
                    <span className="codicon codicon-terminal" aria-hidden="true" />
                    {t("auto-run")}
                  </button>
                )}
              </div>
              <div className={styles.chatButtons}>
                <VSCodeButton
                  appearance="icon"
                  role="button"
                  disabled={chatDisabled}
                  onClick={handleFileSelect}
                  title={t("upload-image")}
                >
                  <span className="codicon codicon-device-camera" />
                </VSCodeButton>
                {generatingRef.current ? (
                  <VSCodeButton
                    appearance="icon"
                    role="button"
                    className={styles.stopButton}
                    onClick={handleStopGeneration}
                    title={t("stop-generation-esc")}
                    aria-label={t("stop-generation")}
                  >
                    <span className="codicon codicon-debug-stop"></span>
                  </VSCodeButton>
                ) : (
                  <VSCodeButton
                    appearance="icon"
                    role="button"
                    disabled={chatDisabled}
                    onClick={handleSubmitForm}
                    title={t("send")}
                  >
                    <span className="codicon codicon-send"></span>
                  </VSCodeButton>
                )}
              </div>
            </div>
          </form>
          <div className={styles.footer}>
            <ProviderSelect />
            <button
              type="button"
              className={styles.shortcutsHint}
              onClick={toggleShortcuts}
              aria-expanded={showShortcuts}
              title={t("shortcuts-hint")}
            >
              <span className={styles.shortcutsHintText}>{t("shortcuts-hint")}</span>
              <span className={styles.shortcutsHintKey}>?</span>
            </button>
          </div>
        </div>
      </div>
    </VSCodePanelView>
  )
}

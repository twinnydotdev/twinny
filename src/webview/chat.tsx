import { useEffect, useRef, useState } from 'react'

import {
  VSCodeButton,
  VSCodePanelView,
  VSCodeProgressRing,
  VSCodeBadge
} from '@vscode/webview-ui-toolkit/react'

import {
  ASSISTANT,
  WORKSPACE_STORAGE_KEY,
  EVENT_NAME,
  USER
} from '../common/constants'

import useAutosizeTextArea, {
  useConversationHistory,
  useSelection,
  useTheme,
  useWorkSpaceContext
} from './hooks'
import { DisabledAutoScrollIcon, EnabledAutoScrollIcon } from './icons'

import { Suggestions } from './suggestions'
import {
  ClientMessage,
  Message as MessageType,
  ServerMessage
} from '../common/types'
import { Message } from './message'
import { getCompletionContent } from './utils'
import styles from './index.module.css'
import { ProviderSelect } from './provider-select'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const Chat = () => {
  const [inputText, setInputText] = useState('')
  const generatingRef = useRef(false)
  const stopRef = useRef(false)
  const theme = useTheme()
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState<MessageType[] | undefined>()
  const [completion, setCompletion] = useState<MessageType | null>()
  const markdownRef = useRef<HTMLDivElement>(null)
  const autoScrollContext = useWorkSpaceContext<boolean>(
    WORKSPACE_STORAGE_KEY.autoScroll
  )
  const showProvidersContext = useWorkSpaceContext<boolean>(
    WORKSPACE_STORAGE_KEY.showProviders
  )
  const [showProviders, setShowProviders] = useState<boolean | undefined>(
    showProvidersContext || false
  )
  const [isAutoScrolledEnabled, setIsAutoScrolledEnabled] = useState<
    boolean | undefined
  >(autoScrollContext)
  const { conversation, saveLastConversation, setActiveConversation } =
    useConversationHistory()

  const chatRef = useRef<HTMLTextAreaElement>(null)
  useAutosizeTextArea(chatRef, inputText)

  const scrollBottom = () => {
    if (!isAutoScrolledEnabled) return
    setTimeout(() => {
      if (markdownRef.current) {
        markdownRef.current.scrollTop = markdownRef.current.scrollHeight
      }
    }, 200)
  }

  const selection = useSelection(scrollBottom)

  const handleCompletionEnd = (message: ServerMessage) => {
    if (message.value) {
      setMessages((prev) => {
        const messages = [
          ...(prev || []),
          {
            role: ASSISTANT,
            content: getCompletionContent(message)
          }
        ]
        saveLastConversation({
          ...conversation,
          messages: messages
        })
        return messages
      })
      setTimeout(() => {
        chatRef.current?.focus()
        stopRef.current = false
      }, 200)
    }
    setCompletion(null)
    setLoading(false)
    generatingRef.current = false
  }

  const handleAddTemplateMessage = (message: ServerMessage) => {
    if (stopRef.current) {
      generatingRef.current = false
      return
    }
    generatingRef.current = true
    setLoading(false)
    if (isAutoScrolledEnabled) scrollBottom()
    setMessages((prev) => [
      ...(prev || []),
      {
        role: USER,
        content: message.value.completion as string
      }
    ])
  }

  const handleCompletionMessage = (message: ServerMessage) => {
    if (stopRef.current) {
      generatingRef.current = false
      return
    }
    generatingRef.current = true
    setLoading(false)
    setCompletion({
      role: ASSISTANT,
      content: getCompletionContent(message),
      type: message.value.type,
      language: message.value.data,
      error: message.value.error
    })
    if (isAutoScrolledEnabled) scrollBottom()
  }

  const handleLoadingMessage = () => {
    setLoading(true)
    if (isAutoScrolledEnabled) scrollBottom()
  }

  const messageEventHandler = (event: MessageEvent) => {
    const message: ServerMessage = event.data
    switch (message.type) {
      case EVENT_NAME.twinngAddMessage: {
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
        setLoading(false)
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
    generatingRef.current = false
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyStopGeneration
    } as ClientMessage)
    setCompletion(null)
    setLoading(false)
    setMessages([])
    generatingRef.current = false
    setTimeout(() => {
      chatRef.current?.focus()
      stopRef.current = false
    }, 200)
  }

  const handleSubmitForm = (input: string) => {
    if (input) {
      setLoading(true)
      setInputText('')
      global.vscode.postMessage({
        type: EVENT_NAME.twinnyChatMessage,
        data: [
          ...(messages || []),
          {
            role: USER,
            content: input
          }
        ]
      } as ClientMessage)
      setMessages((prev) => [...(prev || []), { role: USER, content: input }])
      if (isAutoScrolledEnabled) scrollBottom()
    }
  }

  const handleToggleAutoScroll = () => {
    setIsAutoScrolledEnabled((prev) => {
      global.vscode.postMessage({
        type: EVENT_NAME.twinnySetWorkspaceContext,
        key: WORKSPACE_STORAGE_KEY.autoScroll,
        data: !prev
      } as ClientMessage)

      if (!prev) scrollBottom()

      return !prev
    })
  }

  const handleToggleProviderSelection = () => {
    setShowProviders((prev) => {
      global.vscode.postMessage({
        type: EVENT_NAME.twinnySetWorkspaceContext,
        key: WORKSPACE_STORAGE_KEY.showProviders,
        data: !prev
      } as ClientMessage)
      return !prev
    })
  }

  const handleGetGitChanges = () => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyGetGitChanges
    } as ClientMessage)
  }

  const handleScrollBottom = () => {
    if (markdownRef.current) {
      markdownRef.current.scrollTop = markdownRef.current.scrollHeight
    }
  }

  useEffect(() => {
    window.addEventListener('message', messageEventHandler)
    chatRef.current?.focus()
    scrollBottom()
    return () => {
      window.removeEventListener('message', messageEventHandler)
    }
  }, [isAutoScrolledEnabled])

  useEffect(() => {
    if (autoScrollContext !== undefined)
      setIsAutoScrolledEnabled(autoScrollContext)

    if (showProvidersContext !== undefined)
      setShowProviders(showProvidersContext)

    if (conversation?.messages?.length) {
      return setMessages(conversation.messages)
    }
  }, [conversation?.id, autoScrollContext, showProvidersContext])

  return (
    <VSCodePanelView>
      <div className={styles.container}>
        <h4 className={styles.title}>
          {conversation?.title
            ? conversation?.title
            : generatingRef.current && <span>New conversation</span>}
        </h4>
        <div className={styles.markdown} ref={markdownRef}>
          {messages?.map((message) => (
            <Message message={message} theme={theme} />
          ))}
          {loading && (
            <div className={styles.loading}>
              <VSCodeProgressRing aria-label="Loading"></VSCodeProgressRing>
            </div>
          )}
          {!!completion && (
            <Message
              theme={theme}
              message={{
                ...completion,
                role: ASSISTANT
              }}
            />
          )}
        </div>
        {!!selection.length && (
          <Suggestions isDisabled={!!generatingRef.current} />
        )}
        {showProviders && <ProviderSelect />}
        <div className={styles.chatOptions}>
          <div>
            <VSCodeButton
              onClick={handleToggleAutoScroll}
              title="Toggle auto scroll on/off"
              appearance="icon"
            >
              {isAutoScrolledEnabled ? (
                <EnabledAutoScrollIcon />
              ) : (
                <DisabledAutoScrollIcon />
              )}
            </VSCodeButton>
            <VSCodeButton
              onClick={handleGetGitChanges}
              title="Generate commit message from staged changes"
              appearance="icon"
            >
              <span className="codicon codicon-git-pull-request"></span>
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
            {generatingRef.current && (
              <VSCodeButton
                type="button"
                appearance="icon"
                onClick={handleStopGeneration}
                aria-label="Stop generation"
              >
                <span className="codicon codicon-debug-stop"></span>
              </VSCodeButton>
            )}
            <VSCodeButton
              title="Select active providers"
              appearance="icon"
              onClick={handleToggleProviderSelection}
            >
              <span className={styles.textIcon}>🤖</span>
            </VSCodeButton>
          </div>
        </div>
        <form>
          <div className={styles.chatBox}>
            <textarea
              ref={chatRef}
              disabled={generatingRef.current}
              placeholder="Message twinny"
              rows={1}
              value={inputText}
              className={styles.chatInput}
              onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                const target = e.target as HTMLTextAreaElement
                if (e.key === 'Enter' && !e.ctrlKey) {
                  e.preventDefault()

                  handleSubmitForm(target.value)
                } else if (e.ctrlKey && e.key === 'Enter') {
                  setInputText(`${target.value}\n`)
                }
              }}
              onChange={(e) => {
                const event =
                  e as unknown as React.ChangeEvent<HTMLTextAreaElement>
                setInputText(event.target.value)
              }}
            />
            <div
              role="button"
              onClick={() => handleSubmitForm(inputText)}
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

import { useEffect, useRef, useState } from 'react'

import {
  VSCodeButton,
  VSCodeTextArea,
  VSCodePanelView,
  VSCodeProgressRing,
  VSCodeBadge
} from '@vscode/webview-ui-toolkit/react'

import { Selection } from './selection'
import {
  BOT_NAME,
  MESSAGE_KEY,
  MESSAGE_NAME,
  SETTING_KEY,
  USER_NAME
} from '../common/constants'

import {
  useConfigurationSetting,
  useLanguage,
  useSelection,
  useTheme,
  useWorkSpaceContext
} from './hooks'
import {
  DisabledAutoScrollIcon,
  EnabledAutoScrollIcon,
  DisabledSelectionIcon,
  EnabledSelectionIcon,
  ScrollDownIcon
} from './icons'

import { Suggestions } from './suggestions'
import {
  ApiProviders,
  ClientMessage,
  MessageType,
  ServerMessage
} from '../common/types'
import { Message } from './message'
import { getCompletionContent } from './utils'
import { ModelSelect } from './model-select'
import styles from './index.module.css'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const Chat = () => {
  const [inputText, setInputText] = useState('')
  const [isSelectionVisible, setIsSelectionVisible] = useState<boolean>(false)
  const generatingRef = useRef(false)
  const stopRef = useRef(false)
  const theme = useTheme()
  const language = useLanguage()
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState<MessageType[] | undefined>()
  const [completion, setCompletion] = useState<MessageType | null>()
  const [showModelSelect, setShowModelSelect] = useState<boolean>(false)
  const { configurationSetting: apiProvider } = useConfigurationSetting(
    SETTING_KEY.apiProvider
  )

  const markdownRef = useRef<HTMLDivElement>(null)
  const autoScrollContext = useWorkSpaceContext<boolean>(MESSAGE_KEY.autoScroll)
  const [isAutoScrolledEnabled, setIsAutoScrolledEnabled] = useState<
    boolean | undefined
  >(autoScrollContext)
  const lastConversation = useWorkSpaceContext<MessageType[]>(
    MESSAGE_KEY.lastConversation
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chatRef = useRef<any>(null) // TODO: type...

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
    setMessages((prev) => {
      const update = [
        ...(prev || []),
        {
          role: BOT_NAME,
          content: getCompletionContent(message),
        }
      ]
      global.vscode.postMessage({
        type: MESSAGE_NAME.twinnySetWorkspaceContext,
        key: MESSAGE_KEY.lastConversation,
        data: update
      } as ClientMessage<MessageType[]>)
      return update
    })
    setCompletion(null)
    setLoading(false)
    generatingRef.current = false
    setTimeout(() => {
      chatRef.current?.focus()
      stopRef.current = false
    }, 200)
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
        role: USER_NAME,
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
      role: BOT_NAME,
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
      case MESSAGE_NAME.twinngAddMessage: {
        handleAddTemplateMessage(message)
        break
      }
      case MESSAGE_NAME.twinnyOnCompletion: {
        handleCompletionMessage(message)
        break
      }
      case MESSAGE_NAME.twinnyOnLoading: {
        handleLoadingMessage()
        break
      }
      case MESSAGE_NAME.twinnyOnEnd: {
        handleCompletionEnd(message)
        break
      }
      case MESSAGE_NAME.twinnyStopGeneration: {
        setCompletion(null)
        generatingRef.current = false
        chatRef.current?.focus()
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
      type: MESSAGE_NAME.twinnyStopGeneration
    } as ClientMessage)
  }

  const handleSubmitForm = (input: string) => {
    if (input) {
      setLoading(true)
      setInputText('')
      global.vscode.postMessage({
        type: MESSAGE_NAME.twinnyChatMessage,
        data: [
          ...(messages || []),
          {
            role: USER_NAME,
            content: input,
           }
        ]
      } as ClientMessage)
      setMessages((prev) => [
        ...(prev || []),
        { role: USER_NAME, content: input, type: '' }
      ])
      if (isAutoScrolledEnabled) scrollBottom()
    }
  }

  const togggleAutoScroll = () => {
    setIsAutoScrolledEnabled((prev) => {
      global.vscode.postMessage({
        type: MESSAGE_NAME.twinnySetWorkspaceContext,
        key: MESSAGE_KEY.autoScroll,
        data: !prev
      } as ClientMessage)

      if (!prev) scrollBottom()

      return !prev
    })
  }

  const handleScrollBottom = () => {
    if (markdownRef.current) {
      markdownRef.current.scrollTop = markdownRef.current.scrollHeight
    }
  }

  const handleToggleSelection = () => {
    setIsSelectionVisible((prev) => !prev)
  }

  const handleToggleModelSelection = () => {
    setShowModelSelect((prev) => !prev)
  }

  useEffect(() => {
    window.addEventListener('message', messageEventHandler)
    chatRef.current?.focus()
    return () => {
      window.removeEventListener('message', messageEventHandler)
    }
  }, [isAutoScrolledEnabled])

  useEffect(() => {
    if (autoScrollContext !== undefined)
      setIsAutoScrolledEnabled(autoScrollContext)

    if (lastConversation?.length) {
      return setMessages(lastConversation)
    }
    setMessages([])
  }, [lastConversation, autoScrollContext])

  return (
    <VSCodePanelView>
      <div className={styles.container}>
        <div className={styles.markdown} ref={markdownRef}>
          {messages?.map((message, index) => (
            <div key={`message-${index}`}>
              <Message message={message} theme={theme} />
            </div>
          ))}
          {loading && (
            <div className={styles.loading}>
              <VSCodeProgressRing aria-label="Loading"></VSCodeProgressRing>
            </div>
          )}
          {!!completion && (
            <>
              <Message
                theme={theme}
                message={{
                  ...completion,
                  role: BOT_NAME
                }}
              />
            </>
          )}
        </div>
        {!!selection.length && (
          <Suggestions isDisabled={!!generatingRef.current} />
        )}
        <Selection
          isVisible={isSelectionVisible}
          onSelect={scrollBottom}
          language={language}
        />
        {showModelSelect && <ModelSelect />}
        <div className={styles.chatOptions}>
          <div>
            <VSCodeButton
              onClick={togggleAutoScroll}
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
              title="Scroll down to the bottom"
              appearance="icon"
              onClick={handleScrollBottom}
            >
              <ScrollDownIcon/>
            </VSCodeButton>
            <VSCodeButton
              title="Toggle selection preview"
              appearance="icon"
              onClick={handleToggleSelection}
            >
              {isSelectionVisible ? (
                <EnabledSelectionIcon />
              ) : (
                <DisabledSelectionIcon />
              )}
            </VSCodeButton>
            <VSCodeBadge>{selection?.length}</VSCodeBadge>
          </div>
          {apiProvider === ApiProviders.Ollama && (
            <VSCodeButton
              title="Select active models"
              appearance="icon"
              onClick={handleToggleModelSelection}
            >
              <span className={styles.textIcon}>🤖</span>
            </VSCodeButton>
          )}
        </div>
        <form>
          <div className={styles.chatBox}>
            <VSCodeTextArea
              ref={chatRef}
              disabled={generatingRef.current}
              placeholder="Message twinny"
              value={inputText}
              className={styles.chatInput}
              rows={4}
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
          </div>
          <div className={styles.send}>
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
              disabled={generatingRef.current}
              onClick={() => handleSubmitForm(inputText)}
              appearance="primary"
            >
              Send message
            </VSCodeButton>
          </div>
        </form>
      </div>
    </VSCodePanelView>
  )
}

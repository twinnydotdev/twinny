import { useEffect, useRef, useState } from 'react'

import {
  VSCodeButton,
  VSCodeTextArea,
  VSCodePanelView,
  VSCodeProgressRing,
  VSCodeBadge
} from '@vscode/webview-ui-toolkit/react'

import { Selection } from './selection'
import { BOT_NAME, MESSAGE_KEY, MESSAGE_NAME, USER_NAME } from '../constants'

import {
  useLanguage,
  useSelection,
  useTheme,
  useWorkSpaceContext
} from './hooks'
import {
  CodeIcon,
  DisabledAutoScrollIcon,
  EnabledAutoScrollIcon,
  StopIcon
} from './icons'

import { Suggestions } from './suggestions'
import { ClientMessage, MessageType, ServerMessage } from '../extension/types'
import { Message } from './message'
import { getCompletionContent } from './utils'
import styles from './index.module.css'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const Chat = () => {
  const [inputText, setInputText] = useState('')
  const [isSelectionVisible, setIsSelectionVisible] = useState<boolean>(false)
  const genertingRef = useRef(false)
  const stopRef = useRef(false)
  const theme = useTheme()
  const language = useLanguage()
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState<MessageType[] | undefined>()
  const [completion, setCompletion] = useState<MessageType | null>()
  const divRef = useRef<HTMLDivElement>(null)
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
    setTimeout(() => {
      if (divRef.current) {
        divRef.current.scrollTop = divRef.current.scrollHeight
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
          type: message.value.type,
          language: message.value.data
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
    genertingRef.current = false
    setTimeout(() => {
      chatRef.current?.focus()
      stopRef.current = false
    }, 1000)
  }

  const handleCompletionMessage = (message: ServerMessage) => {
    if (stopRef.current) {
      genertingRef.current = false
      return
    }
    genertingRef.current = true
    setLoading(false)
    if (isAutoScrolledEnabled) scrollBottom()
    setCompletion({
      role: BOT_NAME,
      content: getCompletionContent(message),
      type: message.value.type,
      language: message.value.data,
      error: message.value.error
    })
  }

  const handleLoadingMessage = () => {
    setLoading(true)
    if (isAutoScrolledEnabled) scrollBottom()
  }

  const messageEventHandler = (event: MessageEvent) => {
    const message: ServerMessage = event.data
    switch (message.type) {
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
        genertingRef.current = false
        chatRef.current?.focus()
        setTimeout(() => {
          stopRef.current = false
        }, 1000)
      }
    }
  }

  const handleStopGeneration = () => {
    stopRef.current = true
    genertingRef.current = false
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyStopGeneration
    } as ClientMessage)
    handleCompletionEnd({
      type: MESSAGE_KEY.chatMessage,
      value: {
        completion: completion?.content || '',
        type: MESSAGE_KEY.chatMessage
      }
    })
  }

  const handleSubmitForm = (input: string) => {
    if (input) {
      setInputText('')
      global.vscode.postMessage({
        type: MESSAGE_NAME.twinnyChatMessage,
        data: [
          ...(messages || []),
          {
            role: USER_NAME,
            content: input
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

  const handleToggleSelection = () => {
    setIsSelectionVisible((prev) => !prev)
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
        <div className={styles.markdown} ref={divRef}>
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
          <Suggestions isDisabled={!!genertingRef.current} />
        )}
        <Selection
          isVisible={isSelectionVisible}
          onSelect={scrollBottom}
          language={language}
        />
        <div className={styles.chatOptions}>
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
            title="Toggle selection preview"
            appearance="icon"
            onClick={handleToggleSelection}
          >
            <CodeIcon />
          </VSCodeButton>
          <VSCodeBadge>Selected characters: {selection?.length}</VSCodeBadge>
        </div>
        <form>
          <div className={styles.chatBox}>
            <VSCodeTextArea
              ref={chatRef}
              disabled={genertingRef.current}
              placeholder="Message twinny"
              rows={5}
              value={inputText}
              onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                if (e.ctrlKey && e.key === 'Enter') {
                  const target = e.target as HTMLTextAreaElement
                  handleSubmitForm(target.value)
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
            {genertingRef.current && (
              <VSCodeButton
                type="button"
                appearance="icon"
                onClick={handleStopGeneration}
                aria-label="Stop generation"
              >
                <StopIcon />
              </VSCodeButton>
            )}
            <VSCodeButton
              disabled={genertingRef.current}
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

import { useEffect, useRef, useState } from 'react'

import {
  VSCodeButton,
  VSCodeTextArea,
  VSCodePanelView,
  VSCodeProgressRing
} from '@vscode/webview-ui-toolkit/react'

import { Selection } from './selection'
import {
  BOT_NAME,
  EMPTY_MESAGE,
  MESSAGE_KEY,
  MESSAGE_NAME,
  USER_NAME
} from '../constants'

import { useLanguage, useSelection, useTheme, useWorkSpaceContext } from './hooks'
import { StopIcon } from './icons'

import styles from './index.module.css'
import { Suggestions } from './suggestions'
import { ClientMessage, Messages, ServerMessage } from '../types'
import { Message } from './message'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const Chat = () => {
  const [inputText, setInputText] = useState('')
  const genertingRef = useRef(false)
  const stopRef = useRef(false)
  const theme = useTheme()
  const language = useLanguage()
  const [loading, setLoading] = useState(false)
  const lastConversation =
    useWorkSpaceContext<Messages[]>(MESSAGE_KEY.lastConversation)
  const [messages, setMessages] = useState<Messages[] | undefined>()
  const [completion, setCompletion] = useState<Messages | null>()
  const divRef = useRef<HTMLDivElement>(null)
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
          content: message.value.completion || EMPTY_MESAGE,
          type: message.value.type,
          language: message.value.data
        }
      ]
      global.vscode.postMessage({
        type: MESSAGE_NAME.twinnySetWorkspaceContext,
        key: MESSAGE_KEY.lastConversation,
        messages: update
      } as ClientMessage)
      return update
    })
    setCompletion(null)
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
    setCompletion({
      role: BOT_NAME,
      content: message.value.completion || EMPTY_MESAGE,
      type: message.value.type,
      language: message.value.data
    })
    scrollBottom()
  }

  const handleLoadingMessage = () => {
    setLoading(true)
    scrollBottom()
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
        messages: [
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
      scrollBottom()
    }
  }

  useEffect(() => {
    window.addEventListener('message', messageEventHandler)
    chatRef.current?.focus()
    return () => {
      window.removeEventListener('message', messageEventHandler)
    }
  }, [])

  useEffect(() => {
    if (lastConversation?.length) {
      return setMessages(lastConversation)
    }
    setMessages([])
  }, [lastConversation])

  return (
    <VSCodePanelView>
      <div className={styles.container}>
        <div className={styles.markdown} ref={divRef}>
          {messages?.map((message, index) => (
            <div key={`message-${index}`}>
              <Message
                completionType={message.type || ''}
                sender={message.role}
                message={message.content}
                language={message.language}
                theme={theme}
              />
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
                completionType={completion.type || ''}
                sender={BOT_NAME}
                message={completion.content}
                language={completion.language}
                theme={theme}
              />
            </>
          )}
        </div>
        {!!selection.length && (
          <Suggestions isDisabled={!!genertingRef.current} />
        )}
        <form>
          <Selection onSelect={scrollBottom} language={language} />
          <div className={styles.chatbox}>
            <VSCodeTextArea
              ref={chatRef}
              disabled={genertingRef.current}
              placeholder="Message twinny"
              rows={5}
              value={inputText}
              onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                if (e.ctrlKey && e.key === 'Enter') {
                  const target = e.target as HTMLTextAreaElement;
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

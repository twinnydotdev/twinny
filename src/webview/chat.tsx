import { useEffect, useRef, useState } from 'react'

import {
  VSCodeButton,
  VSCodeTextArea,
  VSCodePanelView,
  VSCodeProgressRing
} from '@vscode/webview-ui-toolkit/react'

import { Message } from './message'
import { Selection } from './selection'
import {
  BOT_NAME,
  EMPTY_MESAGE,
  MESSAGE_KEY,
  MESSAGE_NAME,
  USER_NAME
} from '../constants'

import { useLanguage, useSelection, useWorkSpaceContext } from './hooks'
import { StopIcon } from './icons'

import styles from './index.module.css'
import { Suggestions } from './suggestions'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const Chat = () => {
  const [inputText, setInputText] = useState('')
  const genertingRef = useRef(false)
  const stopRef = useRef(false)
  const [loading, setLoading] = useState(false)
  const lastConversation = useWorkSpaceContext<Message[]>('lastConversation')
  const [messages, setMessages] = useState<Message[] | undefined>()
  const [completion, setCompletion] = useState<Message | null>()
  const divRef = useRef<HTMLDivElement>(null)
  const language = useLanguage()

  const scrollBottom = () => {
    setTimeout(() => {
      if (divRef.current) {
        divRef.current.scrollTop = divRef.current.scrollHeight
      }
    }, 200)
  }

  const selection = useSelection(scrollBottom)

  const handleSubmitForm = (e: React.FormEvent | React.KeyboardEvent) => {
    e.preventDefault()
    const input = inputText.trim()
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
      })
      setMessages((prev) => [
        ...(prev || []),
        { role: USER_NAME, content: input, type: '' }
      ])
      scrollBottom()
    }
  }

  const handleCompletionEnd = (message: PostMessage) => {
    setMessages((prev) => {
      const update = [
        ...(prev || []),
        {
          role: BOT_NAME,
          content: message.value.completion || EMPTY_MESAGE,
          type: message.value.type
        }
      ]
      global.vscode.postMessage({
        type: MESSAGE_NAME.twinnySetWorkspaceContext,
        key: MESSAGE_KEY.lastConversation,
        data: update
      })
      return update
    })
    setCompletion(null)
    genertingRef.current = false
    setTimeout(() => {
      stopRef.current = false
    }, 1000)
  }

  const handleCompletionMessage = (message: PostMessage) => {
    if (stopRef.current) {
      genertingRef.current = false
      return
    }
    genertingRef.current = true
    setLoading(false)
    setCompletion({
      role: BOT_NAME,
      content: message.value.completion || EMPTY_MESAGE,
      type: message.value.type
    })
    scrollBottom()
  }

  const handleLoadingMessage = () => {
    setLoading(true)
    scrollBottom()
  }

  const messageEventHandler = (event: MessageEvent) => {
    const message: PostMessage = event.data
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
      }
    }
  }

  const handleStopGeneration = () => {
    stopRef.current = true
    genertingRef.current = false
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyStopGeneration
    })
    handleCompletionEnd({
      type: MESSAGE_KEY.chatMessage,
      value: {
        completion: completion?.content || '',
        type: MESSAGE_KEY.chatMessage
      }
    })
  }

  useEffect(() => {
    window.addEventListener('message', messageEventHandler)
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
                language={language}
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
                language={language}
              />
            </>
          )}
        </div>
        {!!selection.length && (
          <Suggestions isDisabled={!!genertingRef.current} />
        )}
        <form onSubmit={handleSubmitForm}>
          <Selection onSelect={scrollBottom} />
          <div className={styles.chatbox}>
            <VSCodeTextArea
              disabled={genertingRef.current}
              placeholder="Message twinny"
              rows={5}
              value={inputText}
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
              type="submit"
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

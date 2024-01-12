import { useEffect, useRef, useState } from 'react'

import {
  VSCodeButton,
  VSCodeTextArea,
  VSCodePanelView,
  VSCodeProgressRing
} from '@vscode/webview-ui-toolkit/react'

import { Message } from './message'
import { Selection } from './selection'
import { BOT_NAME, StopIcon, USER_NAME } from './constants'

import styles from './index.module.css'
import { useWorkSpaceContext } from './hooks'

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

  const scrollBottom = () => {
    setTimeout(() => {
      if (divRef.current) {
        divRef.current.scrollTop = divRef.current.scrollHeight
      }
    }, 200)
  }

  const handleSendMessage = (e: React.FormEvent | React.KeyboardEvent) => {
    e.preventDefault()
    if (inputText.trim()) {
      setInputText('')
      global.vscode.postMessage({
        type: 'chatMessage',
        data: messages?.length
          ? [
              ...messages,
              {
                role: 'user',
                content: inputText.trim(),
                type: ''
              }
            ]
          : [
              {
                role: 'user',
                content: inputText.trim(),
                type: ''
              }
            ]
      })
      setMessages((prev) => [
        ...(prev || []),
        { role: USER_NAME, content: inputText, type: '' }
      ])
      scrollBottom()
    }
  }

  const messageEnd = (message: PostMessage) => {
    genertingRef.current = false
    setMessages((prev) => {
      const update = [
        ...(prev || []),
        {
          role: BOT_NAME,
          content: message.value.completion,
          type: message.value.type
        }
      ]
      global.vscode.postMessage({
        type: 'setTwinnyWorkSpaceContext',
        key: 'lastConversation',
        data: update
      })
      return update
    })
  }

  const messageHandler = (event: MessageEvent) => {
    const message: PostMessage = event.data
    switch (message.type) {
      case 'onCompletion': {
        if (stopRef.current) {
          genertingRef.current = false
          return
        }
        genertingRef.current = true
        setLoading(false)
        setCompletion({
          role: BOT_NAME,
          content: message.value.completion,
          type: message.value.type
        })
        scrollBottom()
        break
      }
      case 'onLoading': {
        setLoading(true)
        break
      }
      case 'onEnd': {
        messageEnd(message)
      }
    }
  }

  const handleStopGeneration = () => {
    stopRef.current = true
    genertingRef.current = false
    global.vscode.postMessage({
      type: 'twinnyStopGeneration'
    })
    setMessages((prev) => {
      const update = [
        ...(prev || []),
        {
          role: BOT_NAME,
          content: completion?.content || '',
          type: 'chatMessage'
        }
      ]
      global.vscode.postMessage({
        type: 'setTwinnyWorkSpaceContext',
        key: 'lastConversation',
        data: update
      })
      return update
    })
    setCompletion(null)
    setTimeout(() => {
      stopRef.current = false
    }, 1000)
  }

  useEffect(() => {
    window.addEventListener('message', messageHandler)
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
                completionType={message.type}
                sender={message.role}
                message={message.content}
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
                completionType={completion.type}
                sender={BOT_NAME}
                message={completion.content}
              />
            </>
          )}
        </div>
        <form onSubmit={handleSendMessage}>
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

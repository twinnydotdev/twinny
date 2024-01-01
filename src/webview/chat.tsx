import { useEffect, useRef, useState } from 'react'

import {
  VSCodeButton,
  VSCodeTextArea,
  VSCodePanelView,
  VSCodeProgressRing
} from '@vscode/webview-ui-toolkit/react'

import styles from './index.module.css'
import { Message } from './message'
import { BOT_NAME, USER_NAME } from './const'

interface PostMessage {
  type: string
  value: string
}

const vscode = window.acquireVsCodeApi()

interface Message {
  role: string
  content: string
}

export const Chat = () => {
  const [inputText, setInputText] = useState('')
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [completion, setCompletion] = useState<string>()
  const divRef = useRef<HTMLDivElement>(null)

  const handleSendMessage = (e: React.FormEvent | React.KeyboardEvent) => {
    e.preventDefault()

    if (inputText.trim()) {
      setInputText('')

      vscode.postMessage({
        type: 'chatMessage',
        data: messages.length
          ? [
              ...messages,
              {
                role: 'user',
                content: inputText.trim()
              }
            ]
          : [
              {
                role: 'user',
                content: inputText.trim()
              }
            ]
      })

      setMessages((prev) => [...prev, { role: USER_NAME, content: inputText }])
    }
  }

  useEffect(() => {
    window.addEventListener('message', (event) => {
      const message: PostMessage = event.data
      switch (message.type) {
        case 'onCompletion': {
          setLoading(false)
          setCompletion(message.value)
          setTimeout(() => {
            if (divRef.current) {
              divRef.current.scrollTop = divRef.current.scrollHeight
            }
          }, 200)
          break
        }
        case 'onLoading': {
          setLoading(true)
          break
        }
        case 'onEnd': {
          setMessages((prev) => {
            return [
              ...prev,
              {
                role: BOT_NAME,
                content: message.value
              }
            ]
          })
          setCompletion('')
        }
      }
    })
  }, [])

  return (
    <VSCodePanelView>
      <div className={styles.container}>
        <div className={styles.markdown} ref={divRef}>
          {messages.map((message) => (
            <Message sender={message.role} message={message.content} />
          ))}
          {loading && (
            <div className={styles.loading}>
              <VSCodeProgressRing aria-label='Loading'></VSCodeProgressRing>
            </div>
          )}
          {!!completion && (
            <>
              <Message sender={BOT_NAME} message={completion} />
            </>
          )}
        </div>
        <form onSubmit={handleSendMessage}>
          <div className={styles.chatbox}>
            <VSCodeTextArea
              value={inputText}
              onChange={(e) => {
                const event =
                  e as unknown as React.ChangeEvent<HTMLTextAreaElement>
                setInputText(event.target.value)
              }}
            />
          </div>
          <div className={styles.send}>
            <VSCodeButton type='submit' appearance='primary'>
              Send message
            </VSCodeButton>
          </div>
        </form>
      </div>
    </VSCodePanelView>
  )
}

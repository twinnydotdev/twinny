import { useEffect, useRef, useState } from 'react'

import {
  VSCodeButton,
  VSCodeTextArea,
  VSCodePanelView
} from '@vscode/webview-ui-toolkit/react'

import styles from './index.module.css'
import { Message } from './message'
import { BOT_NAME, USER_NAME, WELCOME_MESSAGE } from './const'

interface PostMessage {
  type: string
  value: string
}

const vscode = window.acquireVsCodeApi()

interface Message {
  sender: string
  message: string
}

const MESSAGE_WINDOW = 2

export const Chat = () => {
  const [inputText, setInputText] = useState('')
  const [messages, setMessages] = useState<Message[]>([
    {
      sender: BOT_NAME,
      message: WELCOME_MESSAGE
    }
  ])
  const [completion, setCompletion] = useState<string>()
  const divRef = useRef<HTMLDivElement>(null)

  const handleSendMessage = (e: React.FormEvent | React.KeyboardEvent) => {
    e.preventDefault()

    const lastTwoMessages = messages
      .slice(-MESSAGE_WINDOW)
      .map((msg) => msg.message)
      .join('\n')

    const fullMessage = lastTwoMessages + '\n' + inputText.trim()

    if (inputText.trim()) {
      setMessages((prev) => [
        ...prev,
        { sender: USER_NAME, message: inputText }
      ])

      setInputText('')

      vscode.postMessage({
        type: 'chatMessage',
        data: fullMessage
      })
    }
  }

  useEffect(() => {
    window.addEventListener('message', (event) => {
      const message: PostMessage = event.data
      switch (message.type) {
        case 'onCompletion': {
          setCompletion(message.value)
          setTimeout(() => {
            if (divRef.current) {
              divRef.current.scrollTop = divRef.current.scrollHeight
            }
          }, 200)
          break
        }
        case 'onEnd': {
          setMessages((prev) => {
            return [
              ...prev,
              {
                sender: BOT_NAME,
                message: message.value
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
            <Message sender={message.sender} message={message.message} />
          ))}
          {!!completion && <Message sender={BOT_NAME} message={completion} />}
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
            <VSCodeButton type="submit" appearance="primary">
              Send message
            </VSCodeButton>
          </div>
        </form>
      </div>
    </VSCodePanelView>
  )
}

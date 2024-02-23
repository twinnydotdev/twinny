import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import CodeBlock from './code-block'

import styles from './index.module.css'
import { MessageType, ThemeType } from '../common/types'
import React from 'react'
import { BOT_NAME, TWINNY, YOU } from '../common/constants'

interface MessageProps {
  message?: MessageType
  theme: ThemeType | undefined
}

export const Message = ({ message, theme }: MessageProps) => {
  if (!message?.content) {
    return null
  }
  return (
    <>
      <b>{message.role === BOT_NAME ? TWINNY : YOU}</b>
      <div
        className={`${styles.message} ${
          message?.role === BOT_NAME ? styles.bot : ''
        }`}
      >
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            pre({ children }) {
              if (React.isValidElement(children)) {
                return (
                  <CodeBlock
                    role={message.role}
                    language={message.language}
                    theme={theme}
                    {...children.props}
                  />
                )
              }
              return <pre>{children}</pre>
            },
            code({ children }) {
              return <code>{children}</code>
            }
          }}
        >
          {message.content.trimStart()}
        </Markdown>
      </div>
    </>
  )
}

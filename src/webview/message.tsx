import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { VSCodeDivider } from '@vscode/webview-ui-toolkit/react'

import CodeBlock from './code-block'

import styles from './index.module.css'
import { MessageType, ThemeType } from '../types'
import React from 'react'

interface MessageProps {
  message?: MessageType
  theme: ThemeType | undefined
}

export const Message = ({
  message,
  theme,
}: MessageProps) => {
  if (!message?.content) {
    return null
  }
  return (
    <div className={styles.message}>
      <b>{message.role}</b>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            if (React.isValidElement(children)) {
              return (
                <CodeBlock
                  language={message.language}
                  theme={theme}
                  completionType={message.type}
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
      <VSCodeDivider />
    </div>
  )
}

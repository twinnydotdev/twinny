import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { VSCodeDivider } from '@vscode/webview-ui-toolkit/react'

import CodeBlock from './code-block'

import styles from './index.module.css'

interface MessageProps {
  message?: string
  sender: string
  completionType: string
}

export const Message = ({ message, sender, completionType }: MessageProps) => {
  if (!message) {
    return null
  }
  return (
    <div className={styles.message}>
      <b>{sender}</b>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            return <CodeBlock completionType={completionType} {...props} />
          }
        }}
      >
        {message.trimStart()}
      </Markdown>
      <VSCodeDivider />
    </div>
  )
}

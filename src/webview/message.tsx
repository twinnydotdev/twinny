import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import CodeBlock from './code-block'
import { VSCodeDivider } from '@vscode/webview-ui-toolkit/react'
import { ChatbotAvatar, UserAvatar } from './icons'

import styles from './index.module.css'

interface MessageProps {
  message: string
  sender: string
}

export const Message = ({ message, sender }: MessageProps) => {
  return (
    <div className={styles.message}>
      <div>{sender === 'twinny' ? <ChatbotAvatar /> : <UserAvatar />}</div>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={{
          code(props) {
            return <CodeBlock {...props} />
          }
        }}
      >
        {message}
      </Markdown>
      <VSCodeDivider />
    </div>
  )
}

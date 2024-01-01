import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import CodeBlock from './code-block'
import { VSCodeDivider } from '@vscode/webview-ui-toolkit/react'

import styles from './index.module.css'

interface MessageProps {
  message: string
  sender: string
}

export const Message = ({ message, sender }: MessageProps) => {
  return (
    <div className={styles.message}>
      <b>{sender}</b>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            return <CodeBlock {...props} />
          }
        }}
      >
        {message.trimStart()}
      </Markdown>
      <VSCodeDivider />
    </div>
  )
}

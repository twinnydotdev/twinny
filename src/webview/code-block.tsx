import { VSCodeButton } from '@vscode/webview-ui-toolkit/react'
import { ReactNode } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import cn from 'classnames'

import styles from './index.module.css'

interface CodeBlockProps {
  className?: string
  children?: ReactNode
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const CodeBlock = (props: CodeBlockProps) => {
  const { className, children } = props
  const match = /language-(\w+)/.exec(className || '')

  const handleCopy = () => {
    const text = String(children).replace(/^\n/, '')
    navigator.clipboard.writeText(text)
  }

  const handleOpenDiff = () => {
    global.vscode.postMessage({
      type: 'openDiff',
      data: String(children).replace(/^\n/, '')
    })
  }

  const handleAccept = () => {
    global.vscode.postMessage({
      type: 'accept',
      data: String(children).replace(/^\n/, '')
    })
  }

  return match ? (
    <>
      <div className={styles.codeOptions}>
        <VSCodeButton onClick={handleAccept}>
          <span className={cn('codicon codicon-check', styles.icon)}></span>
          Accept
        </VSCodeButton>
        <VSCodeButton onClick={handleOpenDiff}>
          <span className={cn('codicon codicon-diff', styles.icon)}></span>
          View diff
        </VSCodeButton>
        <VSCodeButton onClick={handleCopy}>
          <span className={cn('codicon codicon-copy', styles.icon)}></span> Copy
        </VSCodeButton>
      </div>
      <SyntaxHighlighter
        children={String(children).trimStart().replace(/\n$/, '')}
        style={vscDarkPlus}
        language={match[1] || 'typescript'}
      />
    </>
  ) : (
    <code>{String(children)}</code>
  )
}

export default CodeBlock

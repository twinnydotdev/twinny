import { VSCodeButton } from '@vscode/webview-ui-toolkit/react'
import { ReactNode } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'

import { codeActionTypes } from '../prompts'
import { MESSAGE_NAME } from '../constants'

import styles from './index.module.css'

interface CodeBlockProps {
  className?: string
  completionType: string
  children?: ReactNode
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const CodeBlock = (props: CodeBlockProps) => {
  const { className, children, completionType } = props
  const match = /language-(\w+)/.exec(className || '')

  const handleCopy = () => {
    const text = String(children).replace(/^\n/, '')
    navigator.clipboard.writeText(text)
  }

  const handleOpenDiff = () => {
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyAcceptSolution,
      data: String(children).replace(/^\n/, '')
    })
  }

  const handleAccept = () => {
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyAcceptSolution,
      data: String(children).replace(/^\n/, '')
    })
  }

  return match ? (
    <>
      <div className={styles.codeOptions}>
        {codeActionTypes.includes(completionType) && (
          <>
            <VSCodeButton onClick={handleAccept}>Accept</VSCodeButton>
            <VSCodeButton onClick={handleOpenDiff}>View diff</VSCodeButton>
          </>
        )}
        <VSCodeButton onClick={handleCopy}>Copy</VSCodeButton>
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

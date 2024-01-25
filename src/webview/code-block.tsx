import { VSCodeButton } from '@vscode/webview-ui-toolkit/react'
import { ReactNode } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'

import { MESSAGE_NAME, codeActionTypes } from '../constants'

import styles from './index.module.css'
import { LanguageType } from '../types'

interface CodeBlockProps {
  className?: string
  completionType: string
  children?: ReactNode
  language: LanguageType | undefined
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const CodeBlock = (props: CodeBlockProps) => {
  const { children, completionType, language } = props

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

  return (
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
        language={language?.languageId?.toString()}
      />
    </>
  )
}

export default CodeBlock

import { VSCodeButton } from '@vscode/webview-ui-toolkit/react'
import { ReactNode } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism'

import { MESSAGE_NAME, codeActionTypes } from '../constants'

import styles from './index.module.css'
import { LanguageType, Theme, ThemeType } from '../types'
import { getLanguageMatch } from './utils'

interface CodeBlockProps {
  className?: string
  completionType: string
  children?: ReactNode
  language: LanguageType | undefined
  theme: ThemeType
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const CodeBlock = (props: CodeBlockProps) => {
  const { children, completionType, language, className, theme } = props

  const lang = getLanguageMatch(language, className)

  const handleCopy = () => {
    const text = String(children).replace(/^\n/, '')
    navigator.clipboard.writeText(text)
  }

  const handleAccept = () => {
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyAcceptSolution,
      data: String(children).replace(/^\n/, '')
    })
  }

  return (
    <>
      <SyntaxHighlighter
        children={String(children).trimStart().replace(/\n$/, '')}
        style={theme === Theme.Dark ? vscDarkPlus : vs}
        language={lang}
      />
      <div className={styles.codeOptions}>
        {codeActionTypes.includes(completionType) && (
          <>
            <VSCodeButton onClick={handleAccept}>Accept</VSCodeButton>
          </>
        )}
        <VSCodeButton onClick={handleCopy}>Copy</VSCodeButton>
      </div>
    </>
  )
}

export default CodeBlock

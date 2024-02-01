import { useState } from 'react'
import { VSCodeBadge, VSCodeButton } from '@vscode/webview-ui-toolkit/react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'

import { useSelection } from './hooks'
import { CodeIcon } from './icons'

import styles from './index.module.css'
import { LanguageType } from '../types'
import { getLanguageMatch } from './utils'

interface SelectionProps {
  onSelect: () => void
  language: LanguageType | undefined
}

export const Selection = ({ onSelect, language }: SelectionProps) => {
  const selection = useSelection(onSelect)
  const [isVisible, setIsVisible] = useState(false)

  const lang = getLanguageMatch(language, '')

  if (!selection) {
    return null
  }

  const handleToggleSelection = () => setIsVisible(!isVisible)

  return (
    <>
      {!!isVisible && (
        <SyntaxHighlighter
          children={selection.trimStart().replace(/\n$/, '')}
          style={vscDarkPlus}
          language={lang}
        />
      )}
      <div className={styles.selection}>
        <VSCodeButton
          title="Toggle selection preview"
          appearance="icon"
          onClick={handleToggleSelection}
        >
          <CodeIcon />
        </VSCodeButton>
        <VSCodeBadge>Selected characters: {selection?.length}</VSCodeBadge>
      </div>
    </>
  )
}

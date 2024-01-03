import { useState } from 'react'
import { VSCodeBadge, VSCodeButton } from '@vscode/webview-ui-toolkit/react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'

import styles from './index.module.css'
import { useSelection } from './hooks'

interface SelectionProps {
  onSelect: () => void
}

export const Selection = ({ onSelect }: SelectionProps) => {
  const selection = useSelection(onSelect)
  const [isVisible, setIsVisible] = useState(false)

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
          language="typescript"
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

function CodeIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M8 18L3 12L8 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16 6L21 12L16 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

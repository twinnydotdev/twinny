import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'

import { useSelection } from './hooks'

import { LanguageType } from '../extension/types'
import { getLanguageMatch } from './utils'

interface SelectionProps {
  onSelect: () => void
  language: LanguageType | undefined
  isVisible: boolean
}

export const Selection = ({ onSelect, language, isVisible }: SelectionProps) => {
  const selection = useSelection(onSelect)

  const lang = getLanguageMatch(language, '')

  if (!selection) {
    return null
  }

  return (
    <>
      {!!isVisible && (
        <SyntaxHighlighter
          children={selection.trimStart().replace(/\n$/, '')}
          style={vscDarkPlus}
          language={lang}
        />
      )}
    </>
  )
}

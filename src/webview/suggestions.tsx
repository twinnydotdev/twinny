import { useEffect, useState } from 'react'
import cn from 'classnames'

import { useTemplates, useWorkSpaceContext } from './hooks'
import { kebabToSentence } from './utils'
import { WORKSPACE_STORAGE_KEY, EVENT_NAME } from '../common/constants'
import styles from '../styles/index.module.css'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const Suggestions = ({ isDisabled }: { isDisabled?: boolean }) => {
  const templateContext = useWorkSpaceContext<string[]>(
    WORKSPACE_STORAGE_KEY.selectedTemplates
  )
  const { templates, saveTemplates } = useTemplates()
  const [suggestions, setSuggestions] = useState<string[]>()

  const handleOnClickSuggestion = (message: string) => {
    if (isDisabled) return

    global.vscode.postMessage({
      type: EVENT_NAME.twinnyClickSuggestion,
      data: message
    })
  }

  const fixDeletedTemplates = (savedTemplates: string[]) => {
    const availableTemplates = savedTemplates.filter((template) =>
      templates?.includes(template)
    )
    if (availableTemplates.length !== savedTemplates.length) {
      saveTemplates(availableTemplates)
    }
    return availableTemplates
  }

  useEffect(() => {
    if (!templateContext?.context?.length) {
      return
    }
    const filteredTemplates = fixDeletedTemplates(templateContext.context)
    setSuggestions(filteredTemplates)
  }, [templates])

  return (
    <div className={styles.suggestions}>
      {suggestions?.map((name) => (
        <div
          onClick={() => handleOnClickSuggestion(name)}
          key={name}
          className={cn(styles.suggestion, {
            [styles['suggestion--disabled']]: isDisabled
          })}
        >
          <div>{kebabToSentence(name)}</div>
        </div>
      ))}
    </div>
  )
}

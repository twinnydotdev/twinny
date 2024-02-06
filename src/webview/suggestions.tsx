import { CodeIcon, ExplainIcon, FixCodeIcon, TestsIcon } from './icons'
import { MESSAGE_KEY, MESSAGE_NAME } from '../constants'
import cn from 'classnames'

import styles from './index.module.css'
import { useWorkSpaceContext } from './hooks'
import { kebabToSentence } from './utils'

const SUGGESTIONS = [
  {
    name: 'refactor',
    value: 'Refactor',
    icon: <CodeIcon />,
    message: 'twinny.refactor'
  },
  {
    name: 'tests',
    value: 'Write tests',
    icon: <TestsIcon />,
    message: 'twinny.addTests'
  },
  {
    name: 'add-types',
    value: 'Add types',
    icon: <FixCodeIcon />,
    message: 'twinny.addTypes'
  },
  {
    name: 'explain',
    value: 'Explain',
    icon: <ExplainIcon />,
    message: 'twinny.explain'
  }
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const Suggestions = ({ isDisabled }: { isDisabled?: boolean }) => {
  const templates = useWorkSpaceContext<string[]>(MESSAGE_KEY.selectedTemplates)

  const handleOnClickSuggestion = (message: string) => {
    if (isDisabled) return

    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyClickSuggestion,
      data: message
    })
  }

  return (
    <div className={styles.suggestions}>
      {templates?.map((name) => (
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

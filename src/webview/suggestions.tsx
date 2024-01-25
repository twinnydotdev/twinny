import styles from './index.module.css'
import { CodeIcon, ExplainIcon, FixCodeIcon, TestsIcon } from './icons'
import { MESSAGE_NAME } from '../constants'
import cn from 'classnames'

const SUGGESTIONS = [
  {
    name: 'refactor',
    value: 'Refactor this code',
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
    name: 'fix-code',
    value: 'Fix selected code',
    icon: <FixCodeIcon />,
    message: 'twinny.fixCode'
  },
  {
    name: 'explain',
    value: 'Explain the code',
    icon: <ExplainIcon />,
    message: 'twinny.explain'
  }
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const Suggestions = ({ isDisabled }: { isDisabled?: boolean }) => {
  const handleOnClickSuggestion = (message: string) => {
    if (isDisabled) return

    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyClickSuggestion,
      data: message
    })
  }

  return (
    <div className={styles.suggestions}>
      {SUGGESTIONS.map(({ name, value, icon, message }) => (
        <div
          onClick={() => handleOnClickSuggestion(message)}
          key={name}
          className={cn(styles.suggestion, { [styles['suggestion--disabled']]: isDisabled })}
        >
          <div className={styles.icon}>{icon}</div>
          <div>{value}</div>
        </div>
      ))}
    </div>
  )
}

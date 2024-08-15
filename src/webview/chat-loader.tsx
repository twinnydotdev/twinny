import { useEffect, useState } from 'react'
import { ASSISTANT } from '../common/constants'
import { useLoading, useTheme } from './hooks'
import { Message } from './message'

export const ChatLoader = () => {
  const theme = useTheme()
  const loader = useLoading()
  const [dots, setDots] = useState('')

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prevDots) => {
        switch (prevDots) {
          case '':
            return '.'
          case '.':
            return '..'
          case '..':
            return '...'
          default:
            return ''
        }
      })
    }, 500)

    return () => clearInterval(interval)
  }, [])

  return (
    <Message
      isLoading
      isAssistant
      theme={theme}
      message={{
        content: `${loader || 'Thinking'}${dots}`,
        role: ASSISTANT
      }}
    ></Message>
  )
}

export default ChatLoader

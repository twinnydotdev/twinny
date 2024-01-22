import { useEffect, useState } from 'react'

import { MESSAGE_NAME } from '../constants'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const useSelection = (onSelect: () => void) => {
  const [selection, setSelection] = useState('')
  const handler = (event: MessageEvent) => {
    const message: PostMessage = event.data
    if (message?.type === MESSAGE_NAME.twinnyTextSelection) {
      setSelection(message?.value.completion.trim())
      onSelect?.()
    }
  }

  useEffect(() => {
    window.addEventListener('message', handler)
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyTextSelection
    })
    return () => window.removeEventListener('message', handler)
  }, [])

  return selection
}

export const useGlobalContext = <T>(key: string) => {
  const [context, setContext] = useState<T>()

  const handler = (event: MessageEvent) => {
    const message: PostMessage = event.data
    if (message?.type === `${MESSAGE_NAME.twinnyGlobalContext}-${key}`) {
      setContext(event.data.value)
    }
  }

  useEffect(() => {
    window.addEventListener('message', handler)
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyGlobalContext,
      key
    })

    return () => window.removeEventListener('message', handler)
  }, [])

  return {context, setContext }
}

export const useWorkSpaceContext = <T>(key: string) => {
  const [context, setContext] = useState<T>()

  const handler = (event: MessageEvent) => {
    const message: PostMessage = event.data
    if (message?.type === `${MESSAGE_NAME.twinnyWorkspaceContext}-${key}`) {
      setContext(event.data.value)
    }
  }

  useEffect(() => {
    window.addEventListener('message', handler)
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyWorkspaceContext,
      key
    })

    return () => window.removeEventListener('message', handler)
  }, [])

  return context
}

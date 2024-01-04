import { useEffect, useState } from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const useSelection = (onSelect: () => void) => {
  const [selection, setSelection] = useState('')
  const handler = (event: MessageEvent) => {
    const message: PostMessage = event.data
    if (message?.type === 'textSelection') {
      setSelection(message?.value.completion.trim())
      onSelect?.()
    }
  }

  useEffect(() => {
    window.addEventListener('message', handler)
    global.vscode.postMessage({
      type: 'getTextSelection'
    })
    return () => window.removeEventListener('message', handler)
  }, [])

  return selection
}

export const useWorkSpaceContext = <T>(key: string) => {
  const [context, setContext] = useState<T>()

  const handler = (event: MessageEvent) => {
    const message: PostMessage = event.data
    if (message?.type === `twinnyWorkSpaceContext-${key}`) {
      setContext(event.data.value)
    }
  }

  useEffect(() => {
    window.addEventListener('message', handler)
    global.vscode.postMessage({
      type: 'getTwinnyWorkspaceContext',
      key
    })

    return () => window.removeEventListener('message', handler)
  }, [])

  return context
}

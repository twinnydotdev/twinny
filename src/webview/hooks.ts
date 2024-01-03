import { useEffect, useState } from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const useSelection = (onSelect: () => void) => {
  const [selection, setSelection] = useState('')
  useEffect(() => {
    window.addEventListener('message', (event) => {
      const message: PostMessage = event.data
      if (message?.type === 'textSelection') {
        setSelection(message?.value.completion.trim())
        onSelect?.()
      }
    })
    global.vscode.postMessage({
      type: 'getTextSelection'
    })
  }, [])

  return selection
}

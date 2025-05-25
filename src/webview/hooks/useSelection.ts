import { useEffect, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { ServerMessage } from "../../common/types"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const useSelection = (onSelect?: () => void) => {
  const [selection, setSelection] = useState("")
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<string> = event.data
    if (message?.type === EVENT_NAME.twinnyTextSelection) {
      const selection = message?.data?.trim()
      setSelection(selection || "")
      onSelect?.()
    }
  }

  useEffect(() => {
    window.addEventListener("message", handler)
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyTextSelection
    })
    return () => window.removeEventListener("message", handler)
  }, [])

  return selection
}

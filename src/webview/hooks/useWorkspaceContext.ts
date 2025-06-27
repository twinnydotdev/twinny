import { useEffect, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { ServerMessage, AnyContextItem } from "../../common/types"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const useWorkspaceContext = () => {
  const [contextItems, setContextItems] = useState<AnyContextItem[]>([])

  const handler = (event: MessageEvent) => {
    const message: ServerMessage<AnyContextItem[]> = event.data
    if (message?.type === EVENT_NAME.twinnyUpdateContextItems) {
      // Replace entire list with the new one from the extension
      setContextItems(message.data || [])
    }
  }

  const removeContextItem = (id: string) => {
    // Optimistically update UI, then notify extension
    setContextItems((prev) => prev.filter((item) => item.id !== id))
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyRemoveContextItem,
      data: id // Send the ID of the item to remove
    })
  }

  useEffect(() => {
    window.addEventListener("message", handler)
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyGetContextItems // Request initial/full list
    })
    return () => window.removeEventListener("message", handler)
  }, [])

  return { contextItems, removeContextItem }
}

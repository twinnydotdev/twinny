import { useEffect, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { AnyContextItem,ServerMessage } from "../../common/types"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const useWorkspaceContext = () => {
  const [contextItems, setContextItems] = useState<AnyContextItem[]>([])

  const handler = (event: MessageEvent) => {
    const message: ServerMessage<AnyContextItem[]> = event.data
    if (message?.type === EVENT_NAME.twinnyUpdateContextItems) {
      setContextItems(message.data || [])
    }
  }

  const removeContextItem = (id: string) => {
    setContextItems((prev) => prev.filter((item) => item.id !== id))
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyRemoveContextItem,
      data: id
    })
  }

  useEffect(() => {
    window.addEventListener("message", handler)
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyGetContextItems
    })
    return () => window.removeEventListener("message", handler)
  }, [])

  return { contextItems, removeContextItem }
}

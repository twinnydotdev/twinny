import { useEffect, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { ApiModel, ServerMessage } from "../../common/types"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const useModels = () => {
  const [models, setModels] = useState<Record<string, any>>({})

  const handler = (event: MessageEvent) => {
    const message: ServerMessage<ApiModel[]> = event.data
    if (message?.type === EVENT_NAME.twinnyGetModels) {
      setModels(message?.data)
    }
    return () => window.removeEventListener("message", handler)
  }

  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyGetModels
    })
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [])

  return { models }
}

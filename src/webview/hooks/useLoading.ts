import { useEffect, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { ServerMessage } from "../../common/types"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const useLoading = () => {
  const [loader, setLoader] = useState<string | undefined>()
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<string> = event.data
    if (message?.type === EVENT_NAME.twinnySendLoader) {
      setLoader(message?.data)
    }
    return () => window.removeEventListener("message", handler)
  }
  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnySendLoader
    })
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [])
  return loader
}

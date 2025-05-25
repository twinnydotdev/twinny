import { useEffect, useRef } from "react"

import { EVENT_NAME } from "../../common/constants"
import { ServerMessage } from "../../common/types"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const useFilePaths = () => {
  const filePaths = useRef<string[] | undefined>()

  const handler = (event: MessageEvent) => {
    const message: ServerMessage<string[]> = event.data
    if (
      !filePaths.current?.length &&
      message?.type === EVENT_NAME.twinnyFileListResponse
    ) {
      filePaths.current = message.data
    }
  }

  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyFileListRequest
    })

    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [])

  return {
    filePaths: filePaths.current || []
  }
}

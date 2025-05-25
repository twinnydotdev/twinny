import { useEffect, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { ServerMessage } from "../../common/types"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const useFileContext = () => {
  const [files, setFiles] = useState<
    { name: string; path: string; category: string }[]
  >([])

  const handler = (event: MessageEvent) => {
    const message: ServerMessage<
      { name: string; path: string; category: string }[]
    > = event.data
    if (message?.type === EVENT_NAME.twinnyAddOpenFilesToContext) {
      setFiles((prev) => {
        const newFiles = message.data.filter(
          (newFile) =>
            !prev.some((existingFile) => existingFile.path === newFile.path)
        )
        return [...prev, ...newFiles]
      })
    }
  }

  const removeFile = (path: string) => {
    setFiles((prev) => prev.filter((file) => file.path !== path))
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyRemoveContextFile,
      data: path
    })
  }

  useEffect(() => {
    window.addEventListener("message", handler)
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyGetContextFiles
    })
    return () => window.removeEventListener("message", handler)
  }, [])

  return { files, removeFile }
}

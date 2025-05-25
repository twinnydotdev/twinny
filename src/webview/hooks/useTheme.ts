import { useEffect, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { ServerMessage, ThemeType } from "../../common/types"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const useTheme = () => {
  const [theme, setTheme] = useState<ThemeType>("Dark")
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<ThemeType> = event.data
    if (message?.type === EVENT_NAME.twinnySendTheme) {
      setTheme(message?.data)
    }
  }
  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnySendTheme
    })
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [])
  return theme
}

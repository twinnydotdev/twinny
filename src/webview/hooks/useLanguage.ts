import { useEffect, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { LanguageType, ServerMessage } from "../../common/types"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const useLanguage = (): LanguageType | undefined => {
  const [language, setLanguage] = useState<LanguageType>()
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<LanguageType> = event.data
    if (message?.type === EVENT_NAME.twinnySendLanguage) {
      const language = message.data
      if (language) {
        setLanguage(language)
      }
    }
    return () => window.removeEventListener("message", handler)
  }
  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnySendLanguage
    })
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [])
  return language
}

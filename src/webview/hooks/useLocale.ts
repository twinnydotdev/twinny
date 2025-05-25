import { useEffect, useState } from "react"
import i18next from "i18next"

import { EVENT_NAME } from "../../common/constants"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const useLocale = () => {
  const [locale, setLocale] = useState<string>("en")
  const [renderKey, setRenderKey] = useState<number>(0)
  useEffect(() => {
    const messageHandler = (event: MessageEvent) => {
      if (event.data.type === EVENT_NAME.twinnySetLocale) {
        i18next.changeLanguage(event.data.data)
        setLocale(event.data.data)
        setRenderKey((prev: number) => prev + 1)
      }
    }

    global.vscode.postMessage({ type: EVENT_NAME.twinntGetLocale })

    window.addEventListener("message", messageHandler)
    return () => window.removeEventListener("message", messageHandler)
  }, [i18next])
  return { locale, renderKey }
}

import { useEffect, useState } from "react"
import i18next from "i18next"

import { EVENT_NAME } from "../../common/constants"
import { bridge, useServerEvent } from "../messaging"

export const useLocale = () => {
  const [locale, setLocale] = useState<string>("en")
  const [renderKey, setRenderKey] = useState<number>(0)

  const applyLocale = (next: string) => {
    i18next.changeLanguage(next)
    setLocale(next)
    // Remounting the tree is how translated strings baked into component
    // state get refreshed.
    setRenderKey((key) => key + 1)
  }

  useEffect(() => {
    bridge.request(EVENT_NAME.twinntGetLocale).then(applyLocale)
  }, [])

  useServerEvent(EVENT_NAME.twinnySetLocale, applyLocale)

  return { locale, renderKey }
}

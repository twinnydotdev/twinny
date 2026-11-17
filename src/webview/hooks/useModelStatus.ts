import { useCallback, useEffect, useRef, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { ModelStatus } from "../../common/model-status"
import { TwinnyProvider } from "../../common/types"
import { bridge } from "../messaging"

/**
 * What the chat model's server says about it right now. Asked when the
 * provider or model changes, when a reply ends (the model is loaded by
 * then, and may hold a different context), and when the window regains
 * focus (a local server unloads an idle model after a few minutes).
 */
export const useModelStatus = (provider: TwinnyProvider | null, busy: boolean) => {
  const [status, setStatus] = useState<ModelStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const asked = useRef(0)
  const key = provider ? `${provider.id}|${provider.modelName}` : ""

  const refresh = useCallback(() => {
    const mine = ++asked.current
    bridge
      .request(EVENT_NAME.twinnyModelStatus)
      .then((value) => {
        if (mine === asked.current) setStatus(value)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!key) {
      setStatus(null)
      return
    }
    if (!busy) refresh()
  }, [key, busy, refresh])

  useEffect(() => {
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [refresh])

  // The click answers at once; the status is asked again until the model is in memory.
  const loading = !!status?.loading
  useEffect(() => {
    if (!loading) return
    const timer = setInterval(refresh, 1500)
    return () => clearInterval(timer)
  }, [loading, refresh])

  const warm = useCallback(() => {
    if (starting || loading) return
    const mine = ++asked.current
    setStarting(true)
    bridge
      .request(EVENT_NAME.twinnyWarmModel)
      .then((value) => {
        if (mine === asked.current) setStatus(value)
        else refresh()
      })
      .catch(() => undefined)
      .finally(() => setStarting(false))
  }, [starting, loading, refresh])

  return { status, warming: starting || loading, warm }

}

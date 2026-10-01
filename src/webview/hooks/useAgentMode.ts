import { useCallback, useEffect, useRef, useState } from "react"

import { EVENT_NAME, GLOBAL_STORAGE_KEY } from "../../common/constants"
import { bridge } from "../messaging"

import { StorageType, useStorageContext } from "./useStorageContext"

/**
 * Agent mode on or off. Kept in the extension's global storage, not in
 * settings: a settings write makes VS Code reload configuration, which
 * the user sees as a flicker. Until it is first switched, it follows the
 * `twinny.chatTools` setting.
 */
export const useAgentMode = () => {
  const { context, setContext, loaded } = useStorageContext<boolean>(
    StorageType.Global,
    GLOBAL_STORAGE_KEY.agentMode
  )
  const [fallback, setFallback] = useState(false)
  const onRef = useRef(false)

  useEffect(() => {
    if (!loaded || context !== undefined) return
    bridge
      .request(EVENT_NAME.twinnyGetConfigValue, { key: "chatTools" })
      .then(({ value }) => setFallback(value === true))
  }, [loaded, context])

  const on = context ?? fallback
  onRef.current = on

  const toggle = useCallback(() => {
    setContext(!onRef.current)
    return true
  }, [setContext])

  return { agentMode: on, toggleAgentMode: toggle }
}

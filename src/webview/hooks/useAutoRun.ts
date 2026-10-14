import { useCallback, useEffect, useRef, useState } from "react"

import { EVENT_NAME, GLOBAL_STORAGE_KEY } from "../../common/constants"
import type { TeamAgentPolicy } from "../../common/team"
import { bridge } from "../messaging"

import { StorageType, useStorageContext } from "./useStorageContext"

/**
 * Whether agent mode runs the model's commands without asking. Kept in
 * global storage like agent mode itself; until it is first switched,
 * `twinny.chatToolsCommands` decides (`allow` is on). `available` is false
 * when that setting is `off`: there are no commands to run.
 */
export const useAutoRun = (team?: TeamAgentPolicy) => {
  const { context, setContext, loaded } = useStorageContext<boolean>(
    StorageType.Global,
    GLOBAL_STORAGE_KEY.autoRunCommands
  )
  const [setting, setSetting] = useState<string>("ask")
  const onRef = useRef(false)

  useEffect(() => {
    if (!loaded) return
    bridge
      .request(EVENT_NAME.twinnyGetConfigValue, { key: "chatToolsCommands" })
      .then(({ value }) => typeof value === "string" && setSetting(value))
  }, [loaded])

  // A team that asks for every command, or allows none, leaves nothing to auto-run.
  const available = setting !== "off" && !team?.commands
  const on = available && (context ?? setting === "allow")
  onRef.current = on

  const toggle = useCallback(() => {
    setContext(!onRef.current)
  }, [setContext])

  const enable = useCallback(() => setContext(true), [setContext])

  return { autoRun: on, autoRunAvailable: available, toggleAutoRun: toggle, enableAutoRun: enable, setAutoRun: setContext }
}

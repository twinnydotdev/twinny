import { useCallback, useEffect, useRef, useState } from "react"

import { EVENT_NAME, GLOBAL_STORAGE_KEY } from "../../common/constants"
import { bridge } from "../messaging"

import { StorageType, useStorageContext } from "./useStorageContext"
import { useTeamAgentPolicy } from "./useTeamAgentPolicy"

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
  const team = useTeamAgentPolicy()
  // A team that turned agent mode off keeps it off; the developer's own
  // choice is kept for when they leave the team.
  const teamOff = !!team?.off
  const teamOffRef = useRef(teamOff)
  teamOffRef.current = teamOff

  useEffect(() => {
    if (!loaded || context !== undefined) return
    bridge
      .request(EVENT_NAME.twinnyGetConfigValue, { key: "chatTools" })
      .then(({ value }) => setFallback(value === true))
  }, [loaded, context])

  const on = !teamOff && (context ?? fallback)
  onRef.current = on

  const toggle = useCallback(() => {
    if (!teamOffRef.current) setContext(!onRef.current)
    return true
  }, [setContext])

  return { agentMode: on, toggleAgentMode: toggle, agentModeTeamOff: teamOff, teamAgentRules: team }
}

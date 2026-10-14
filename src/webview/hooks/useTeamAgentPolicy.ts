import { useEffect, useState } from "react"

import { PROVIDER_EVENT_NAME } from "../../common/constants"
import { TeamAgentPolicy } from "../../common/team"
import { bridge, useServerEvent } from "../messaging"

/**
 * What the connected team's policy says agent mode may do, kept current
 * as the extension re-reads it. Undefined when no team sets agent rules.
 */
export const useTeamAgentPolicy = (): TeamAgentPolicy | undefined => {
  const [agent, setAgent] = useState<TeamAgentPolicy | undefined>()
  useServerEvent(PROVIDER_EVENT_NAME.getTeamPolicy, (state) => setAgent(state?.policy?.agent))
  useEffect(() => {
    bridge
      .request(PROVIDER_EVENT_NAME.getTeamPolicy)
      .then((state) => setAgent(state?.policy?.agent))
      .catch(() => setAgent(undefined))
  }, [])
  return agent
}

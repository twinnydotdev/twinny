import { useCallback, useRef, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { WorkspaceSearchReport } from "../../common/messaging/protocol"
import { useServerEvent } from "../messaging"

/** Stages after which the report will not change again. */
const FINAL_STAGES = new Set(["done", "empty", "unavailable"])

export const isSearchFinished = (report: WorkspaceSearchReport | undefined) =>
  !!report && FINAL_STAGES.has(report.stage)

/**
 * The workspace search for the message being answered, stage by stage.
 *
 * The extension pushes a fresh report each time the search moves on; the
 * chat shows it under the pending reply, then takes the finished report
 * with the reply itself and clears here for the next turn. The ref lets
 * an event handler read the latest report without a stale closure.
 */
export const useWorkspaceSearch = () => {
  const [report, setReport] = useState<WorkspaceSearchReport | undefined>()
  const reportRef = useRef<WorkspaceSearchReport | undefined>()

  useServerEvent(EVENT_NAME.twinnyWorkspaceSearch, (incoming) => {
    reportRef.current = incoming
    setReport(incoming)
  })

  const clear = useCallback(() => {
    reportRef.current = undefined
    setReport(undefined)
  }, [])

  /** The finished report, if there is one, and forgets it. */
  const take = useCallback(() => {
    const current = reportRef.current
    clear()
    return isSearchFinished(current) ? current : undefined
  }, [clear])

  return { report, clear, take }
}

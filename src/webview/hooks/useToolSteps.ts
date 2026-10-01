import { useCallback, useRef, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { ToolStepView } from "../../common/types"
import { useServerEvent } from "../messaging"

/**
 * The tool steps of the reply being written. The extension sends the whole
 * list whenever a step starts, finishes or waits for the user; the chat
 * shows it over the pending reply, then takes it with the reply itself and
 * clears here for the next turn. The ref lets an event handler read the
 * latest list without a stale closure.
 */
export const useToolSteps = () => {
  const [steps, setSteps] = useState<ToolStepView[]>([])
  const stepsRef = useRef<ToolStepView[]>([])

  useServerEvent(EVENT_NAME.twinnyToolSteps, (incoming) => {
    stepsRef.current = incoming ?? []
    setSteps(stepsRef.current)
  })

  const clear = useCallback(() => {
    stepsRef.current = []
    setSteps([])
  }, [])

  /** The steps so far, if any, and forgets them. */
  const take = useCallback(() => {
    const current = stepsRef.current
    clear()
    return current.length ? current : undefined
  }, [clear])

  return { steps, clear, take }
}

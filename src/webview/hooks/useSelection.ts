import { useEffect, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { bridge, useServerEvent } from "../messaging"

/**
 * The editor's current selection.
 *
 * Read once on mount, then kept live by the selection-change events the
 * extension pushes. `onSelect` fires on every push, which is what the chat
 * composer uses to pull focus when the user highlights code.
 */
export const useSelection = (onSelect?: () => void) => {
  const [selection, setSelection] = useState("")

  useEffect(() => {
    let cancelled = false
    bridge.request(EVENT_NAME.twinnyTextSelection).then((text) => {
      if (!cancelled) setSelection(text?.trim() || "")
    })
    return () => {
      cancelled = true
    }
  }, [])

  useServerEvent(EVENT_NAME.twinnyTextSelection, (text) => {
    setSelection(text?.trim() || "")
    onSelect?.()
  })

  return selection
}

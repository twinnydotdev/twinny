import { useEffect, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { AnyContextItem } from "../../common/types"
import { emit, useServerEvent } from "../messaging"

/** The files and selections the user has pinned to the conversation. */
export const useWorkspaceContext = () => {
  const [contextItems, setContextItems] = useState<AnyContextItem[]>([])

  useServerEvent(EVENT_NAME.twinnyUpdateContextItems, (items) =>
    setContextItems(items || [])
  )

  useEffect(() => emit(EVENT_NAME.twinnyGetContextItems), [])

  const removeContextItem = (id: string) => {
    setContextItems((prev) => prev.filter((item) => item.id !== id))
    emit(EVENT_NAME.twinnyRemoveContextItem, id)
  }

  return { contextItems, removeContextItem }
}

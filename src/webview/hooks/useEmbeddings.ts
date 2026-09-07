import { useState } from "react"

import { EMBEDDING_EVENT_NAME } from "../../common/constants"
import { EmbeddingProgress } from "../../common/messaging/protocol"
import { emit, useServerEvent, useServerState } from "../messaging"

const IDLE: EmbeddingProgress = {
  running: false,
  processed: 0,
  total: 0,
  currentFiles: []
}

/** The workspace index: what is there, and what is happening to it. */
export const useEmbeddings = () => {
  const status = useServerState(EMBEDDING_EVENT_NAME.getStatus)
  const [progress, setProgress] = useState<EmbeddingProgress>(IDLE)

  useServerEvent(EMBEDDING_EVENT_NAME.progress, (update) => {
    setProgress(update)
    if (!update.running) status.refetch()
  })

  return {
    status: status.data,
    statusLoading: status.isLoading,
    progress,
    embed: () => emit(EMBEDDING_EVENT_NAME.embed),
    cancel: () => emit(EMBEDDING_EVENT_NAME.cancel)
  }
}

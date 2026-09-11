import { useState } from "react"

import { EMBEDDING_EVENT_NAME } from "../../common/constants"
import { EmbeddingProgress } from "../../common/messaging/protocol"
import { emit, useServerEvent, useServerState } from "../messaging"

const IDLE: EmbeddingProgress = {
  running: false,
  phase: "embedding",
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
    /** Embed what changed since the last run. */
    update: () => emit(EMBEDDING_EVENT_NAME.embed),
    /** Start over: needed after switching embedding model or chunk sizes. */
    rebuild: () => emit(EMBEDDING_EVENT_NAME.rebuild),
    cancel: () => emit(EMBEDDING_EVENT_NAME.cancel)
  }
}

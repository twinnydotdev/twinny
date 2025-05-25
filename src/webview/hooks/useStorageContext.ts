import { useEffect, useMemo, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { ServerMessage } from "../../common/types"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export enum StorageType {
  Global = "global",
  Session = "session",
  Workspace = "workspace"
}

export const useStorageContext = <T>(storageType: StorageType, key: string) => {
  const [context, setContextState] = useState<T | undefined>()

  const getEventName = (baseEvent: string) => `${baseEvent}-${key}`

  const listenEventName = useMemo(() => {
    switch (storageType) {
      case StorageType.Global:
        return getEventName(EVENT_NAME.twinnyGlobalContext)
      case StorageType.Session:
        return getEventName(EVENT_NAME.twinnySessionContext)
      case StorageType.Workspace:
        return getEventName(EVENT_NAME.twinnyGetWorkspaceContext)
    }
  }, [storageType, key])

  const fetchEventName = useMemo(() => {
    switch (storageType) {
      case StorageType.Global:
        return EVENT_NAME.twinnyGlobalContext
      case StorageType.Session:
        return EVENT_NAME.twinnySessionContext
      case StorageType.Workspace:
        return EVENT_NAME.twinnyGetWorkspaceContext
    }
  }, [storageType])

  const storeEventName = useMemo(() => {
    switch (storageType) {
      case StorageType.Global:
        return EVENT_NAME.twinnySetGlobalContext
      case StorageType.Session:
        return EVENT_NAME.twinnySetSessionContext
      case StorageType.Workspace:
        return EVENT_NAME.twinnySetWorkspaceContext
    }
  }, [storageType])

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message: ServerMessage = event.data
      if (message?.type === listenEventName) {
        setContextState(event.data.data)
      }
    }
    window.addEventListener("message", handler)
    global.vscode.postMessage({
      type: fetchEventName,
      key
    })
    return () => window.removeEventListener("message", handler)
  }, [listenEventName, fetchEventName, key])

  const setContext = (value: T) => {
    setContextState(value)
    global.vscode.postMessage({
      type: storeEventName,
      key,
      data: value
    })
  }

  return { context, setContext }
}

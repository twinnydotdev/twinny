import { useEffect, useState } from "react"

import { EVENT_NAME, WORKSPACE_STORAGE_KEY } from "../../common/constants"
import { ClientMessage, ServerMessage } from "../../common/types"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const useTemplates = () => {
  const [templates, setTemplates] = useState<string[]>()
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<string[]> = event.data
    if (message?.type === EVENT_NAME.twinnyListTemplates) {
      setTemplates(message?.data)
    }
    return () => window.removeEventListener("message", handler)
  }

  const saveTemplates = (templates: string[]) => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnySetWorkspaceContext,
      key: WORKSPACE_STORAGE_KEY.selectedTemplates,
      data: templates
    } as ClientMessage<string[]>)
  }

  const editDefaultTemplates = () => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyEditDefaultTemplates
    })
  }

  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyListTemplates
    })
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [])
  return { templates, saveTemplates, editDefaultTemplates }
}

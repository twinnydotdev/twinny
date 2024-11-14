import { useEffect, useState } from "react"

import "./i18n"

import { EVENT_NAME, WEBUI_TABS } from "../common/constants"
import { ServerMessage } from "../common/types"

import { Chat } from "./chat"
import { ConversationHistory } from "./conversation-history"
import { Providers } from "./providers"
import { Review } from "./review"
import { Settings } from "./settings"
import { Symmetry } from "./symmetry"

const tabs: Record<string, JSX.Element> = {
  [WEBUI_TABS.settings]: <Settings />,
  [WEBUI_TABS.providers]: <Providers />,
  [WEBUI_TABS.symmetry]: <Symmetry />,
  [WEBUI_TABS.review]: <Review />,
}

interface MainProps {
  fullScreen?: boolean
}

export const Main = ({ fullScreen }: MainProps) => {
  const [tab, setTab] = useState<string | undefined>(WEBUI_TABS.chat)

  const tabsWithProps = {
    [WEBUI_TABS.chat]: <Chat fullScreen={fullScreen} />,
  }

  const handler = (event: MessageEvent) => {
    const message: ServerMessage<string | undefined> = event.data
    if (message?.type === EVENT_NAME.twinnySetTab) {
      setTab(message?.value.data)
    }
    return () => window.removeEventListener("message", handler)
  }
  useEffect(() => {
    window.addEventListener("message", handler)
  }, [])

  if (!tab) {
    return null
  }

  if (tab === WEBUI_TABS.history) {
    return <ConversationHistory onSelect={() => setTab(WEBUI_TABS.chat)} />
  }

  const allTabs = { ...tabs, ...tabsWithProps }

  const element: JSX.Element = allTabs[tab]

  return element || null
}

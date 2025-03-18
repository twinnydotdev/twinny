import { useEffect, useState } from "react"

import "./i18n"

import { EVENT_NAME, WEBUI_TABS } from "../common/constants"
import { ServerMessage } from "../common/types"

import { Chat } from "./chat"
import { ConversationHistory } from "./conversation-history"
import { EmbeddingOptions } from "./embedding-options"
import { useLocale } from "./hooks"
import { Providers } from "./providers"
import { Review } from "./review"
import { Settings } from "./settings"
import { Symmetry } from "./symmetry"

const tabs: Record<string, JSX.Element> = {
  [WEBUI_TABS.settings]: <Settings />,
  [WEBUI_TABS.providers]: <Providers />,
  [WEBUI_TABS.review]: <Review />,
  [WEBUI_TABS.symmetry]: <Symmetry />,
  [WEBUI_TABS.embeddings]: <EmbeddingOptions />
}

interface MainProps {
  fullScreen?: boolean
}

export const Main = ({ fullScreen }: MainProps) => {
  const [tab, setTab] = useState<string | undefined>(WEBUI_TABS.chat)
  const { locale, renderKey } = useLocale()
  const tabsWithProps = {
    [WEBUI_TABS.chat]: <Chat fullScreen={fullScreen} />
  }

  const handler = (event: MessageEvent) => {
    const message: ServerMessage<string | undefined> = event.data
    if (message?.type === EVENT_NAME.twinnySetTab) {
      setTab(message?.data)
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

  return (
    <div key={renderKey} data-locale={locale}>
      {element}
    </div>
  )
}

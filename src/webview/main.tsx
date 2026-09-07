import { useState } from "react"

import "./i18n"

import { EVENT_NAME, WEBUI_TABS } from "../common/constants"

import { useLocale } from "./hooks/useLocale"
import { Chat } from "./chat"
import { ConversationHistory } from "./conversation-history"
import { EmbeddingOptions } from "./embedding-options"
import { useServerEvent } from "./messaging"
import { Providers } from "./providers"
import { Review } from "./review"
import { Settings } from "./settings"

import styles from "./styles/main.module.css"

const tabs: Record<string, JSX.Element> = {
  [WEBUI_TABS.settings]: <Settings />,
  [WEBUI_TABS.providers]: <Providers />,
  [WEBUI_TABS.review]: <Review />,
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

  useServerEvent(EVENT_NAME.twinnySetTab, setTab)

  if (!tab) {
    return null
  }

  if (tab === WEBUI_TABS.history) {
    return (
      <div className={styles.page}>
        <ConversationHistory onSelect={() => setTab(WEBUI_TABS.chat)} />
      </div>
    )
  }

  const allTabs = { ...tabs, ...tabsWithProps }

  const element: JSX.Element = allTabs[tab]

  return (
    <div
      key={renderKey}
      data-locale={locale}
      className={tab === WEBUI_TABS.chat ? undefined : styles.page}
    >
      {element}
    </div>
  )
}

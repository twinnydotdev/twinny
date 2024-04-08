import { useEffect, useState } from 'react'
import { Chat } from './chat'
import { TemplateSettings } from './template-settings'
import { ServerMessage } from '../common/types'
import { MESSAGE_NAME, UI_TABS } from '../common/constants'
import { Providers } from './providers'

const tabs: Record<string, JSX.Element> = {
  [UI_TABS.chat]: <Chat />,
  [UI_TABS.templates]: <TemplateSettings />,
  [UI_TABS.providers]: <Providers />
}

export const Main = () => {
  const [tab, setTab] = useState<string | undefined>(UI_TABS.chat)

  const handler = (event: MessageEvent) => {
    const message: ServerMessage<string | undefined> = event.data
    if (message?.type === MESSAGE_NAME.twinnySetTab) {
      setTab(message?.value.data)
    }
    return () => window.removeEventListener('message', handler)
  }
  useEffect(() => {
    window.addEventListener('message', handler)
  }, [])

  if (!tab) {
    return null
  }

  const element: JSX.Element = tabs[tab]

  return element || null
}

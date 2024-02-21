import { useEffect, useState } from 'react'
import { Chat } from './chat'
import { AdditionalOptions } from './additional-settings'
import { ServerMessage } from '../extension/types'
import { MESSAGE_NAME, UI_TABS } from '../constants'

const tabs: Record<string, JSX.Element> = {
  [UI_TABS.chat]: <Chat />,
  [UI_TABS.templates]: <AdditionalOptions />
}

export const Main = () => {
  const [tab, setTab] = useState<string | undefined>('chat')

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

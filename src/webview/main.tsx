import { useEffect, useState } from 'react'
import { Chat } from './chat'
import { TemplateSettings } from './template-settings'
import { ServerMessage } from '../types'
import { MESSAGE_NAME } from '../constants'

interface TabComponents {
  [key: string]: { component: JSX.Element }
}

const tabs: TabComponents = {
  chat: {
    component: <Chat />
  },
  templates: {
    component: <TemplateSettings />
  }
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

  return tabs[tab].component || null
}

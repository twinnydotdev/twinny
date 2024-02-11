import { useEffect, useState } from 'react'

import { MESSAGE_KEY, MESSAGE_NAME } from '../constants'
import { ClientMessage, LanguageType, ServerMessage, ThemeType } from '../extension/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any

export const useSelection = (onSelect?: () => void) => {
  const [selection, setSelection] = useState('')
  const handler = (event: MessageEvent) => {
    const message: ServerMessage = event.data
    if (message?.type === MESSAGE_NAME.twinnyTextSelection) {
      setSelection(message?.value.completion.trim())
      onSelect?.()
    }
  }

  useEffect(() => {
    window.addEventListener('message', handler)
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyTextSelection
    })
    return () => window.removeEventListener('message', handler)
  }, [])

  return selection
}

export const useGlobalContext = <T>(key: string) => {
  const [context, setContext] = useState<T>()

  const handler = (event: MessageEvent) => {
    const message: ServerMessage = event.data
    if (message?.type === `${MESSAGE_NAME.twinnyGlobalContext}-${key}`) {
      setContext(event.data.value)
    }
  }

  useEffect(() => {
    window.addEventListener('message', handler)
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyGlobalContext,
      key
    })

    return () => window.removeEventListener('message', handler)
  }, [])

  return { context, setContext }
}

export const useWorkSpaceContext = <T>(key: string) => {
  const [context, setContext] = useState<T>()

  const handler = (event: MessageEvent) => {
    const message: ServerMessage = event.data
    if (message?.type === `${MESSAGE_NAME.twinnyWorkspaceContext}-${key}`) {
      setContext(event.data.value)
    }
  }

  useEffect(() => {
    window.addEventListener('message', handler)
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyWorkspaceContext,
      key
    })

    return () => window.removeEventListener('message', handler)
  }, [])

  return context
}

export const useTheme = () => {
  const [theme, setTheme] = useState<ThemeType | undefined>()
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<ThemeType> = event.data
    if (message?.type === MESSAGE_NAME.twinnySendTheme) {
      setTheme(message?.value.data)
    }
    return () => window.removeEventListener('message', handler)
  }
  useEffect(() => {
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnySendTheme
    })
    window.addEventListener('message', handler)
  }, [])
  return theme
}

export const useLanguage = (): LanguageType | undefined => {
  const [language, setLanguage] = useState<LanguageType | undefined>()
  const handler = (event: MessageEvent) => {
    const message: ServerMessage = event.data
    if (message?.type === MESSAGE_NAME.twinnySendLanguage) {
      setLanguage(message?.value.data)
    }
    return () => window.removeEventListener('message', handler)
  }
  useEffect(() => {
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnySendLanguage
    })
    window.addEventListener('message', handler)
  }, [])
  return language
}

export const useTemplates = () => {
  const [templates, setTemplates] = useState<string[]>()
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<string[]> = event.data
    if (message?.type === MESSAGE_NAME.twinnyListTemplates) {
      setTemplates(message?.value.data)
    }
    return () => window.removeEventListener('message', handler)
  }

  const saveTemplates = (templates: string[]) => {
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnySetWorkspaceContext,
      key: MESSAGE_KEY.selectedTemplates,
      data: templates
    } as ClientMessage<string[]>)
  }

  useEffect(() => {
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyListTemplates
    })
    window.addEventListener('message', handler)
  }, [])
  return { templates, saveTemplates }
}

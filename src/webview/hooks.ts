import { useEffect, useState } from 'react'

import { MESSAGE_KEY, MESSAGE_NAME, SETTING_KEY } from '../constants'
import {
  ClientMessage,
  LanguageType,
  OllamaModel,
  ServerMessage,
  ThemeType
} from '../extension/types'

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

export const useConfigurationSetting = (key: string) => {
  const [configurationSetting, setConfigurationSettings] = useState<
    string | boolean | number
  >()

  const handler = (event: MessageEvent) => {
    const message: ServerMessage<string | boolean | number> = event.data
    if (
      message?.type === MESSAGE_NAME.twinnyGetConfigValue &&
      message.value.type === key
    ) {
      setConfigurationSettings(message?.value.data)
    }
  }

  useEffect(() => {
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyGetConfigValue,
      key
    })
    window.addEventListener('message', handler)
  }, [key])

  return { configurationSetting }
}

export const useOllamaModels = () => {
  const [models, setModels] = useState<OllamaModel[] | undefined>([])
  const [chatModelName, setChatModel] = useState<string>()
  const [fimModelName, setFimModel] = useState<string>()
  const configValueKeys = [SETTING_KEY.chatModelName, SETTING_KEY.fimModelName]
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<OllamaModel[]> = event.data
    if (message?.type === MESSAGE_NAME.twinnyFetchOllamaModels) {
      setModels(message?.value.data)
    }
    if (
      message?.type === MESSAGE_NAME.twinnyGetConfigValue &&
      message.value.type === SETTING_KEY.chatModelName
    ) {
      setChatModel(message?.value.data as string | undefined)
    }
    if (
      message?.type === MESSAGE_NAME.twinnyGetConfigValue &&
      message.value.type === SETTING_KEY.fimModelName
    ) {
      setFimModel(message?.value.data as string | undefined)
    }
    return () => window.removeEventListener('message', handler)
  }

  const saveModel = (model: string) => (type: string) => {
    if (type === SETTING_KEY.chatModelName) setChatModel(model)
    if (type === SETTING_KEY.fimModelName) setFimModel(model)
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnySetConfigValue,
      key: type,
      data: model
    } as ClientMessage<string>)
  }

  useEffect(() => {
    configValueKeys.forEach((key: string) => {
      global.vscode.postMessage({
        type: MESSAGE_NAME.twinnyGetConfigValue,
        key
      })
    })
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyFetchOllamaModels
    })
    window.addEventListener('message', handler)
  }, [chatModelName, fimModelName])
  return { models, setModels, saveModel, chatModelName, fimModelName }
}

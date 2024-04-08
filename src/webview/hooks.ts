import { useEffect, useState } from 'react'

import { MESSAGE_KEY, MESSAGE_NAME, SETTING_KEY } from '../common/constants'
import {
  ClientMessage,
  LanguageType,
  ApiModel,
  ServerMessage,
  ThemeType
} from '../common/types'
import {
  PROVIDER_MESSAGE_TYPE,
  TwinnyProvider
} from '../extension/provider-manager'

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

export const useProviders = () => {
  const [providers, setProviders] = useState<Record<string, TwinnyProvider>>({})
  const [chatProvider, setChatProvider] = useState<TwinnyProvider>()
  const [fimProvider, setFimProvider] = useState<TwinnyProvider>()
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<
      Record<string, TwinnyProvider> | TwinnyProvider
    > = event.data
    if (message?.type === PROVIDER_MESSAGE_TYPE.getAllProviders) {
      if (message.value.data) {
        const providers = message.value.data as Record<string, TwinnyProvider>
        setProviders(providers)
      }
    }
    if (message?.type === PROVIDER_MESSAGE_TYPE.getActiveChatProvider) {
      if (message.value.data) {
        const provider = message.value.data as TwinnyProvider
        setChatProvider(provider)
      }
    }
    if (message?.type === PROVIDER_MESSAGE_TYPE.getActiveFimProvider) {
      if (message.value.data) {
        const provider = message.value.data as TwinnyProvider
        setFimProvider(provider)
      }
    }
    return () => window.removeEventListener('message', handler)
  }

  const saveProvider = (provider: TwinnyProvider) => {
    global.vscode.postMessage({
      type: PROVIDER_MESSAGE_TYPE.addProvider,
      data: provider
    } as ClientMessage<TwinnyProvider>)
  }

  const copyProvider = (provider: TwinnyProvider) => {
    global.vscode.postMessage({
      type: PROVIDER_MESSAGE_TYPE.copyProvider,
      data: provider
    } as ClientMessage<TwinnyProvider>)
  }

  const updateProvider = (provider: TwinnyProvider) => {
    global.vscode.postMessage({
      type: PROVIDER_MESSAGE_TYPE.updateProvider,
      data: provider
    } as ClientMessage<TwinnyProvider>)
  }

  const removeProvider = (provider: TwinnyProvider) => {
    global.vscode.postMessage({
      type: PROVIDER_MESSAGE_TYPE.removeProvider,
      data: provider
    } as ClientMessage<TwinnyProvider>)
  }

  const setActiveFimProvider = (provider: TwinnyProvider) => {
    global.vscode.postMessage({
      type: PROVIDER_MESSAGE_TYPE.setActiveFimProvider,
      data: provider
    } as ClientMessage<TwinnyProvider>)
  }

  const setActiveChatProvider = (provider: TwinnyProvider) => {
    global.vscode.postMessage({
      type: PROVIDER_MESSAGE_TYPE.setActiveChatProvider,
      data: provider
    } as ClientMessage<TwinnyProvider>)
  }

  const getFimProvidersByType = (type: string) => {
    return Object.values(providers).filter(
      (provider) => provider.type === type
    ) as TwinnyProvider[]
  }

  const resetProviders = () => {
    global.vscode.postMessage({
      type: PROVIDER_MESSAGE_TYPE.resetProvidersToDefaults
    } as ClientMessage<TwinnyProvider>)
  }

  useEffect(() => {
    global.vscode.postMessage({
      type: PROVIDER_MESSAGE_TYPE.getAllProviders
    })
    global.vscode.postMessage({
      type: PROVIDER_MESSAGE_TYPE.getActiveChatProvider
    })
    global.vscode.postMessage({
      type: PROVIDER_MESSAGE_TYPE.getActiveFimProvider
    })
    window.addEventListener('message', handler)
  }, [])

  return {
    providers,
    chatProvider,
    fimProvider,
    saveProvider,
    copyProvider,
    resetProviders,
    updateProvider,
    removeProvider,
    setActiveFimProvider,
    setActiveChatProvider,
    getFimProvidersByType
  }
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

export const useModels = () => {
  const [models, setModels] = useState<ApiModel[] | undefined>([])
  const [chatModelName, setChatModel] = useState<string>()
  const [fimModelName, setFimModel] = useState<string>()
  const configValueKeys = [SETTING_KEY.chatModelName, SETTING_KEY.fimModelName]
  const handler = (event: MessageEvent) => {
    const message: ServerMessage<ApiModel[]> = event.data
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
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnySetConfigValue,
      key: type,
      data: model
    } as ClientMessage<string>)
    if (type === SETTING_KEY.chatModelName) {
      setChatModel(model)
    }
    if (type === SETTING_KEY.fimModelName) {
      setFimModel(model)
    }
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
  }, [])

  return { models, setModels, saveModel, chatModelName, fimModelName }
}

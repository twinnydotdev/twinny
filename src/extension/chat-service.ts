import {
  StatusBarItem,
  WebviewView,
  commands,
  window,
  workspace,
  ExtensionContext
} from 'vscode'

import { CONTEXT_NAME, MESSAGE_NAME, UI_TABS, USER } from '../common/constants'
import {
  StreamResponse,
  StreamBodyBase,
  ServerMessage,
  TemplateData,
  ChatTemplateData,
  Message,
  StreamRequestOptions
} from '../common/types'
import { getChatDataFromProvider, getLanguage } from './utils'
import { CodeLanguageDetails } from '../common/languages'
import { TemplateProvider } from './template-provider'
import { streamResponse } from './stream'
import { createStreamRequestBody } from './provider-options'
import { kebabToSentence } from '../webview/utils'
import { ACTIVE_CHAT_PROVIDER_KEY, TwinnyProvider } from './provider-manager'

export class ChatService {
  private _config = workspace.getConfiguration('twinny')
  private _completion = ''
  private _controller?: AbortController
  private _extensionContext?: ExtensionContext
  private _keepAlive = this._config.get('keepAlive') as string | number
  private _numPredictChat = this._config.get('numPredictChat') as number
  private _promptTemplate = ''
  private _statusBar: StatusBarItem
  private _temperature = this._config.get('temperature') as number
  private _templateProvider?: TemplateProvider
  private _view?: WebviewView

  constructor(
    statusBar: StatusBarItem,
    templateDir: string,
    extensionContext: ExtensionContext,
    view?: WebviewView
  ) {
    this._view = view
    this._statusBar = statusBar
    this._templateProvider = new TemplateProvider(templateDir)
    this._extensionContext = extensionContext
    workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('twinny')) {
        return
      }
      this.updateConfig()
    })
  }

  private getProvider = () => {
    const provider = this._extensionContext?.globalState.get<TwinnyProvider>(
      ACTIVE_CHAT_PROVIDER_KEY
    )
    return provider
  }

  private buildStreamRequest(
    prompt: string,
    messages?: Message[] | Message[]
  ) {
    const provider = this.getProvider()

    if (!provider) return

    const requestOptions: StreamRequestOptions = {
      hostname: provider.apiHostname,
      port: Number(provider.apiPort),
      path: provider.apiPath,
      protocol: provider.apiProtocol,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`
      }
    }

    const requestBody = createStreamRequestBody(provider.provider, prompt, {
      model: provider.modelName,
      numPredictChat: this._numPredictChat,
      temperature: this._temperature,
      messages,
      keepAlive: this._keepAlive
    })

    return { requestOptions, requestBody }
  }

  private onStreamData = (
    streamResponse: StreamResponse | undefined,
    onEnd?: (completion: string) => void
  ) => {
    const provider = this.getProvider()
    if (!provider) return

    try {
      const data = getChatDataFromProvider(provider.provider, streamResponse)
      this._completion = this._completion + data
      if (onEnd) return
      this._view?.webview.postMessage({
        type: MESSAGE_NAME.twinnyOnCompletion,
        value: {
          completion: this._completion.trimStart(),
          data: getLanguage(),
          type: this._promptTemplate
        }
      } as ServerMessage)
    } catch (error) {
      console.error('Error parsing JSON:', error)
      return
    }
  }

  private onStreamEnd = (onEnd?: (completion: string) => void) => {
    this._statusBar.text = '🤖'
    commands.executeCommand(
      'setContext',
      CONTEXT_NAME.twinnyGeneratingText,
      false
    )
    if (onEnd) {
      onEnd(this._completion)
      this._view?.webview.postMessage({
        type: MESSAGE_NAME.twinnyOnEnd
      } as ServerMessage)
      return
    }
    this._view?.webview.postMessage({
      type: MESSAGE_NAME.twinnyOnEnd,
      value: {
        completion: this._completion.trimStart(),
        data: getLanguage(),
        type: this._promptTemplate
      }
    } as ServerMessage)
  }

  private onStreamError = (error: Error) => {
    this._view?.webview.postMessage({
      type: MESSAGE_NAME.twinnyOnEnd,
      value: {
        error: true,
        errorMessage: error.message
      }
    } as ServerMessage)
  }

  private onStreamStart = (controller: AbortController) => {
    this._controller = controller
    commands.executeCommand(
      'setContext',
      CONTEXT_NAME.twinnyGeneratingText,
      true
    )
    this._view?.webview.onDidReceiveMessage((data: { type: string }) => {
      if (data.type === MESSAGE_NAME.twinnyStopGeneration) {
        this._controller?.abort()
      }
    })
  }

  public destroyStream = () => {
    this._controller?.abort()
    this._statusBar.text = '🤖'
    commands.executeCommand(
      'setContext',
      CONTEXT_NAME.twinnyGeneratingText,
      true
    )
    this._view?.webview.postMessage({
      type: MESSAGE_NAME.twinnyOnEnd,
      value: {
        completion: this._completion.trimStart(),
        data: getLanguage(),
        type: this._promptTemplate
      }
    } as ServerMessage)
  }

  private buildMesageRoleContent = async (
    messages: Message[],
    language?: CodeLanguageDetails
  ): Promise<Message[]> => {
    const editor = window.activeTextEditor
    const selection = editor?.selection
    const selectionContext = editor?.document.getText(selection) || ''
    const systemMessage = {
      role: 'system',
      content: await this._templateProvider?.readSystemMessageTemplate(
        this._promptTemplate
      )
    }

    if (messages.length > 0 && (language || selectionContext)) {
      const lastMessage = messages[messages.length - 1]

      const detailsToAppend = []

      if (language?.langName) {
        detailsToAppend.push(`Language: ${language.langName}`)
      }

      if (selectionContext) {
        detailsToAppend.push(`Selection: ${selectionContext}`)
      }

      const detailsString = detailsToAppend.length
        ? `\n\n${detailsToAppend.join(': ')}`
        : ''

      const updatedLastMessage = {
        ...lastMessage,
        content: `${lastMessage.content}${detailsString}`
      }

      messages[messages.length - 1] = updatedLastMessage
    }

    return [systemMessage, ...messages]
  }

  private buildChatPrompt = async (messages: Message[]) => {
    const editor = window.activeTextEditor
    const selection = editor?.selection
    const selectionContext = editor?.document.getText(selection) || ''
    const prompt =
      await this._templateProvider?.renderTemplate<ChatTemplateData>('chat', {
        code: selectionContext || '',
        messages,
        role: USER
      })
    return prompt || ''
  }

  private buildTemplatePrompt = async (
    template: string,
    language: CodeLanguageDetails,
    context?: string
  ) => {
    const editor = window.activeTextEditor
    const selection = editor?.selection
    const selectionContext =
      editor?.document.getText(selection) || context || ''
    const prompt = await this._templateProvider?.renderTemplate<TemplateData>(
      template,
      {
        code: selectionContext || '',
        language: language?.langName || 'unknown'
      }
    )
    return { prompt: prompt || '', selection: selectionContext }
  }

  private streamResponse({
    requestBody,
    requestOptions,
    onEnd
  }: {
    requestBody: StreamBodyBase
    requestOptions: StreamRequestOptions
    onEnd?: (completion: string) => void
  }) {
    return streamResponse({
      body: requestBody,
      options: requestOptions,
      onData: (streamResponse: StreamResponse | undefined) =>
        this.onStreamData(streamResponse, onEnd),
      onEnd: () => this.onStreamEnd(onEnd),
      onStart: this.onStreamStart,
      onError: this.onStreamError
    })
  }

  private sendEditorLanguage = () => {
    this._view?.webview.postMessage({
      type: MESSAGE_NAME.twinnySendLanguage,
      value: {
        data: getLanguage()
      }
    } as ServerMessage)
  }

  private focusChatTab = () => {
    this._view?.webview.postMessage({
      type: MESSAGE_NAME.twinnySetTab,
      value: {
        data: UI_TABS.chat
      }
    } as ServerMessage<string>)
  }

  public async streamChatCompletion(messages: Message[]) {
    this._completion = ''
    this.sendEditorLanguage()
    const messageRoleContent = await this.buildMesageRoleContent(messages)
    const prompt = await this.buildChatPrompt(messages)
    const request = this.buildStreamRequest(prompt, messageRoleContent)
    if (!request) return
    const { requestBody, requestOptions } = request
    return this.streamResponse({ requestBody, requestOptions })
  }

  public async streamTemplateCompletion(
    promptTemplate: string,
    context?: string,
    onEnd?: (completion: string) => void
  ) {
    const { language } = getLanguage()
    this._completion = ''
    this._promptTemplate = promptTemplate
    this.sendEditorLanguage()
    this.focusChatTab()
    const { prompt, selection } = await this.buildTemplatePrompt(
      promptTemplate,
      language,
      context
    )
    this._statusBar.text = '$(loading~spin)'
    this._view?.webview.postMessage({
      type: MESSAGE_NAME.twinnyOnLoading
    })
    this._view?.webview.postMessage({
      type: MESSAGE_NAME.twinngAddMessage,
      value: {
        completion:
          kebabToSentence(promptTemplate) + '\n\n' + '```\n' + selection,
        data: getLanguage()
      }
    } as ServerMessage)
    const messageRoleContent = await this.buildMesageRoleContent(
      [
        {
          content: prompt,
          role: 'user'
        }
      ],
      language
    )
    const request = this.buildStreamRequest(prompt, messageRoleContent)
    if (!request) return
    const { requestBody, requestOptions } = request
    return this.streamResponse({ requestBody, requestOptions, onEnd })
  }

  private updateConfig() {
    this._config = workspace.getConfiguration('twinny')
    this._temperature = this._config.get('temperature') as number
    this._keepAlive = this._config.get('keepAlive') as string | number
  }
}

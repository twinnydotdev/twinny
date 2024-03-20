import { StatusBarItem, WebviewView, commands, window, workspace } from 'vscode'

import { CONTEXT_NAME, MESSAGE_NAME, UI_TABS, USER } from '../common/constants'
import {
  StreamResponse,
  StreamBodyBase,
  ServerMessage,
  MessageType,
  TemplateData,
  ChatTemplateData,
  MessageRoleContent,
  StreamRequestOptions
} from '../common/types'
import { getChatDataFromProvider, getLanguage } from './utils'
import { CodeLanguageDetails } from '../common/languages'
import { TemplateProvider } from './template-provider'
import { streamResponse } from './stream'
import { createStreamRequestBody } from './provider-options'
import { kebabToSentence } from '../webview/utils'

export class ChatService {
  private _config = workspace.getConfiguration('twinny')
  private _apiHostname = this._config.get('apiHostname') as string
  private _apiPath = this._config.get('chatApiPath') as string
  private _apiProvider = this._config.get('apiProvider') as string
  private _bearerToken = this._config.get('apiBearerToken') as string
  private _chatModel = this._config.get('chatModelName') as string
  private _completion = ''
  private _controller?: AbortController
  private _keepAlive = this._config.get('keepAlive') as string | number
  private _numPredictChat = this._config.get('numPredictChat') as number
  private _port = this._config.get('chatApiPort') as string
  private _promptTemplate = ''
  private _statusBar: StatusBarItem
  private _temperature = this._config.get('temperature') as number
  private _templateProvider?: TemplateProvider
  private _useTls = this._config.get('useTls') as boolean
  private _view?: WebviewView

  constructor(
    statusBar: StatusBarItem,
    templateDir: string,
    view?: WebviewView
  ) {
    this._view = view
    this._statusBar = statusBar
    this._templateProvider = new TemplateProvider(templateDir)
    workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('twinny')) {
        return
      }
      this.updateConfig()
    })
  }

  private buildStreamRequest(
    prompt: string,
    messages?: MessageType[] | MessageRoleContent[]
  ) {
    const requestOptions: StreamRequestOptions = {
      hostname: this._apiHostname,
      port: this._port,
      path: this._apiPath,
      protocol: this._useTls ? 'https' : 'http',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._bearerToken}`
      }
    }

    const requestBody = createStreamRequestBody(this._apiProvider, prompt, {
      model: this._chatModel,
      numPredictChat: this._numPredictChat,
      temperature: this._temperature,
      messages,
      keepAlive: this._keepAlive
    })

    return { requestOptions, requestBody }
  }

  private onStreamData = (streamResponse: StreamResponse | undefined) => {
    try {
      const data = getChatDataFromProvider(this._apiProvider, streamResponse)
      this._completion = this._completion + data
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

  private onStreamEnd = () => {
    this._statusBar.text = '🤖'
    commands.executeCommand(
      'setContext',
      CONTEXT_NAME.twinnyGeneratingText,
      false
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
    this._statusBar.text = '$(loading~spin)'
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
    messages: MessageType[],
    language?: CodeLanguageDetails
  ): Promise<MessageRoleContent[]> => {
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

  private buildChatPrompt = async (messages: MessageType[]) => {
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
    const selectionContext = editor?.document.getText(selection) || context || ''
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
    requestOptions
  }: {
    requestBody: StreamBodyBase
    requestOptions: StreamRequestOptions
  }) {
    return streamResponse({
      body: requestBody,
      options: requestOptions,
      onData: this.onStreamData,
      onEnd: this.onStreamEnd,
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

  public async streamChatCompletion(messages: MessageType[]) {
    this._completion = ''
    this.sendEditorLanguage()
    const messageRoleContent = await this.buildMesageRoleContent(messages)
    const prompt = await this.buildChatPrompt(messages)
    const { requestBody, requestOptions } = this.buildStreamRequest(
      prompt,
      messageRoleContent
    )
    return this.streamResponse({ requestBody, requestOptions })
  }

  public async streamTemplateCompletion(promptTemplate: string, context?: string) {
    const { language } = getLanguage()
    this._completion = ''
    this._promptTemplate = promptTemplate
    this.sendEditorLanguage()
    this.focusChatTab()
    this._view?.webview.postMessage({
      type: MESSAGE_NAME.twinnyOnLoading
    })
    const { prompt, selection } = await this.buildTemplatePrompt(
      promptTemplate,
      language,
      context,
    )
    this._view?.webview.postMessage({
      type: MESSAGE_NAME.twinngAddMessage,
      value: {
        completion:
          kebabToSentence(promptTemplate) + '\n\n' + '```\n' + selection,
        data: getLanguage(),
        type: this._promptTemplate
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
    const { requestBody, requestOptions } = this.buildStreamRequest(
      prompt,
      messageRoleContent
    )
    return this.streamResponse({ requestBody, requestOptions })
  }

  private updateConfig() {
    this._config = workspace.getConfiguration('twinny')
    this._temperature = this._config.get('temperature') as number
    this._chatModel = this._config.get('chatModelName') as string
    this._apiPath = this._config.get('chatApiPath') as string
    this._port = this._config.get('chatApiPort') as string
    this._apiHostname = this._config.get('apiHostname') as string
    this._apiProvider = this._config.get('apiProvider') as string
    this._keepAlive = this._config.get('keepAlive') as string | number
    this._useTls = this._config.get('useTls') as boolean
  }
}

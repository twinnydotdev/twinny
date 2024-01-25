import { ClientRequest } from 'http'
import { RequestOptions } from 'https'
import { StatusBarItem, WebviewView, window, workspace } from 'vscode'

import { chatMessage } from './prompts'
import { MESSAGE_NAME, prompts } from './constants'
import { StreamResponse, StreamOptions } from './types'
import { getLanguage, streamResponse } from './utils'

export class StreamService {
  private _config = workspace.getConfiguration('twinny')
  private _apiUrl = this._config.get('apiUrl') as string
  private _bearerToken = this._config.get('apiBearerToken') as string
  private _chatModel = this._config.get('chatModelName') as string
  private _completion = ''
  private _numPredictChat = this._config.get('numPredictChat') as number
  private _port = this._config.get('chatApiPort') as string
  private _apiPath = this._config.get('chatApiPath') as string
  private _temperature = this._config.get('temperature') as number
  private _view?: WebviewView
  private _statusBar: StatusBarItem

  constructor(statusBar: StatusBarItem, view?: WebviewView) {
    this._view = view
    this._statusBar = statusBar

    workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('twinny')) {
        return
      }
      this.updateConfig()
    })
  }

  private buildStreamRequest(prompt: string) {
    const headers: Record<string, string> = {}

    if (this._bearerToken) {
      headers.Authorization = `Bearer ${this._bearerToken}`
    }

    const requestBody: StreamOptions = {
      model: this._chatModel,
      prompt,
      stream: true,
      n_predict: this._numPredictChat,
      temperature: this._temperature,
      // Ollama
      options: {
        temperature: this._temperature,
        num_predict: this._numPredictChat
      }
    }

    const requestOptions: RequestOptions = {
      hostname: this._apiUrl,
      port: this._port,
      path: this._apiPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._bearerToken}`
      }
    }

    return { requestOptions, requestBody }
  }

  private onStreamData = (
    streamResponse: StreamResponse | undefined,
    onDestroy: () => void
  ) => {
    try {
      const data = streamResponse?.response || streamResponse?.content

      if (!data) {
        return
      }

      this._completion = this._completion + data

      this._view?.webview.postMessage({
        type: MESSAGE_NAME.twinnyOnCompletion,
        value: {
          completion: this._completion.trimStart()
        }
      })
      if (data?.match('<EOT>')) {
        onDestroy()
      }
    } catch (error) {
      console.error('Error parsing JSON:', error)
      return
    }
  }

  private onStreamEnd = () => {
    this._statusBar.text = '🤖'
    this._view?.webview.postMessage({
      type: MESSAGE_NAME.twinnyOnEnd,
      value: {
        completion: this._completion.trimStart()
      }
    })
  }

  private onStreamStart = (req: ClientRequest) => {
    this._statusBar.text = '$(loading~spin)'
    this._view?.webview.onDidReceiveMessage((data: { type: string }) => {
      if (data.type === MESSAGE_NAME.twinnyStopGeneration) {
        req.destroy()
      }
    })
  }

  public buildChatMessagePrompt = (messages: Message[]) => {
    const editor = window.activeTextEditor
    const selection = editor?.selection
    const selectionContext = editor?.document.getText(selection) || ''
    return chatMessage(messages, selectionContext)
  }

  public buildTemplatePrompt = (template: string, message: string) => {
    const editor = window.activeTextEditor
    const selection = editor?.selection
    const selectionContext = editor?.document.getText(selection) || ''
    return prompts[template] ? prompts[template](selectionContext) : message
  }

  private streamResponse({
    requestBody,
    requestOptions
  }: {
    requestBody: StreamOptions
    requestOptions: RequestOptions
  }) {
    this._view?.webview.postMessage({
      type: MESSAGE_NAME.twinnyOnLoading
    })

    return streamResponse({
      body: requestBody,
      options: requestOptions,
      onData: this.onStreamData,
      onEnd: this.onStreamEnd,
      onStart: this.onStreamStart
    })
  }

  private sendEditorLanguage = () => {
    this._view?.webview.postMessage({
      type: MESSAGE_NAME.twinnySendLanguage,
      value: {
        data: getLanguage()
      }
    } as PostMessage)
  }

  public streamChatCompletion(messages: Message[]) {
    this._completion = ''
    this.sendEditorLanguage()
    const prompt = this.buildChatMessagePrompt(messages)
    const { requestBody, requestOptions } = this.buildStreamRequest(prompt)
    return this.streamResponse({ requestBody, requestOptions })
  }

  public streamTemplateCompletion(promptTemplate: string, context = '') {
    this._completion = ''
    this.sendEditorLanguage()
    const prompt = this.buildTemplatePrompt(promptTemplate, context)
    const { requestBody, requestOptions } = this.buildStreamRequest(prompt)
    return this.streamResponse({ requestBody, requestOptions })
  }

  public updateConfig() {
    this._config = workspace.getConfiguration('twinny')
    this._temperature = this._config.get('temperature') as number
    this._chatModel = this._config.get('chatModelName') as string
    this._apiPath = this._config.get('chatApiPath') as string
    this._port = this._config.get('chatApiPort') as string
    this._apiUrl = this._config.get('apiUrl') as string
  }
}

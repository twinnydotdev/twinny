import { ClientRequest } from 'http'
import { RequestOptions } from 'https'
import { StatusBarItem, WebviewView, window, workspace } from 'vscode'

import { chatMessageDeepSeek, chatMessageLlama } from './prompts'
import { MESSAGE_NAME, MODEL, prompts } from './constants'
import { OllamStreamResponse, StreamBody } from './types'
import { getIsModelAvailable, getPromptModel, streamResponse } from './utils'

export class StreamService {
  private _config = workspace.getConfiguration('twinny')
  private _baseUrl = this._config.get('baseUrl') as string
  private _bearerToken = this._config.get('apiBearerToken') as string
  private _chatModel = this._config.get('chatModelName') as string
  private _completion = ''
  private _isModelAvailable = true
  private _numPredictChat = this._config.get('numPredictChat') as number
  private _port = this._config.get('apiPort') as string
  private _apiPath = this._config.get('apiPath') as string
  private _temperature = this._config.get('temperature') as number
  private _view?: WebviewView
  private _statusBar: StatusBarItem

  constructor(statusBar: StatusBarItem, view?: WebviewView) {
    this._view = view
    this._statusBar = statusBar
    this.setModelAvailability()

    workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('twinny')) {
        return
      }
      this.updateConfig()
    })
  }

  private setModelAvailability = async () => {
    this._isModelAvailable = await getIsModelAvailable(this._chatModel)
  }

  private buildStreamRequest(prompt: string) {
    const headers: Record<string, string> = {}

    if (this._bearerToken) {
      headers.Authorization = `Bearer ${this._bearerToken}`
    }

    const requestBody: StreamBody = {
      model: this._chatModel,
      prompt,
      stream: true,
      options: {
        temperature: this._temperature,
        num_predict: this._numPredictChat
      }
    }

    const requestOptions: RequestOptions = {
      hostname: this._baseUrl,
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

  private onStreamData = (json: OllamStreamResponse, onDestroy: () => void) => {
    try {
      const data = json.response || json.content
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
        completion: this._completion.trimStart(),
        error: !this._isModelAvailable
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
    const modelType = getPromptModel(this._chatModel)
    if (this._chatModel.includes(MODEL.deepseek)) {
      return chatMessageDeepSeek(messages, selectionContext, modelType)
    }
    return chatMessageLlama(messages, selectionContext, modelType)
  }

  public buildTemplatePrompt = (template: string, message: string) => {
    const editor = window.activeTextEditor
    const selection = editor?.selection
    const selectionContext = editor?.document.getText(selection) || ''
    const modelType = getPromptModel(this._chatModel)
    return prompts[template]
      ? prompts[template](selectionContext, modelType)
      : message
  }

  private streamResponse({
    requestBody,
    requestOptions
  }: {
    requestBody: StreamBody
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

  public streamChatCompletion(messages: Message[]) {
    this._completion = ''
    const prompt = this.buildChatMessagePrompt(messages)
    const { requestBody, requestOptions } = this.buildStreamRequest(prompt)
    return this.streamResponse({ requestBody, requestOptions })
  }

  public streamTemplateCompletion(promptTemplate: string, context = '') {
    this._completion = ''
    const prompt = this.buildTemplatePrompt(promptTemplate, context)
    const { requestBody, requestOptions } = this.buildStreamRequest(prompt)
    return this.streamResponse({ requestBody, requestOptions })
  }

  public updateConfig() {
    this._config = workspace.getConfiguration('twinny')
    this._temperature = this._config.get('temperature') as number
    this._chatModel = this._config.get('chatModelName') as string
    this._apiPath = this._config.get('apiPath') as string
    this._port = this._config.get('apiPort') as string
    this._baseUrl = this._config.get('baseUrl') as string
  }
}

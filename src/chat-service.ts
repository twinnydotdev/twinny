import { ClientRequest } from 'http'
import { RequestOptions } from 'https'
import { WebviewView, window, workspace } from 'vscode'

import {
  chatMessageDeepSeek,
  chatMessageLlama,
} from './prompts'
import { MESSAGE_NAME, MODEL, prompts } from './constants'
import { StreamBody } from './types'
import { getPromptModel, streamResponse } from './utils'

export class ChatService {
  private _config = workspace.getConfiguration('twinny')
  private _baseUrl = this._config.get('ollamaBaseUrl') as string
  private _bearerToken = this._config.get('ollamaApiBearerToken') as string
  private _chatModel = this._config.get('chatModelName') as string
  private _completion = ''
  private _port = this._config.get('ollamaApiPort') as string
  private _view?: WebviewView

  constructor(view?: WebviewView) {
    this._view = view
  }

  private buildStreamRequest(prompt: string) {
    const headers: Record<string, string> = {}

    if (this._bearerToken) {
      headers.Authorization = `Bearer ${this._bearerToken}`
    }

    const requestBody: StreamBody = {
      model: this._chatModel,
      prompt,
      options: {
        temperature: this._config.get('temperature') as number
      }
    }

    const requestOptions: RequestOptions = {
      hostname: this._baseUrl,
      port: this._port,
      path: '/api/generate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._bearerToken}`
      }
    }

    return { requestOptions, requestBody }
  }

  private onStreamData = (chunk: string, onDestroy: () => void) => {
    try {
      const json = JSON.parse(chunk)

      this._completion = this._completion + json.response

      this._view?.webview.postMessage({
        type: MESSAGE_NAME.twinnyOnCompletion,
        value: {
          completion: this._completion.trimStart()
        }
      })
      if (json.response.match('<EOT>')) {
        onDestroy()
      }
    } catch (error) {
      console.error('Error parsing JSON:', error)
      return
    }
  }

  private onStreamEnd = () => {
    this._view?.webview.postMessage({
      type: MESSAGE_NAME.twinnyOnEnd,
      value: {
        completion: this._completion.trimStart()
      }
    })
  }

  private onStreamStart = (req: ClientRequest) => {
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
}

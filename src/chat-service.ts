import { WebviewView, window, workspace } from 'vscode'
import { MESSAGE_NAME } from './constants'
import { buildPrompt } from './prompts'
import { streamResponse } from './utils'
import { ClientRequest } from 'http'
import { RequestOptions } from 'https'
import { StreamBody } from './types'

export class ChatService {
  private _config = workspace.getConfiguration('twinny')
  private _baseUrl = this._config.get('ollamaBaseUrl') as string
  private _bearerToken = this._config.get('ollamaApiBearerToken') as string
  private _chatModel = this._config.get('chatModelName') as string
  private _completion = ''
  private _port = this._config.get('ollamaApiPort') as string
  private _template = ''
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
          type: this._template,
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
        type: this._template,
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

  public streamChatCompletion(
    template: string,
    getPrompt?: (context: string) => string
  ) {
    this._template = template
    const editor = window.activeTextEditor
    const selection = editor?.selection
    const context = editor?.document.getText(selection) || ''
    this._completion = ''

    const prompt = getPrompt
      ? getPrompt(context)
      : buildPrompt(this._chatModel, context, template)

    const { requestBody, requestOptions } = this.buildStreamRequest(prompt)

    this._view?.webview.postMessage({
      type: MESSAGE_NAME.twinnyOnLoading
    })

    streamResponse({
      body: requestBody,
      options: requestOptions,
      onData: this.onStreamData,
      onEnd: this.onStreamEnd,
      onStart: this.onStreamStart
    })
  }
}

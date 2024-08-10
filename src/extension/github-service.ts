import { ExtensionContext, WebviewView, workspace } from 'vscode'
import { streamResponse } from './stream'
import { getChatDataFromProvider, getLanguage } from './utils'
import {
  Message,
  ServerMessage,
  StreamBodyBase,
  StreamRequestOptions
} from '../common/types'
import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  EVENT_NAME,
  WEBUI_TABS,
  getPullRequestDescription
} from '../common/constants'
import { TwinnyProvider } from './provider-manager'
import { createStreamRequestBody } from './provider-options'

export class GithubService {
  private _context: ExtensionContext
  private _config = workspace.getConfiguration('twinny')
  private _githubToken = this._config.get('githubToken') as string
  private _keepAlive = this._config.get('keepAlive') as string | number
  private _temperature = this._config.get('temperature') as number
  private _view: WebviewView
  private _completion = ''

  constructor(context: ExtensionContext, webviewView: WebviewView) {
    this._context = context
    this._view = webviewView
  }

  getHeaders() {
    return {
      Authorization: `Bearer ${this._githubToken}`,
      Accept: 'application/vnd.github.v3.diff'
    }
  }

  private focusChatTab = () => {
    this._view?.webview.postMessage({
      type: EVENT_NAME.twinnySetTab,
      value: {
        data: WEBUI_TABS.chat
      }
    } as ServerMessage<string>)
  }

  async getPullRequests(owner: string, repo: string) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls`
    const response = await fetch(url)
    return response.json()
  }

  async getPullRequestReview(owner: string, repo: string, number: number) {
    const headers = this.getHeaders()
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`
    const response = await fetch(url, {
      headers
    })
    const diff = await response.text()
    const request = this.buildStreamRequest([
      {
        role: 'system',
        content: `
        You are a highly skilled software engineer specializing in code reviews.
        Your task is to review code changes in a unidiff format.
        Ensure your feedback is constructive and professional.
        `.trim()
      },
      {
        role: 'user',
        content: getPullRequestDescription(diff).trim()
      }
    ])
    if (!request) return

    this.focusChatTab()
      this._view?.webview.postMessage({
        type: EVENT_NAME.twinnyOnLoading
      })
      this._view?.webview.postMessage({
        type: EVENT_NAME.twinngAddMessage,
        value: {
          completion: diff,
          data: getLanguage()
        }
      } as ServerMessage)

    setTimeout(async () => {
      await this.streamCodeReview(request)
    }, 500)
  }

  streamCodeReview({
    requestBody,
    requestOptions
  }: {
    requestBody: StreamBodyBase
    requestOptions: StreamRequestOptions
    onEnd?: (completion: string) => void
  }): Promise<string> {
    const provider = this.getProvider()

    if (!provider) return Promise.resolve('')

    return new Promise((resolve, reject) => {
      try {
        return streamResponse({
          body: requestBody,
          options: requestOptions,
          onData: (streamResponse) => {
            const provider = this.getProvider()
            if (!provider) return

            try {
              const data = getChatDataFromProvider(
                provider.provider,
                streamResponse
              )
              this._completion = this._completion + data
              this._view?.webview.postMessage({
                type: EVENT_NAME.twinnyOnCompletion,
                value: {
                  completion: this._completion.trimStart()
                }
              } as ServerMessage)
            } catch (error) {
              console.error('Error parsing JSON:', error)
              return
            }
          },
          onEnd: () => {
            return resolve(this._completion)
          }
        })
      } catch (e) {
        return reject(e)
      }
    })
  }

  private getProvider = () => {
    return this._context?.globalState.get<TwinnyProvider>(
      ACTIVE_CHAT_PROVIDER_STORAGE_KEY
    )
  }

  private buildStreamRequest(messages?: Message[]) {
    const provider = this.getProvider()

    if (!provider || !messages?.length) return

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

    const requestBody = createStreamRequestBody(provider.provider, '', {
      model: provider.modelName,
      numPredictChat: 100,
      temperature: this._temperature,
      messages,
      keepAlive: this._keepAlive
    })

    return { requestOptions, requestBody }
  }
}

import { commands, ExtensionContext, Webview } from "vscode"

import {
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  GITHUB_EVENT_NAME,
  USER,
  WEBUI_TABS,
} from "../common/constants"
import {
  ClientMessage,
  RequestBodyBase,
  ServerMessage,
  StreamRequestOptions,
  StreamResponse,
  TemplateData,
} from "../common/types"

import { streamResponse } from "./api"
import { ConversationHistory } from "./conversation-history"
import { SessionManager } from "./session-manager"
import { SymmetryService } from "./symmetry-service"
import { TemplateProvider } from "./template-provider"
import { getChatDataFromProvider, updateLoadingMessage } from "./utils"

export class GithubService extends ConversationHistory {
  private _completion = ""
  private _templateProvider: TemplateProvider
  private _controller?: AbortController

  constructor(
    context: ExtensionContext,
    webView: Webview,
    sessionManager: SessionManager | undefined,
    symmetryService: SymmetryService,
    templateDir: string | undefined
  ) {
    super(context, webView, sessionManager, symmetryService)
    this._templateProvider = new TemplateProvider(templateDir)
  }

  setUpEventListeners() {
    this.webView.onDidReceiveMessage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (message: ClientMessage<any>) => {
        switch (message.type) {
          case GITHUB_EVENT_NAME.getPullRequests:
            this.handleGetPullRequests(message.data)
            break
          case GITHUB_EVENT_NAME.getPullRequestReview:
            this.handleGetPullRequestReview(message.data)
            break
        }
      }
    )
  }

  private async loadReviewTemplate(diff: string): Promise<string> {
    return await this._templateProvider.readTemplate<TemplateData>("review", {
      code: diff,
    })
  }

  private async handleGetPullRequests(
    data: { owner: string; repo: string } | undefined
  ) {
    if (!data) return
    const prs = await this.getPullRequests(data.owner, data.repo)
    this.webView.postMessage({
      type: GITHUB_EVENT_NAME.getPullRequests,
      value: { data: prs },
    })
  }

  private async handleGetPullRequestReview(
    data:
      | {
          owner: string
          repo: string
          number: number
          title: string
        }
      | undefined
  ) {
    if (!data) return

    const review = await this.getPullRequestReview(
      data.owner,
      data.repo,
      data.number,
      data.title
    )
    this.webView.postMessage({
      type: GITHUB_EVENT_NAME.getPullRequestReview,
      value: { data: review },
    })
  }

  getHeaders() {
    return {
      Authorization: `Bearer ${this.config.githubToken}`,
      Accept: "application/vnd.github.v3.diff",
    }
  }

  private focusChatTab = () => {
    this.webView.postMessage({
      type: EVENT_NAME.twinnySetTab,
      value: {
        data: WEBUI_TABS.chat,
      },
    } as ServerMessage<string>)
  }

  async getPullRequests(owner: string, repo: string) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls`
    const response = await fetch(url, {
      headers: this.getHeaders(),
    })
    return response.json()
  }

  async getPullRequestReview(
    owner: string,
    repo: string,
    number: number,
    title: string
  ) {
    const headers = this.getHeaders()
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`
    const response = await fetch(url, {
      headers,
    })
    const diff = await response.text()
    const prompt = await this.loadReviewTemplate(`${title} \n\n ${diff}`)

    const messages = [
      {
        role: USER,
        content: prompt,
      },
    ]

    const request = this.buildStreamRequest(messages)

    if (!request) return

    this.focusChatTab()

    this.resetConversation()

    setTimeout(async () => {

      this.webView?.postMessage({
        type: EVENT_NAME.twinnyAddMessage,
        value: {
          completion: prompt,
        },
      })

      this.webView?.postMessage({
        type: EVENT_NAME.twinnyOnLoading,
      })

      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyReviewTab,
        false
      )

      updateLoadingMessage(this.webView, "Reviewing")

      await this.streamCodeReview(request)
    }, 500)
  }

  streamCodeReview({
    requestBody,
    requestOptions,
  }: {
    requestBody: RequestBodyBase
    requestOptions: StreamRequestOptions
    onEnd?: (completion: string) => void
  }): Promise<string> {
    const provider = this.getProvider()

    if (!provider) return Promise.resolve("")

    return new Promise((_, reject) => {
      try {
        return streamResponse({
          body: requestBody,
          options: requestOptions,
          onStart: (controller: AbortController) => {
            this._controller = controller
            this.webView?.onDidReceiveMessage((data: { type: string }) => {
              if (data.type === EVENT_NAME.twinnyStopGeneration) {
                this._controller?.abort()
              }
            })
          },
          onData: (streamResponse) => {
            const provider = this.getProvider()
            if (!provider) return

            try {
              const data = getChatDataFromProvider(
                provider.provider,
                streamResponse as StreamResponse
              )
              this._completion = this._completion + data
              this.webView.postMessage({
                type: EVENT_NAME.twinnyOnCompletion,
                value: {
                  completion: this._completion.trimStart(),
                },
              } as ServerMessage)
            } catch (error) {
              console.error("Error parsing JSON:", error)
              return
            }
          },
          onEnd: () => {
            this.webView?.postMessage({
              type: EVENT_NAME.twinnyOnEnd,
              value: {
                completion: this._completion.trimStart(),
              },
            })
            this._completion = ""
          },
          onError: (error: Error) => {
            this.webView?.postMessage({
              type: EVENT_NAME.twinnyOnEnd,
              value: {
                error: true,
                errorMessage: error.message,
              },
            } as ServerMessage)
          }
        })
      } catch (e) {
        return reject(e)
      }
    })
  }
}

import { ChatCompletionMessageParam, TokenJS } from "token.js"
import { commands, ExtensionContext, Webview } from "vscode"

import {
  ASSISTANT,
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  GITHUB_EVENT_NAME,
  USER,
  WEBUI_TABS
} from "../common/constants"
import { apiProviders, ClientMessage, ServerMessage, TemplateData } from "../common/types"

import { ConversationHistory } from "./conversation-history"
import { SessionManager } from "./session-manager"
import { SymmetryService } from "./symmetry-service"
import { TemplateProvider } from "./template-provider"
import { getIsOpenAICompatible, updateLoadingMessage } from "./utils"

export class GithubService extends ConversationHistory {
  private _completion = ""
  private _templateProvider: TemplateProvider
  private _controller?: AbortController
  private _tokenJs: TokenJS | undefined

  constructor(
    context: ExtensionContext,
    webView: Webview,
    sessionManager: SessionManager | undefined,
    symmetryService: SymmetryService,
    templateDir: string | undefined
  ) {
    super(context, webView, sessionManager, symmetryService)
    this._templateProvider = new TemplateProvider(templateDir)
    const provider = this.getProvider()
    if (!provider) return

    this._tokenJs = new TokenJS({
      baseURL: this.getProviderBaseUrl(provider),
      apiKey: provider.apiKey
    })
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
      code: diff
    })
  }

  private async handleGetPullRequests(
    data: { owner: string; repo: string } | undefined
  ) {
    if (!data) return
    const prs = await this.getPullRequests(data.owner, data.repo)
    this.webView.postMessage({
      type: GITHUB_EVENT_NAME.getPullRequests,
      data: prs
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
      data: review
    })
  }

  getHeaders() {
    return {
      Authorization: `Bearer ${this.config.githubToken}`,
      Accept: "application/vnd.github.v3.diff"
    }
  }

  private focusChatTab = () => {
    this.webView.postMessage({
      type: EVENT_NAME.twinnySetTab,
      data: WEBUI_TABS.chat
    } as ServerMessage<string>)
  }

  async getPullRequests(owner: string, repo: string) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls`
    const response = await fetch(url, {
      headers: this.getHeaders()
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
      headers
    })
    const diff = await response.text()
    const prompt = await this.loadReviewTemplate(`${title} \n\n ${diff}`)

    const messages: ChatCompletionMessageParam[] = [
      {
        role: USER,
        content: prompt
      }
    ]

    this.focusChatTab()

    this.resetConversation()

    setTimeout(async () => {
      this.webView?.postMessage({
        type: EVENT_NAME.twinnyAddMessage,
        data: prompt
      })

      this.webView?.postMessage({
        type: EVENT_NAME.twinnyOnLoading
      })

      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyReviewTab,
        false
      )

      updateLoadingMessage(this.webView, "Reviewing")

      await this.streamCodeReview(messages)
    }, 500)
  }

  public abort = () => {
    this._controller?.abort()
    commands.executeCommand(
      "setContext",
      EXTENSION_CONTEXT_NAME.twinnyGeneratingText,
      false
    )
  }

  async streamCodeReview(messages: ChatCompletionMessageParam[]) {
    const provider = this.getProvider()

    if (!provider) return

    this.setActiveConversation({
      messages,
      id: crypto.randomUUID(),
      title: "Code Review",
    })

    const result = await this._tokenJs?.chat.completions.create({
      messages,
      model: provider.modelName,
      stream: true,
      provider: getIsOpenAICompatible(provider)
        ? apiProviders.OpenAICompatible
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        : (provider.provider as any),
    })

    if (!result) return

    for await (const part of result) {
      if (this._controller?.signal.aborted) {
        break
      }

      if (part.choices[0].delta.content) {
        this._completion += part.choices[0].delta.content
      }

      this.webView.postMessage({
        type: EVENT_NAME.twinnyOnCompletion,
        data: {
          role: ASSISTANT,
          content: this._completion
        }
      })
    }

    this.saveConversation({
      messages: [
        ...messages,
        {
          role: ASSISTANT,
          content: this._completion,
        }
      ],
      id: crypto.randomUUID(),
      title: "Code Review",
    })

    this._completion = ""
  }
}

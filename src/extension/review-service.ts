import { ChatCompletionMessageParam, TokenJS } from "fluency.js"
import { commands, ExtensionContext } from "vscode"

import {
  API_PROVIDERS,
  ASSISTANT,
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  GITHUB_EVENT_NAME,
  USER,
  WEBUI_TABS
} from "../common/constants"
import { PullRequestReviewRequest } from "../common/messaging/protocol"
import { GitHubPr, TemplateData } from "../common/types"

import { ExtensionBridge } from "./messaging/bridge"
import { Chat } from "./chat"
import { ConversationHistory } from "./conversation-history"
import { TemplateProvider } from "./template-provider"
import { getIsOpenAICompatible, updateLoadingMessage } from "./utils"

export class GithubService extends ConversationHistory {
  private _completion = ""
  private _templateProvider: TemplateProvider
  private _controller?: AbortController
  private _tokenJs: TokenJS | undefined

  constructor(
    context: ExtensionContext,
    bridge: ExtensionBridge,
    templateDir: string | undefined,
    chat: Chat
  ) {
    super(context, bridge, chat)
    this._templateProvider = new TemplateProvider(templateDir)
    const provider = this.getProvider()
    if (!provider) return

    this._tokenJs = new TokenJS({
      baseURL: this.getProviderBaseUrl(provider),
      apiKey: provider.apiKey
    })
  }

  /**
   * Deliberately replaces — not extends — the conversation-history table.
   * `BaseProvider` builds a plain `ConversationHistory` alongside this
   * subclass, and that instance already owns the conversation channels; the
   * bridge would reject a second claim on them.
   */
  protected override registerHandlers() {
    this.bridge.handleAll({
      [GITHUB_EVENT_NAME.getPullRequests]: ({ owner, repo }) =>
        this.handleGetPullRequests(owner, repo),
      [GITHUB_EVENT_NAME.getPullRequestReview]: (request) =>
        this.getPullRequestReview(request)
    })
  }

  private async loadReviewTemplate(diff: string): Promise<string> {
    return await this._templateProvider.readTemplate<TemplateData>("review", {
      code: diff
    })
  }

  private async handleGetPullRequests(
    owner: string | undefined,
    repo: string | undefined
  ) {
    if (!owner || !repo) return
    this.bridge.emit(
      GITHUB_EVENT_NAME.getPullRequests,
      await this.getPullRequests(owner, repo)
    )
  }

  getHeaders() {
    return {
      Authorization: `Bearer ${this.config.githubToken}`,
      Accept: "application/vnd.github.v3.diff"
    }
  }

  private focusChatTab = () => {
    this.bridge.emit(EVENT_NAME.twinnySetTab, WEBUI_TABS.chat)
  }

  async getPullRequests(owner: string, repo: string): Promise<GitHubPr[]> {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls`
    const response = await fetch(url, {
      headers: this.getHeaders()
    })
    return response.json() as Promise<GitHubPr[]>
  }

  async getPullRequestReview({
    owner,
    repo,
    number,
    title
  }: PullRequestReviewRequest) {
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
      this.bridge.emit(EVENT_NAME.twinnyAddMessage, {
        role: USER,
        content: prompt
      })

      this.bridge.emit(EVENT_NAME.twinnyOnLoading)

      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyReviewTab,
        false
      )

      updateLoadingMessage(this.bridge, "Reviewing")

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
      title: "Code Review"
    })

    const result = await this._tokenJs?.chat.completions.create({
      messages,
      model: provider.modelName,
      stream: true,
      provider: getIsOpenAICompatible(provider)
        ? API_PROVIDERS.OpenAICompatible
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (provider.provider as any)
    })

    if (!result) return

    for await (const part of result) {
      if (this._controller?.signal.aborted) {
        break
      }

      if (part.choices[0].delta.content) {
        this._completion += part.choices[0].delta.content
      }

      this.bridge.emit(EVENT_NAME.twinnyOnCompletion, {
        role: ASSISTANT,
        content: this._completion
      })
    }

    this.saveConversation({
      messages: [
        ...messages,
        {
          role: ASSISTANT,
          content: this._completion
        }
      ],
      id: crypto.randomUUID(),
      title: "Code Review"
    })

    this._completion = ""
  }
}

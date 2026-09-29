import { commands, ExtensionContext, window, workspace } from "vscode"

import {
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  GITHUB_EVENT_NAME,
  REVIEW_EVENT_NAME,
  USER,
  WEBUI_TABS
} from "../../common/constants"
import { logger } from "../../common/logger"
import {
  LocalReviewRequest,
  LocalReviewStatus,
  PullRequestReviewRequest
} from "../../common/messaging/protocol"
import { ChatCompletionMessage, GitHubPr, TemplateData } from "../../common/types"
import { Chat } from "../chat"
import { ConversationHistory } from "../chat/conversation-history"
import { ExtensionBridge } from "../messaging/bridge"
import { TemplateProvider } from "../templates/provider"

import {
  DEFAULT_REVIEW_BUDGET,
  DiffFile,
  formatPartDiff,
  parseUnifiedDiff,
  partHeading,
  planReview,
  ReviewBudget,
  summarizeReview
} from "./diff"
import {
  countChangedFiles,
  detectBaseBranch,
  getBranchDiff,
  getCurrentBranch,
  getGitHubRemote,
  getWorkingTreeDiff,
  isGitRepository
} from "./git"

/** A diff plus what to call it, whatever it came from. */
interface ReviewSource {
  title: string
  diff: string
}

/**
 * Code review over a diff from the working tree, the current branch, or a
 * GitHub pull request. The diff never reaches the chat as text: the chat
 * gets a summary of what is under review, and the model gets the diff in
 * parts sized for its context window.
 */
export class ReviewService {
  private _templateProvider: TemplateProvider
  private _reviewing = false

  constructor(
    private readonly _context: ExtensionContext,
    private readonly _bridge: ExtensionBridge,
    templateDir: string | undefined,
    private readonly _chat: Chat,
    private readonly _history: ConversationHistory
  ) {
    this._templateProvider = new TemplateProvider(templateDir)
    this.registerHandlers()
  }

  private registerHandlers() {
    this._bridge.handleAll({
      [GITHUB_EVENT_NAME.getPullRequests]: ({ owner, repo }) =>
        this.getPullRequests(owner, repo),
      [GITHUB_EVENT_NAME.getPullRequestReview]: (request) =>
        void this.reviewPullRequest(request),
      [REVIEW_EVENT_NAME.getLocalStatus]: () => this.getLocalStatus(),
      [REVIEW_EVENT_NAME.reviewLocal]: (request) =>
        void this.reviewLocal(request)
    })
  }

  /* ---------------------------------------------------------------------- */
  /*  Sources                                                                */
  /* ---------------------------------------------------------------------- */

  private get workspaceRoot(): string | undefined {
    return workspace.workspaceFolders?.[0]?.uri.fsPath
  }

  public async getLocalStatus(): Promise<LocalReviewStatus> {
    const cwd = this.workspaceRoot
    if (!cwd || !(await isGitRepository(cwd))) {
      return {
        isRepository: false,
        branch: "",
        workingTreeFiles: 0,
        branchFiles: 0
      }
    }
    const [branch, base, github] = await Promise.all([
      getCurrentBranch(cwd),
      detectBaseBranch(cwd),
      getGitHubRemote(cwd)
    ])
    return {
      isRepository: true,
      branch,
      base,
      github,
      workingTreeFiles: await countChangedFiles(cwd, "HEAD"),
      branchFiles: base ? await countChangedFiles(cwd, `${base}...HEAD`) : 0
    }
  }

  private async loadLocalSource(
    request: LocalReviewRequest
  ): Promise<ReviewSource | undefined> {
    const cwd = this.workspaceRoot
    if (!cwd) {
      window.showInformationMessage("Open a folder to review local changes.")
      return undefined
    }

    try {
      if (request.mode === "branch") {
        const base = request.base?.trim() || (await detectBaseBranch(cwd))
        if (!base) {
          window.showErrorMessage(
            "Twinny could not work out which branch to compare against. Enter a base branch."
          )
          return undefined
        }
        const branch = await getCurrentBranch(cwd)
        return {
          title: `${branch} against ${base}`,
          diff: await getBranchDiff(cwd, base)
        }
      }
      return {
        title: "working tree changes",
        diff: await getWorkingTreeDiff(cwd)
      }
    } catch (error) {
      logger.error(error instanceof Error ? error : String(error))
      window.showErrorMessage(
        `Twinny could not read the git diff: ${
          error instanceof Error ? error.message.split("\n")[0] : String(error)
        }`
      )
      return undefined
    }
  }

  private githubHeaders(accept: string) {
    const token = workspace
      .getConfiguration("twinny")
      .get<string>("githubToken", "")
    return {
      Accept: accept,
      "User-Agent": "twinny-vscode",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  }

  private async githubFetch(url: string, accept: string): Promise<Response> {
    const response = await fetch(url, { headers: this.githubHeaders(accept) })
    if (response.ok) return response

    const hints: Record<number, string> = {
      401: "Check the GitHub token in the Twinny settings.",
      403: "GitHub refused the request; the token may lack access or the rate limit is exhausted.",
      404: "Repository or pull request not found. Check the owner and repository name, and that the token can see it."
    }
    throw new Error(
      `GitHub responded with ${response.status}. ${hints[response.status] || ""}`.trim()
    )
  }

  public async getPullRequests(
    owner: string | undefined,
    repo: string | undefined
  ): Promise<GitHubPr[]> {
    if (!owner || !repo) return []
    try {
      const response = await this.githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=50`,
        "application/vnd.github+json"
      )
      const data = (await response.json()) as unknown
      return Array.isArray(data) ? (data as GitHubPr[]) : []
    } catch (error) {
      window.showErrorMessage(
        error instanceof Error ? error.message : "Could not load pull requests."
      )
      return []
    }
  }

  private async loadPullRequestSource(
    request: PullRequestReviewRequest
  ): Promise<ReviewSource | undefined> {
    const { owner, repo, number, title } = request
    if (!owner || !repo) return undefined
    try {
      const response = await this.githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
        "application/vnd.github.v3.diff"
      )
      return { title: `PR #${number} ${title}`, diff: await response.text() }
    } catch (error) {
      window.showErrorMessage(
        error instanceof Error
          ? error.message
          : "Could not load the pull request."
      )
      return undefined
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Running a review                                                       */
  /* ---------------------------------------------------------------------- */

  public reviewLocal(request: LocalReviewRequest) {
    return this.review(() => this.loadLocalSource(request))
  }

  public reviewPullRequest(request: PullRequestReviewRequest) {
    return this.review(() => this.loadPullRequestSource(request))
  }

  private budget(): ReviewBudget {
    const perRequest = workspace
      .getConfiguration("twinny")
      .get<number>(
        "reviewMaxDiffChars",
        DEFAULT_REVIEW_BUDGET.maxCharsPerRequest
      )
    const maxCharsPerRequest = Math.max(2000, perRequest)
    return {
      ...DEFAULT_REVIEW_BUDGET,
      maxCharsPerRequest,
      maxFileChars: Math.min(
        DEFAULT_REVIEW_BUDGET.maxFileChars,
        Math.floor(maxCharsPerRequest / 2)
      )
    }
  }

  private async review(load: () => Promise<ReviewSource | undefined>) {
    if (this._reviewing) {
      window.showInformationMessage("A review is already running.")
      return
    }
    if (!this._chat.getProvider()) {
      window.showErrorMessage(
        "Select a chat provider before starting a review."
      )
      return
    }

    this._reviewing = true
    try {
      const source = await load()
      if (!source) return

      const files = parseUnifiedDiff(source.diff)
      if (!files.length) {
        window.showInformationMessage("No changes to review.")
        return
      }

      const plan = planReview(files, this.budget())
      if (!plan.parts.length) {
        window.showInformationMessage(
          "Nothing reviewable: the changes are all lockfiles, binaries or build output."
        )
        return
      }

      await this.runReview(source.title, files, plan)
    } finally {
      this._reviewing = false
    }
  }

  private showChat() {
    commands.executeCommand(
      "setContext",
      EXTENSION_CONTEXT_NAME.twinnyReviewTab,
      false
    )
    this._bridge.emit(EVENT_NAME.twinnySetTab, WEBUI_TABS.chat)
  }

  private async runReview(
    title: string,
    files: DiffFile[],
    plan: ReturnType<typeof planReview>
  ) {
    const id = crypto.randomUUID()
    const messages: ChatCompletionMessage[] = [
      { role: USER, content: summarizeReview(title, files, plan) }
    ]
    const save = () =>
      this._history.updateConversation({
        id,
        title: `Review: ${title}`,
        messages,
        pinnedTitle: true
      })

    // The chat tab loads the active conversation when it mounts, so the
    // summary is safe to publish before the tab has switched.
    save()
    this.showChat()
    await new Promise((resolve) => setTimeout(resolve, 300))

    const partReviews: string[] = []
    const total = plan.parts.length

    for (const [index, part] of plan.parts.entries()) {
      if (this._chat.cancelled) break
      this._bridge.emit(EVENT_NAME.twinnyOnLoading)
      this._bridge.emit(
        EVENT_NAME.twinnySendLoader,
        total > 1 ? `Reviewing part ${index + 1} of ${total}` : "Reviewing"
      )

      const prompt = await this._templateProvider.readTemplate<TemplateData>(
        "review",
        {
          code: formatPartDiff(part),
          title,
          part: total > 1 ? `${index + 1} of ${total}` : ""
        }
      )
      if (!prompt) {
        window.showErrorMessage("Twinny could not load the review template.")
        return
      }

      const review = await this._chat.streamMessages(
        [{ role: USER, content: prompt }],
        partHeading(index, total, part)
      )
      if (!review) break
      partReviews.push(review)
      messages.push({ role: "assistant", content: review })
      save()
    }

    if (partReviews.length > 1 && !this._chat.cancelled) {
      await this.summarizeParts(title, partReviews, messages, save)
    }
  }

  /** After a multi-part review, one short verdict across all of it. */
  private async summarizeParts(
    title: string,
    partReviews: string[],
    messages: ChatCompletionMessage[],
    save: () => void
  ) {
    this._bridge.emit(EVENT_NAME.twinnyOnLoading)
    this._bridge.emit(EVENT_NAME.twinnySendLoader, "Summarising the review")

    const prompt = await this._templateProvider.readTemplate<TemplateData>(
      "review-summary",
      {
        title,
        code: partReviews
          .map((text, index) => `--- Part ${index + 1} ---\n${text}`)
          .join("\n\n")
      }
    )
    if (!prompt) return

    const summary = await this._chat.streamMessages(
      [{ role: USER, content: prompt }],
      "**Overall**\n\n"
    )
    if (summary) {
      messages.push({ role: "assistant", content: summary })
      save()
    }
  }
}

import {
  commands,
  env,
  extensions,
  ProgressLocation,
  Uri,
  window,
  workspace
} from "vscode"

import { logger } from "../../common/logger"
import { TemplateData } from "../../common/types"
import { Chat } from "../chat"
import { TemplateProvider } from "../templates/provider"

import { runGit } from "./git"

/** Roughly what a small local model can take alongside the instructions. */
export const COMMIT_DIFF_MAX_CHARS = 24000

/** Minimal view of the built-in git extension's API. */
interface GitRepository {
  rootUri: Uri
  inputBox: { value: string }
}
interface GitApi {
  repositories: GitRepository[]
}
interface GitExtension {
  getAPI(version: 1): GitApi
}

/**
 * Cut a diff down to size at a hunk or file boundary so the model never sees
 * half a change, and say so at the end so it knows the picture is partial.
 */
export const truncateDiff = (
  diff: string,
  maxChars = COMMIT_DIFF_MAX_CHARS
): string => {
  if (diff.length <= maxChars) return diff
  const head = diff.slice(0, maxChars)
  const boundary = Math.max(
    head.lastIndexOf("\ndiff --git "),
    head.lastIndexOf("\n@@ ")
  )
  const kept = boundary > maxChars / 2 ? head.slice(0, boundary) : head
  return `${kept.trimEnd()}\n\n[diff truncated: ${diff.length - kept.length} more characters not shown]`
}

/**
 * Models wrap commit messages in fences or quotes no matter how firmly they
 * are told not to; strip that so the text can go straight into the commit.
 */
export const cleanCommitMessage = (text: string): string => {
  let message = text.trim()
  // A fenced block anywhere is the answer; whatever surrounds it is chatter.
  const fence = /```[a-z]*\n([\s\S]*?)\n?```/i.exec(message)
  if (fence) message = fence[1].trim()
  // "Here's the commit message:" style preambles end in a colon.
  message = message.replace(/^[^\n]*:\s*\n+/, "")
  message = message.replace(/^(commit message:?)\s*/i, "")
  if (
    (message.startsWith("\"") && message.endsWith("\"")) ||
    (message.startsWith("'") && message.endsWith("'"))
  ) {
    message = message.slice(1, -1).trim()
  }
  return message.replace(/\n{3,}/g, "\n\n")
}

/** Staged changes if there are any, otherwise everything unstaged. */
export const getCommitDiff = async (
  cwd: string
): Promise<{ diff: string; staged: boolean }> => {
  const staged = await runGit(cwd, "diff --cached")
  if (staged.trim()) return { diff: staged, staged: true }
  return { diff: await runGit(cwd, "diff"), staged: false }
}

const findRepository = (cwd: string): GitRepository | undefined => {
  const git = extensions.getExtension<GitExtension>("vscode.git")?.exports
  const repositories = git?.getAPI(1).repositories || []
  return (
    repositories.find((repo) => cwd.startsWith(repo.rootUri.fsPath)) ||
    repositories[0]
  )
}

/**
 * Generate a commit message for the working tree and drop it into the
 * Source Control input box (or the clipboard when there is no git view).
 */
export const generateCommitMessage = async (
  chat: Chat,
  templateProvider: TemplateProvider
): Promise<void> => {
  const cwd = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!cwd) {
    window.showInformationMessage("Open a folder to generate a commit message.")
    return
  }

  let changes: { diff: string; staged: boolean }
  try {
    changes = await getCommitDiff(cwd)
  } catch (error) {
    logger.error(error instanceof Error ? error : String(error))
    window.showErrorMessage(
      "Twinny could not read the git diff. Is this folder a git repository?"
    )
    return
  }

  const { diff, staged } = changes
  if (!diff.trim()) {
    window.showInformationMessage("No changes to describe.")
    return
  }

  const prompt = await templateProvider.readTemplate<TemplateData>(
    "commit-message",
    { code: truncateDiff(diff), language: "diff" }
  )
  if (!prompt) {
    window.showErrorMessage("Twinny could not load the commit-message template.")
    return
  }

  const message = await window.withProgress(
    {
      location: ProgressLocation.SourceControl,
      title: "Twinny: writing commit message"
    },
    async () => {
      const completion = await chat.generateSimpleCompletion(prompt)
      return completion ? cleanCommitMessage(completion) : ""
    }
  )

  if (!message) {
    window.showErrorMessage(
      "Twinny could not generate a commit message. Check the chat provider and the Twinny output log."
    )
    return
  }

  const repository = findRepository(cwd)
  if (repository) {
    repository.inputBox.value = message
    await commands.executeCommand("workbench.view.scm")
    if (!staged) {
      window.setStatusBarMessage(
        "Twinny: commit message written from unstaged changes",
        5000
      )
    }
    return
  }

  await env.clipboard.writeText(message)
  window.showInformationMessage("Commit message copied to the clipboard.")
}

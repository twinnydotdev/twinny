import { truncateDiff } from "../review/commit-message"
import { getWorkingTreeDiff, isGitRepository, runGit } from "../review/git"

/** A small model gets far less of the diff than the review feature sends. */
export const GIT_CONTEXT_MAX_CHARS = 16000

export interface GitSnapshot {
  branch: string
  /** `git status --short`, one entry per line. */
  status: string
  diff: string
}

/** The block an `@git` mention puts in the prompt. */
export const formatGitSnapshot = (
  snapshot: GitSnapshot,
  maxChars = GIT_CONTEXT_MAX_CHARS
): string => {
  const parts = [`Git branch: ${snapshot.branch}`]
  const status = snapshot.status.replace(/\s+$/, "")
  parts.push(
    status
      ? `Changed files:\n\`\`\`\n${status}\n\`\`\``
      : "Changed files: none (working tree clean)"
  )
  const diff = snapshot.diff.trim()
  if (diff) {
    parts.push(
      `Working tree diff:\n\`\`\`diff\n${truncateDiff(diff, maxChars)}\n\`\`\``
    )
  }
  return parts.join("\n\n")
}

/** The working tree as the model should see it, or undefined outside git. */
export const getGitContext = async (
  cwd: string
): Promise<string | undefined> => {
  if (!(await isGitRepository(cwd))) return undefined
  const [branch, status, diff] = await Promise.all([
    runGit(cwd, "rev-parse --abbrev-ref HEAD").then(
      (out) => out.trim(),
      () => "HEAD"
    ),
    runGit(cwd, "status --short").catch(() => ""),
    getWorkingTreeDiff(cwd).catch(() => "")
  ])
  return formatGitSnapshot({ branch, status, diff })
}

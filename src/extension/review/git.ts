import { exec } from "child_process"
import * as util from "util"

const execAsync = util.promisify(exec)

const MAX_BUFFER = 32 * 1024 * 1024

/** Run git in a folder and return stdout; throws on a non-zero exit. */
export const runGit = async (cwd: string, args: string): Promise<string> => {
  const { stdout } = await execAsync(`git ${args}`, {
    cwd,
    maxBuffer: MAX_BUFFER
  })
  return stdout
}

/** Like `runGit` but a failure yields undefined instead of throwing. */
const tryGit = async (cwd: string, args: string): Promise<string | undefined> =>
  runGit(cwd, args).then(
    (out) => out,
    () => undefined
  )

export const isGitRepository = async (cwd: string): Promise<boolean> =>
  (await tryGit(cwd, "rev-parse --is-inside-work-tree"))?.trim() === "true"

export const getCurrentBranch = async (cwd: string): Promise<string> =>
  (await tryGit(cwd, "rev-parse --abbrev-ref HEAD"))?.trim() || "HEAD"

const BASE_CANDIDATES = [
  "origin/main",
  "main",
  "origin/master",
  "master",
  "origin/develop",
  "develop",
  "origin/development",
  "development"
]

export interface GitHubRemote {
  owner: string
  repo: string
}

/**
 * Owner and repository from a GitHub remote URL, in any of the forms git
 * accepts: https, ssh (`git@github.com:o/r.git`), or `ssh://git@github.com/o/r`.
 * Undefined for non-GitHub remotes.
 */
export const parseGitHubRemote = (url: string): GitHubRemote | undefined => {
  const match =
    /(?:^|[/@])github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())
  if (!match) return undefined
  return { owner: match[1], repo: match[2] }
}

/** The GitHub project this checkout pushes to, if its remote is on GitHub. */
export const getGitHubRemote = async (
  cwd: string
): Promise<GitHubRemote | undefined> => {
  const origin = await tryGit(cwd, "remote get-url origin")
  if (origin?.trim()) return parseGitHubRemote(origin)
  // No origin: take the first remote that is on GitHub.
  const remotes = (await tryGit(cwd, "remote -v")) || ""
  for (const line of remotes.split("\n")) {
    const url = line.split(/\s+/)[1]
    const parsed = url && parseGitHubRemote(url)
    if (parsed) return parsed
  }
  return undefined
}

/** `origin/main` or similar, from the remote's HEAD when git knows it. */
const getRemoteDefaultBranch = async (
  cwd: string
): Promise<string | undefined> => {
  const ref = await tryGit(cwd, "symbolic-ref --quiet refs/remotes/origin/HEAD")
  const name = ref?.trim().replace(/^refs\/remotes\//, "")
  return name || undefined
}

/**
 * The branch a feature branch is most likely to merge into: the remote's
 * default branch when known, otherwise the first of the usual names that
 * exists and is not the branch we are on.
 */
export const detectBaseBranch = async (
  cwd: string
): Promise<string | undefined> => {
  const current = await getCurrentBranch(cwd)
  const remoteDefault = await getRemoteDefaultBranch(cwd)
  const candidates = remoteDefault
    ? [remoteDefault, ...BASE_CANDIDATES]
    : BASE_CANDIDATES
  for (const candidate of candidates) {
    const short = candidate.replace(/^origin\//, "")
    if (short === current) continue
    const exists = await tryGit(cwd, `rev-parse --verify --quiet ${candidate}`)
    if (exists?.trim()) return candidate
  }
  return undefined
}

/** Staged and unstaged changes to tracked files, in one diff. */
export const getWorkingTreeDiff = async (cwd: string): Promise<string> => {
  const hasHead = await tryGit(cwd, "rev-parse --verify --quiet HEAD")
  if (hasHead?.trim()) return runGit(cwd, "diff HEAD")
  // No commits yet: only the index can be diffed.
  return runGit(cwd, "diff --cached")
}

/** Everything this branch adds on top of where it forked from `base`. */
export const getBranchDiff = async (
  cwd: string,
  base: string
): Promise<string> => runGit(cwd, `diff ${base}...HEAD`)

/** Number of files a diff command would touch, without fetching the diff. */
export const countChangedFiles = async (
  cwd: string,
  args: string
): Promise<number> => {
  const out = await tryGit(cwd, `diff --name-only ${args}`)
  if (out === undefined) return 0
  return out.split("\n").filter((line) => line.trim()).length
}

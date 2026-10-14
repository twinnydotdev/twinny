/**
 * What a command the agent ran changed in a git working tree, so the
 * reply's list of changed files (`reply-changes.ts`) covers commands too:
 * a formatter, a codemod, a `sed -i`. The tree is taken as git would
 * commit it, tracked and untracked files alike with `.gitignore`
 * honoured, before and after the command, through a copy of the index so
 * the user's own staging is never touched. Writing the snapshot adds
 * objects to the repository's object store, as `git stash create` does:
 * every untracked file `.gitignore` does not exclude is copied in the
 * first time (a large dataset dropped into the workspace included), and
 * git's own housekeeping removes them in time. It scans the whole
 * repository, not only the workspace folder, so it costs about what
 * `git status` does there, twice per command.
 *
 * Outside a repository, or when git fails, there is no snapshot and the
 * command runs as before: this never stands in a command's way.
 */
import { execFile } from "child_process"
import { randomUUID } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"

import { looksBinary } from "../embeddings/indexable"

import { MAX_KEPT_FILE_BYTES } from "./reply-changes"

const GIT_TIMEOUT_MS = 15_000
/** Past this many files a command changed, they are not listed: undo all would be a guess. */
export const MAX_COMMAND_CHANGES = 200

interface GitAnswer {
  stdout: Buffer
  ok: boolean
}

const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  new Promise<GitAnswer>((resolve) => {
    const child = execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: "buffer", env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout) => resolve({ stdout: stdout as Buffer, ok: !error })
    )
    child.stdin?.end()
  })

/** The working tree's top and its git directory, when `cwd` is in one. */
const repositoryOf = async (cwd: string) => {
  const answer = await git(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir"])
  if (!answer.ok) return undefined
  const [top, gitDir] = answer.stdout.toString("utf8").trim().split("\n")
  return top && gitDir ? { top, gitDir } : undefined
}

export interface TreeSnapshot {
  /** The working tree's top, which the tree's paths are relative to. */
  top: string
  tree: string
}

/** The working tree as a git tree, or undefined outside a repository or when git fails. */
export const snapshotTree = async (cwd: string): Promise<TreeSnapshot | undefined> => {
  const repository = await repositoryOf(cwd)
  if (!repository) return undefined
  const index = path.join(os.tmpdir(), `twinny-index-${randomUUID()}`)
  try {
    // A copy of the real index: its file stats spare git rehashing what did not change.
    try {
      fs.copyFileSync(path.join(repository.gitDir, "index"), index)
    } catch {
      // A repository with nothing staged yet has no index; git makes one.
    }
    const env = { GIT_INDEX_FILE: index }
    if (!(await git(repository.top, ["add", "-A"], env)).ok) return undefined
    const written = await git(repository.top, ["write-tree"], env)
    const tree = written.stdout.toString("utf8").trim()
    return written.ok && /^[0-9a-f]{40,64}$/.test(tree) ? { top: repository.top, tree } : undefined
  } finally {
    fs.rmSync(index, { force: true })
  }
}

export interface TreeChange {
  /** Absolute. */
  file: string
  /** What it was before: its text, `null` when it did not exist, `undefined` when it cannot be kept. */
  before: string | null | undefined
}

/** A file in `tree` as text, or undefined when it is binary or too large to keep. */
const textAt = async (top: string, tree: string, relative: string): Promise<string | undefined> => {
  const answer = await git(top, ["cat-file", "-p", `${tree}:${relative}`])
  if (!answer.ok || answer.stdout.length > MAX_KEPT_FILE_BYTES || looksBinary(answer.stdout)) return undefined
  const text = answer.stdout.toString("utf8")
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * The files that differ between two snapshots of the same tree, with what
 * each was before; undefined when there are too many to list.
 */
export const changesBetween = async (before: TreeSnapshot, after: TreeSnapshot): Promise<TreeChange[] | undefined> => {
  if (before.tree === after.tree) return []
  const answer = await git(before.top, ["diff-tree", "-r", "--no-renames", "--name-status", "-z", before.tree, after.tree])
  if (!answer.ok) return []
  const fields = answer.stdout.toString("utf8").split("\0").filter(Boolean)
  const entries: { status: string; relative: string }[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) entries.push({ status: fields[i], relative: fields[i + 1] })
  if (entries.length > MAX_COMMAND_CHANGES) return undefined
  const changes: TreeChange[] = []
  for (const { status, relative } of entries) {
    changes.push({
      file: path.join(before.top, ...relative.split("/")),
      before: status.startsWith("A") ? null : await textAt(before.top, before.tree, relative)
    })
  }
  return changes
}

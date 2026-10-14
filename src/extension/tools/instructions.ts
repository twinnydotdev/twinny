/**
 * Project instructions for the agent: what a repository tells coding
 * agents in its `AGENTS.md`, the convention most agents read (or, without
 * one, `CLAUDE.md` or Copilot's instructions file). The root's file goes
 * in the system prompt. A folder's own `AGENTS.md` applies to the code
 * under it, so it comes with the first tool result of the reply that
 * touches something there; where it and an outer one disagree, the
 * nearer one wins.
 *
 * They are read whatever `.gitignore` says (they are the user's words to
 * the agent, often kept out of git), but never through a link that leaves
 * the workspace, and never past a size worth a model's context.
 */
import fs from "fs"
import path from "path"

import { looksBinary } from "../embeddings/indexable"

import type { WorkspaceView } from "./view"

/** Looked for at the root, in this order; the first found is used. */
export const ROOT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"]
/** Looked for in the folders below the root. */
export const FOLDER_INSTRUCTION_FILE = "AGENTS.md"
export const MAX_ROOT_INSTRUCTION_CHARS = 8000
export const MAX_FOLDER_INSTRUCTION_CHARS = 4000
const MAX_READ_BYTES = 256 * 1024

export interface InstructionFile {
  /** Relative to the root, with `/`. */
  path: string
  text: string
}

const relativeTo = (root: string, absolute: string) => path.relative(root, absolute).split(path.sep).join("/")

/** A file's text when it is a readable text file whose real place is inside `realRoot`; cut to `limit`. */
const readInside = (realRoot: string, absolute: string, limit: number): string | undefined => {
  try {
    const real = fs.realpathSync(absolute)
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return undefined
    const stat = fs.statSync(real)
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) return undefined
    const buffer = fs.readFileSync(real)
    if (looksBinary(buffer)) return undefined
    const raw = buffer.toString("utf8")
    // The editor never shows a byte-order mark, so neither do the tools.
    const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).trim()
    if (!text) return undefined
    return text.length > limit ? `${text.slice(0, limit)}\n… (cut: the file goes on for ${text.length - limit} more characters)` : text
  } catch {
    return undefined
  }
}

/** The root's instructions file, if it has one. */
export const readRootInstructions = (root: string): InstructionFile | undefined => {
  let realRoot: string
  try {
    realRoot = fs.realpathSync(root)
  } catch {
    return undefined
  }
  for (const name of ROOT_INSTRUCTION_FILES) {
    const text = readInside(realRoot, path.join(root, name), MAX_ROOT_INSTRUCTION_CHARS)
    if (text) return { path: name, text }
  }
  return undefined
}

/** The system prompt's part for the root's instructions. */
export const instructionsSection = (file: InstructionFile) =>
  `The project's instructions for coding agents, from ${file.path}. Follow them unless the user asks otherwise:\n\n${file.text}`

/** How a folder's instructions read when they come with a tool result. */
export const folderInstructionsNote = (file: InstructionFile) => {
  const folder = path.posix.dirname(file.path)
  return `[${file.path}: the project's instructions for work under ${folder}/. Follow them; where they differ from instructions for a folder above, these win.]\n${file.text}`
}

/**
 * The `AGENTS.md` files of the folders a reply's tools reach, each given
 * once. Made per reply, like the view.
 */
export class FolderInstructions {
  /** Folder files looked for, found or not, so each is read once. */
  private readonly _checked = new Set<string>()
  private readonly _given: string[] = []
  private readonly _realRoot: string

  constructor(private readonly _view: WorkspaceView) {
    this._realRoot = fs.realpathSync(_view.root)
  }

  /** Every folder file given so far, relative to the root. */
  get given(): string[] {
    return [...this._given]
  }

  /**
   * The instructions of the folders holding `target` (a path a tool was
   * given, relative to the root) that this reply has not had yet,
   * outermost first. The root's own is in the system prompt, not here.
   */
  for(target: string): InstructionFile[] {
    const cleaned = target.trim().replace(/^\.\/+/, "")
    if (!cleaned) return []
    const absolute = path.resolve(this._view.root, cleaned)
    const relative = relativeTo(this._view.root, absolute)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return []
    let folder = absolute
    try {
      if (!fs.statSync(absolute).isDirectory()) folder = path.dirname(absolute)
    } catch {
      folder = path.dirname(absolute)
    }
    const found: InstructionFile[] = []
    while (folder !== this._view.root && folder.startsWith(this._view.root + path.sep)) {
      const file = path.join(folder, FOLDER_INSTRUCTION_FILE)
      const rel = relativeTo(this._view.root, file)
      if (!this._checked.has(rel)) {
        this._checked.add(rel)
        const text = this._view.ignored(relativeTo(this._view.root, folder), true)
          ? undefined
          : readInside(this._realRoot, file, MAX_FOLDER_INSTRUCTION_CHARS)
        if (text) found.unshift({ path: rel, text })
      }
      folder = path.dirname(folder)
    }
    this._given.push(...found.map((file) => file.path))
    return found
  }
}

/**
 * The workspace as the tools see it: one root folder, its ignore rules,
 * and the checks that keep every tool inside it.
 *
 * Paths are resolved and their real location checked, so `..` and
 * symlinks cannot leave the root. Whatever a `.gitignore` ignores (where
 * `.env` files and build output live) cannot be listed, searched or read:
 * the root's `.gitignore` and the ones in the folders below it all count,
 * each for its own folder, as git reads them. A rule in a deeper file
 * cannot bring back what a file above it ignores; erring that way keeps
 * a secret hidden rather than shown.
 */
import fs from "fs"
import ignore, { Ignore } from "ignore"
import path from "path"

import { isIndexablePath, looksBinary } from "../embeddings/indexable"

export const MAX_LINE_CHARS = 200
const MAX_FILE_BYTES = 512 * 1024

export const clip = (line: string) =>
  line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

/** A file's lines as the tools number them: no carriage returns, and no empty line for the final newline. */
export const linesOf = (text: string): string[] => {
  const unix = text.replace(/\r\n/g, "\n")
  return unix === "" ? [] : unix.replace(/\n$/, "").split("\n")
}

/** A tool's input was wrong; the message goes back to the model to fix its call. */
export class ToolInputError extends Error {}

/** The workspace as the tools see it: a root, its ignore rules, its files. */
export class WorkspaceView {
  private readonly _realRoot: string
  /** Rules that hold everywhere: `.git`, `node_modules`, the user's ignored globs. */
  private readonly _base: Ignore
  /** Each folder's own `.gitignore`, read once; null where there is none. */
  private readonly _gitignores = new Map<string, Ignore | null>()
  private _files?: Promise<string[]>
  private _tree?: Promise<{ files: string[]; dirs: string[] }>

  constructor(
    readonly root: string,
    ignoredGlobs: string[] = [],
    private readonly _read?: (file: string) => Promise<string | undefined>
  ) {
    this._realRoot = fs.realpathSync(root)
    this._base = ignore().add([".git", "node_modules", ...ignoredGlobs])
  }

  private gitignoreOf(dir: string): Ignore | null {
    let rules = this._gitignores.get(dir)
    if (rules === undefined) {
      try {
        rules = ignore().add(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"))
      } catch {
        rules = null
      }
      this._gitignores.set(dir, rules)
    }
    return rules
  }

  /**
   * Whether a path under the root is ignored. `relative` is relative to
   * the root, in either separator.
   */
  ignored(relative: string, isDirectory = false): boolean {
    const parts = relative.split(/[\\/]+/).filter(Boolean)
    if (!parts.length || parts[0] === "..") return false
    const whole = parts.join("/") + (isDirectory ? "/" : "")
    if (this._base.ignores(whole)) return true
    for (let depth = 0; depth < parts.length; depth++) {
      const rules = this.gitignoreOf(path.join(this.root, ...parts.slice(0, depth)))
      if (rules?.ignores(parts.slice(depth).join("/") + (isDirectory ? "/" : ""))) return true
    }
    return false
  }

  private inside(real: string) {
    return real === this._realRoot || real.startsWith(this._realRoot + path.sep)
  }

  /** Whether an absolute path is one the tools may show: inside the root and not ignored. */
  visible(absolute: string): boolean {
    const relative = path.relative(this.root, absolute)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false
    return !this.ignored(relative)
  }

  /** `relative` as an absolute path inside the root, or a reason it is not allowed. */
  resolve(relative = ".", kind: "file" | "dir" | "any"): string {
    const cleaned = relative.trim().replace(/^\.\/+/, "") || "."
    let absolute = path.resolve(this.root, cleaned)
    // `/src/a.ts` meaning the workspace's src, as models sometimes write it.
    if (path.isAbsolute(cleaned) && !this.inside(absolute) && !fs.existsSync(absolute)) {
      absolute = path.join(this.root, cleaned)
    }
    let real: string
    try {
      real = fs.realpathSync(absolute)
    } catch {
      throw new ToolInputError(`${cleaned} does not exist.`)
    }
    const rel = path.relative(this.root, absolute)
    if (!this.inside(real) || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new ToolInputError(`${cleaned} is outside the workspace.`)
    }
    const stat = fs.statSync(real)
    if (rel && this.ignored(rel, stat.isDirectory())) {
      throw new ToolInputError(`${cleaned} is ignored by .gitignore and cannot be read.`)
    }
    if (kind === "file" && !stat.isFile()) throw new ToolInputError(`${cleaned} is not a file.`)
    if (kind === "dir" && !stat.isDirectory()) throw new ToolInputError(`${cleaned} is not a directory.`)
    return absolute
  }

  /** Where a new file at `relative` would go, or why it cannot go there. */
  resolveNew(relative = ""): string {
    const cleaned = relative.trim().replace(/^\.\/+/, "")
    if (!cleaned || /[\\/]$/.test(cleaned)) throw new ToolInputError("A file path is needed, not a folder.")
    const absolute = path.resolve(this.root, cleaned)
    const rel = path.relative(this.root, absolute)
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new ToolInputError(`${cleaned} is outside the workspace.`)
    }
    if (fs.existsSync(absolute)) {
      throw new ToolInputError(`${cleaned} already exists; use edit_file to change it.`)
    }
    let parent = path.dirname(absolute)
    while (!fs.existsSync(parent)) parent = path.dirname(parent)
    if (!this.inside(fs.realpathSync(parent))) {
      throw new ToolInputError(`${cleaned} is outside the workspace.`)
    }
    if (this.ignored(rel)) {
      throw new ToolInputError(`${cleaned} is ignored by .gitignore; twinny does not write there.`)
    }
    return absolute
  }

  /** Files were made, moved or removed: the next search walks the tree again. */
  forgetFiles() {
    this._files = undefined
    this._tree = undefined
  }

  relative(absolute: string) {
    return path.relative(this.root, absolute).split(path.sep).join("/") || "."
  }

  /** Entries of a directory that are not ignored, directories first. */
  entries(dir: string): { name: string; dir: boolean }[] {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((dirent) => !this.ignored(path.relative(this.root, path.join(dir, dirent.name)), dirent.isDirectory()))
      .map((dirent) => ({ name: dirent.name, dir: dirent.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
  }

  /** Every searchable file, walked once per view. */
  files(): Promise<string[]> {
    this._files ??= this.tree().then(({ files }) => files.filter(isIndexablePath))
    return this._files
  }

  /** Every file that is not ignored, binary or not, for finding by name. */
  allFiles(): Promise<string[]> {
    return this.tree().then(({ files }) => files)
  }

  /** Every folder that is not ignored. */
  allDirs(): Promise<string[]> {
    return this.tree().then(({ dirs }) => dirs)
  }

  private tree() {
    this._tree ??= this.walk()
    return this._tree
  }

  private async walk() {
    const files: string[] = []
    const dirs: string[] = []
    const visit = async (dir: string) => {
      let dirents: fs.Dirent[]
      try {
        dirents = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const dirent of dirents) {
        const entry = path.join(dir, dirent.name)
        // Symbolic links are neither files nor directories here, so a
        // search never follows one out of the workspace.
        if (this.ignored(path.relative(this.root, entry), dirent.isDirectory())) continue
        if (dirent.isDirectory()) {
          dirs.push(entry)
          await visit(entry)
        } else if (dirent.isFile()) {
          files.push(entry)
        }
      }
    }
    await visit(this.root)
    return { files: files.sort(), dirs: dirs.sort() }
  }

  /**
   * A file's text: as the editor has it when it is open there, unsaved
   * changes included, else from disk. Undefined for a binary file or one
   * too large to be worth a model's context.
   */
  async text(file: string): Promise<string | undefined> {
    const open = await this._read?.(file)
    if (open !== undefined) return open
    try {
      const stat = await fs.promises.stat(file)
      if (stat.size > MAX_FILE_BYTES) return undefined
      const buffer = await fs.promises.readFile(file)
      if (looksBinary(buffer)) return undefined
      // The editor never shows a byte-order mark, so neither do the tools.
      const text = buffer.toString("utf8")
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    } catch {
      return undefined
    }
  }
}

/**
 * The workspace as the tools see it: one root folder, its .gitignore, and
 * the checks that keep every tool inside it. Shared by the tool sets.
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

/** A tool's input was wrong; the message goes back to the model to fix its call. */
export class ToolInputError extends Error {}

/** The workspace as the tools see it: a root, its ignore rules, its files. */
export class WorkspaceView {
  private readonly _ignore: Ignore
  private readonly _realRoot: string
  private _files?: Promise<string[]>
  private _allFiles?: Promise<string[]>

  constructor(
    readonly root: string,
    ignoredGlobs: string[] = [],
    private readonly _read?: (file: string) => Promise<string | undefined>
  ) {
    this._realRoot = fs.realpathSync(root)
    this._ignore = ignore().add([".git", "node_modules", ...ignoredGlobs])
    const gitignore = path.join(root, ".gitignore")
    if (fs.existsSync(gitignore)) this._ignore.add(fs.readFileSync(gitignore, "utf8"))
  }

  /** `relative` as an absolute path inside the root, or a reason it is not allowed. */
  resolve(relative = ".", kind: "file" | "dir" | "any"): string {
    const cleaned = relative.trim().replace(/^\.\/+/, "") || "."
    const absolute = path.resolve(this.root, cleaned)
    let real: string
    try {
      real = fs.realpathSync(absolute)
    } catch {
      throw new ToolInputError(`${cleaned} does not exist.`)
    }
    const inside = real === this._realRoot || real.startsWith(this._realRoot + path.sep)
    const rel = path.relative(this.root, absolute)
    if (!inside || rel.startsWith("..")) {
      throw new ToolInputError(`${cleaned} is outside the workspace.`)
    }
    const stat = fs.statSync(real)
    if (rel && this._ignore.ignores(stat.isDirectory() ? `${rel}/` : rel)) {
      throw new ToolInputError(`${cleaned} is ignored by .gitignore and cannot be read.`)
    }
    if (kind === "file" && !stat.isFile()) throw new ToolInputError(`${cleaned} is not a file.`)
    if (kind === "dir" && !stat.isDirectory()) throw new ToolInputError(`${cleaned} is not a directory.`)
    return absolute
  }

  /** Where a new file at `relative` would go, or why it cannot go there. */
  resolveNew(relative = ""): string {
    const cleaned = relative.trim().replace(/^\.\/+/, "")
    if (!cleaned || cleaned.endsWith("/")) throw new ToolInputError("A file path is needed, not a folder.")
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
    const real = fs.realpathSync(parent)
    if (real !== this._realRoot && !real.startsWith(this._realRoot + path.sep)) {
      throw new ToolInputError(`${cleaned} is outside the workspace.`)
    }
    if (this._ignore.ignores(rel)) {
      throw new ToolInputError(`${cleaned} is ignored by .gitignore; twinny does not write there.`)
    }
    return absolute
  }

  /** New files exist now: the next search walks the tree again. */
  forgetFiles() {
    this._files = undefined
    this._allFiles = undefined
  }

  relative(absolute: string) {
    return path.relative(this.root, absolute).split(path.sep).join("/") || "."
  }

  /** Entries of a directory that are not ignored, directories first. */
  entries(dir: string): { name: string; dir: boolean }[] {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((dirent) => {
        const rel = path.relative(this.root, path.join(dir, dirent.name))
        return !this._ignore.ignores(dirent.isDirectory() ? `${rel}/` : rel)
      })
      .map((dirent) => ({ name: dirent.name, dir: dirent.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
  }

  /** Every searchable file, walked once per view. */
  files(): Promise<string[]> {
    this._files ??= this.walk(true)
    return this._files
  }

  /** Every file that is not ignored, binary or not, for finding by name. */
  allFiles(): Promise<string[]> {
    this._allFiles ??= this.walk(false)
    return this._allFiles
  }

  private async walk(searchable: boolean) {
    const found: string[] = []
    const visit = async (dir: string) => {
      let dirents: fs.Dirent[]
      try {
        dirents = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const dirent of dirents) {
        const file = path.join(dir, dirent.name)
        const rel = path.relative(this.root, file)
        if (this._ignore.ignores(dirent.isDirectory() ? `${rel}/` : rel)) continue
        if (dirent.isDirectory()) await visit(file)
        else if (dirent.isFile() && (!searchable || isIndexablePath(file))) found.push(file)
      }
    }
    await visit(this.root)
    return found.sort()
  }

  async text(file: string): Promise<string | undefined> {
    const open = await this._read?.(file)
    if (open !== undefined) return open
    try {
      const stat = await fs.promises.stat(file)
      if (stat.size > MAX_FILE_BYTES) return undefined
      const buffer = await fs.promises.readFile(file)
      return looksBinary(buffer) ? undefined : buffer.toString("utf8")
    } catch {
      return undefined
    }
  }
}

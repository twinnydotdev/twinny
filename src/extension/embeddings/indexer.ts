import crypto from "crypto"
import fs from "fs"
import ignore, { Ignore } from "ignore"
import PQueue from "p-queue"
import path from "path"
import * as vscode from "vscode"

import { logger } from "../../common/logger"
import { readGitSubmodulesFile } from "../utils"

import { chunkDocument, getChunkOptions } from "./chunker"
import { ChunkRow, EmbeddingDatabase, FileStamp, IndexManifest } from "./database"
import { Embedder } from "./embedder"
import { isIndexablePath, looksBinary } from "./indexable"

/** Files embedded at once. Each one is a few batched requests. */
const FILE_CONCURRENCY = 4
/** Rows are written once this many files are ready, or at the end. */
const WRITE_EVERY_FILES = 25
/** Files bigger than this are skipped: minified bundles, data dumps. */
const MAX_FILE_BYTES = 512 * 1024

export type IndexPhase = "scanning" | "embedding" | "finishing"

export interface IndexProgress {
  phase: IndexPhase
  /** Files embedded so far, of the ones that changed. */
  processed: number
  total: number
  currentFiles: string[]
}

export interface IndexRunOptions {
  /** `update` embeds only what changed since the last run; `rebuild` starts over. */
  mode: "update" | "rebuild"
  token?: vscode.CancellationToken
  onProgress?: (progress: IndexProgress) => void
}

export interface IndexRunResult {
  /** Files (re)embedded in this run. */
  embedded: number
  chunks: number
  unchanged: number
  removed: number
  /** Files in the index after the run. */
  files: number
}

interface ScannedFile {
  file: string
  relative: string
  size: number
  mtimeMs: number
}

/**
 * Keeps the index in step with the workspace. A run scans the folders,
 * compares each file's stamp with the manifest, embeds what is new or
 * changed, drops what is gone, and stamps the manifest. Cancelling keeps
 * everything written so far, so the next run picks up where this one
 * stopped.
 */
export class WorkspaceIndexer {
  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _db: EmbeddingDatabase,
    private readonly _embedder: Embedder
  ) {}

  /* ------------------------------------------------------------------------ */
  /*  Scanning                                                                 */
  /* ------------------------------------------------------------------------ */

  private buildIgnore(rootPath: string): Ignore {
    const ig = ignore()
    const gitIgnorePath = path.join(rootPath, ".gitignore")
    if (fs.existsSync(gitIgnorePath)) {
      ig.add(fs.readFileSync(gitIgnorePath).toString())
    }
    ig.add(
      vscode.workspace
        .getConfiguration("twinny")
        .get<string[]>("embeddingIgnoredGlobs", [])
    )
    ig.add([".git", ".gitignore"])
    return ig
  }

  /** Whether one path would be picked up by a scan of its workspace folder. */
  public isIndexable(file: string): boolean {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))
    if (!folder || !isIndexablePath(file)) return false
    const root = folder.uri.fsPath
    const relative = path.relative(root, file)
    if (!relative || relative.startsWith("..")) return false
    const submodules = readGitSubmodulesFile()
    if (submodules?.some((submodule) => file.includes(submodule))) return false
    return !this.buildIgnore(root).ignores(relative)
  }

  private async scanFolder(root: string): Promise<ScannedFile[]> {
    const ig = this.buildIgnore(root)
    const submodules = readGitSubmodulesFile()
    const found: ScannedFile[] = []

    const walk = async (dir: string) => {
      let dirents: fs.Dirent[]
      try {
        dirents = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const dirent of dirents) {
        const file = path.join(dir, dirent.name)
        const relative = path.relative(root, file)
        if (submodules?.some((submodule) => file.includes(submodule))) continue
        if (ig.ignores(dirent.isDirectory() ? `${relative}/` : relative)) continue
        if (dirent.isDirectory()) {
          await walk(file)
        } else if (dirent.isFile() && isIndexablePath(file)) {
          try {
            const stats = await fs.promises.stat(file)
            if (stats.size > 0 && stats.size <= MAX_FILE_BYTES) {
              found.push({ file, relative, size: stats.size, mtimeMs: stats.mtimeMs })
            }
          } catch {
            // Vanished between readdir and stat; nothing to index.
          }
        }
      }
    }

    await walk(root)
    return found
  }

  private async scanWorkspace(): Promise<ScannedFile[]> {
    const folders = vscode.workspace.workspaceFolders || []
    const files: ScannedFile[] = []
    for (const folder of folders) files.push(...(await this.scanFolder(folder.uri.fsPath)))
    return files
  }

  /* ------------------------------------------------------------------------ */
  /*  Embedding one file                                                       */
  /* ------------------------------------------------------------------------ */

  private hash(buffer: Buffer): string {
    return crypto.createHash("sha1").update(buffer).digest("hex")
  }

  /**
   * The rows for one file, or nothing when it is unchanged, binary, or
   * empty. Each chunk is embedded with its path in front: the model then
   * knows `parse()` in `src/dates.ts` is about dates, which a bare snippet
   * cannot say.
   */
  private async embedFile(
    scanned: ScannedFile,
    previous: FileStamp | undefined
  ): Promise<{ stamp: FileStamp; rows: ChunkRow[] } | "unchanged" | "skipped"> {
    if (
      previous &&
      previous.size === scanned.size &&
      previous.mtimeMs === scanned.mtimeMs
    ) {
      return "unchanged"
    }

    const buffer = await fs.promises.readFile(scanned.file)
    if (looksBinary(buffer)) return "skipped"
    const hash = this.hash(buffer)
    if (previous && previous.hash === hash) {
      return "unchanged"
    }

    const content = buffer.toString("utf-8")
    const chunks = await chunkDocument(
      content,
      scanned.file,
      getChunkOptions(this._context)
    )
    if (!chunks.length) return "skipped"

    const label = scanned.relative.split(path.sep).join("/")
    const vectors = await this._embedder.embed(
      chunks.map((chunk) => `${label}\n${chunk.content}`),
      "document"
    )
    return {
      stamp: { hash, size: scanned.size, mtimeMs: scanned.mtimeMs, chunks: chunks.length },
      rows: chunks.map((chunk, i) => ({
        file: scanned.file,
        content: chunk.content,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        vector: vectors[i]
      }))
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Runs                                                                     */
  /* ------------------------------------------------------------------------ */

  /** Whether the index was built with a different model than the active one. */
  public get modelChanged(): boolean {
    const indexed = this._db.manifest.model
    const active = this._embedder.model
    return this._db.hasIndex && !!active && indexed !== active
  }

  public async run({ mode, token, onProgress }: IndexRunOptions): Promise<IndexRunResult> {
    const model = this._embedder.model
    if (!this._embedder.provider || !model) {
      throw new Error("No embedding provider is set. Add one in the providers tab.")
    }

    if (mode === "rebuild" || this.modelChanged || !this._db.manifest.dimensions) {
      await this._db.reset()
    }
    const manifest: IndexManifest = {
      ...this._db.manifest,
      model,
      files: { ...this._db.manifest.files }
    }

    onProgress?.({ phase: "scanning", processed: 0, total: 0, currentFiles: [] })
    const scanned = await this.scanWorkspace()
    const present = new Set(scanned.map((entry) => entry.file))
    const removed = Object.keys(manifest.files).filter((file) => !present.has(file))
    for (const file of removed) delete manifest.files[file]
    await this._db.removeFiles(removed)

    const stale = scanned.filter((entry) => {
      const previous = manifest.files[entry.file]
      return !previous || previous.size !== entry.size || previous.mtimeMs !== entry.mtimeMs
    })

    const total = stale.length
    let processed = 0
    let embedded = 0
    let chunks = 0
    let unchanged = scanned.length - stale.length
    let failure: Error | undefined
    const inFlight = new Set<string>()
    const report = () =>
      onProgress?.({
        phase: "embedding",
        processed,
        total,
        currentFiles: [...inFlight].slice(0, 3)
      })

    let pendingFiles: string[] = []
    let pendingRows: ChunkRow[] = []
    let pendingStamps: Record<string, FileStamp> = {}
    const flush = async () => {
      if (!pendingFiles.length) return
      const files = pendingFiles
      const rows = pendingRows
      const stamps = pendingStamps
      pendingFiles = []
      pendingRows = []
      pendingStamps = {}
      await this._db.replaceFiles(files, rows)
      Object.assign(manifest.files, stamps)
      if (!manifest.dimensions && rows[0]?.vector) {
        manifest.dimensions = rows[0].vector.length
      }
      await this._db.saveManifest(manifest)
    }

    const queue = new PQueue({ concurrency: FILE_CONCURRENCY })
    token?.onCancellationRequested(() => queue.clear())
    report()

    const work = stale.map((entry) =>
      queue.add(async () => {
        if (failure || token?.isCancellationRequested) return
        const name = path.basename(entry.file)
        inFlight.add(name)
        report()
        try {
          const result = await this.embedFile(entry, manifest.files[entry.file])
          if (result === "unchanged") {
            unchanged++
            manifest.files[entry.file] = {
              ...manifest.files[entry.file],
              size: entry.size,
              mtimeMs: entry.mtimeMs
            }
          } else if (result !== "skipped") {
            pendingFiles.push(entry.file)
            pendingRows.push(...result.rows)
            pendingStamps[entry.file] = result.stamp
            embedded++
            chunks += result.rows.length
            if (pendingFiles.length >= WRITE_EVERY_FILES) await flush()
          }
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error))
          queue.clear()
        } finally {
          inFlight.delete(name)
          processed++
          report()
        }
      })
    )
    await Promise.all(work)

    onProgress?.({ phase: "finishing", processed, total, currentFiles: [] })
    await flush()
    if (failure) throw failure

    await this._db.finishWrites()
    if (!token?.isCancellationRequested) manifest.updatedAt = Date.now()
    await this._db.saveManifest(manifest)

    return {
      embedded,
      chunks,
      unchanged,
      removed: removed.length,
      files: Object.keys(manifest.files).length
    }
  }

  /**
   * Re-embeds one file after it was saved. Silent and best-effort: a failure
   * here is logged, not shown, since the user did not ask for anything.
   */
  public async updateFile(file: string): Promise<boolean> {
    if (!this._db.hasIndex || this.modelChanged || !this.isIndexable(file)) return false
    const manifest = this._db.manifest
    try {
      const stats = await fs.promises.stat(file)
      if (stats.size === 0 || stats.size > MAX_FILE_BYTES) return false
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))!
      const result = await this.embedFile(
        {
          file,
          relative: path.relative(folder.uri.fsPath, file),
          size: stats.size,
          mtimeMs: stats.mtimeMs
        },
        manifest.files[file]
      )
      if (result === "unchanged" || result === "skipped") return false
      await this._db.replaceFiles([file], result.rows)
      manifest.files[file] = result.stamp
      await this._db.saveManifest(manifest)
      await this._db.finishWrites()
      logger.log(`Re-indexed ${path.basename(file)} (${result.rows.length} chunks)`)
      return true
    } catch (error) {
      logger.error(`Could not re-index ${file}: ${error}`)
      return false
    }
  }

  /** Forgets a file that was deleted from the workspace. */
  public async removeFile(file: string): Promise<boolean> {
    const manifest = this._db.manifest
    if (!manifest.files[file]) return false
    try {
      await this._db.removeFiles([file])
      delete manifest.files[file]
      await this._db.saveManifest(manifest)
      return true
    } catch (error) {
      logger.error(`Could not remove ${file} from the index: ${error}`)
      return false
    }
  }
}

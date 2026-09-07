import * as lancedb from "@lancedb/lancedb"
import { IntoVector } from "@lancedb/lancedb/dist/arrow"
import fs from "fs"
import ignore from "ignore"
import PQueue from "p-queue"
import path from "path"
import * as vscode from "vscode"

import { getProviderOrigin } from "../../common/provider-validation"
import {
  EmbeddedDocument,
  Embedding,
  LMStudioEmbedding,
  TwinnyProvider
} from "../../common/types"
import { Base } from "../providers/base"
import { describeProviderErrorPlain } from "../providers/errors"
import {
  getDocumentSplitChunks,
  readGitSubmodulesFile,
  sanitizeWorkspaceName
} from "../utils"

/** How many files are embedded at once. */
const INGEST_CONCURRENCY = 30
/** Rows are written to the database in batches of this many files. */
const WRITE_BATCH_FILES = 1000
/** Files bigger than this are skipped: minified bundles, data dumps. */
const MAX_FILE_BYTES = 512 * 1024
const EMBED_TIMEOUT_MS = 60_000

export interface IngestProgress {
  processed: number
  total: number
  currentFiles: string[]
}

export interface IngestOptions {
  token?: vscode.CancellationToken
  onProgress?: (progress: IngestProgress) => void
}

export interface IngestResult {
  files: number
  chunks: number
}

/**
 * The workspace's vector index: one table of code chunks and one of file
 * paths, both keyed by the workspace name so several workspaces can share
 * the database directory.
 */
export class EmbeddingDatabase extends Base {
  private _db: lancedb.Connection | null = null
  private readonly _dbPath: string
  private readonly _workspaceName = sanitizeWorkspaceName(vscode.workspace.name)
  private readonly _documentTable = `${this._workspaceName}-documents`
  private readonly _filePathTable = `${this._workspaceName}-file-paths`

  constructor(dbPath: string, context: vscode.ExtensionContext) {
    super(context)
    this._dbPath = dbPath
  }

  public async connect() {
    try {
      this._db = await lancedb.connect(this._dbPath)
    } catch (e) {
      console.error(e)
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Embedding requests                                                       */
  /* ------------------------------------------------------------------------ */

  /**
   * One vector for one piece of text, from the active embedding provider.
   * Throws with a readable reason when the provider is missing or fails, so
   * an index run stops at the first problem instead of writing empty rows.
   */
  public async fetchModelEmbedding(content: string): Promise<number[]> {
    const provider = this.getEmbeddingProvider()
    if (!provider) {
      throw new Error("No embedding provider is set. Add one in the providers tab.")
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS)
    try {
      const response = await fetch(
        `${getProviderOrigin({ ...provider, apiHostname: provider.apiHostname || "localhost" })}${
          provider.apiPath || "/api/embed"
        }`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(provider.apiKey
              ? { Authorization: `Bearer ${provider.apiKey}` }
              : {})
          },
          body: JSON.stringify({
            model: provider.modelName,
            input: content,
            stream: false
          }),
          signal: controller.signal
        }
      )
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 200)
        throw Object.assign(
          new Error(`${response.status} ${response.statusText} ${detail}`.trim()),
          { status: response.status }
        )
      }
      const vector = this.getEmbeddingFromResponse(await response.json())
      if (!vector.length) {
        throw new Error("The server answered but returned no embedding vector.")
      }
      return vector
    } catch (error) {
      throw new Error(describeProviderErrorPlain(error, provider))
    } finally {
      clearTimeout(timer)
    }
  }

  private getEmbeddingFromResponse(response: unknown): number[] {
    const body = response as Partial<LMStudioEmbedding> &
      Partial<Embedding> & { embedding?: number[] }
    // OpenAI-style servers (LM Studio, vLLM, OpenAI itself) wrap the vector
    // in `data`; Ollama's /api/embed returns `embeddings`; llama.cpp and the
    // legacy Ollama route return a bare `embedding`.
    return (
      body.data?.[0]?.embedding ?? body.embeddings?.[0] ?? body.embedding ?? []
    )
  }

  /* ------------------------------------------------------------------------ */
  /*  Indexing                                                                 */
  /* ------------------------------------------------------------------------ */

  private async getAllFilePaths(
    rootPath: string,
    dirPath: string,
    ig = this.buildIgnore(rootPath)
  ): Promise<string[]> {
    const submodules = readGitSubmodulesFile()
    const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true })
    const filePaths: string[] = []

    for (const dirent of dirents) {
      const fullPath = path.join(dirPath, dirent.name)
      const relativePath = path.relative(rootPath, fullPath)
      if (submodules?.some((submodule) => fullPath.includes(submodule))) continue
      if (ig.ignores(relativePath)) continue

      if (dirent.isDirectory()) {
        filePaths.push(...(await this.getAllFilePaths(rootPath, fullPath, ig)))
      } else if (dirent.isFile()) {
        filePaths.push(fullPath)
      }
    }
    return filePaths
  }

  private buildIgnore(rootPath: string) {
    const ig = ignore()
    const gitIgnorePath = path.join(rootPath, ".gitignore")
    if (fs.existsSync(gitIgnorePath)) {
      ig.add(fs.readFileSync(gitIgnorePath).toString())
    }
    ig.add(this.config.get("embeddingIgnoredGlobs", [] as string[]))
    ig.add([".git", ".gitignore"])
    return ig
  }

  /**
   * Re-indexes a folder from scratch. Resolves with what was written; rejects
   * on the first provider failure (after cancelling the remaining work) so
   * the caller can tell the user exactly what went wrong.
   */
  public async ingestDocuments(
    directoryPath: string,
    { token, onProgress }: IngestOptions = {}
  ): Promise<IngestResult> {
    const filePaths = await this.getAllFilePaths(directoryPath, directoryPath)
    const total = filePaths.length
    const inFlight = new Set<string>()
    const queue = new PQueue({ concurrency: INGEST_CONCURRENCY })
    const provider = this.getEmbeddingProvider()
    if (!provider) {
      throw new Error("No embedding provider is set. Add one in the providers tab.")
    }

    let processed = 0
    let chunkCount = 0
    let docsBatch: EmbeddedDocument[] = []
    let pathsBatch: EmbeddedDocument[] = []
    let failure: Error | undefined

    const report = () =>
      onProgress?.({ processed, total, currentFiles: [...inFlight].slice(0, 5) })

    await this.clearDatabase()
    report()

    const flush = async () => {
      if (!docsBatch.length && !pathsBatch.length) return
      const docs = docsBatch
      const paths = pathsBatch
      docsBatch = []
      pathsBatch = []
      await this.populateDatabase(docs, paths)
    }

    const embedFile = async (filePath: string) => {
      if (failure || token?.isCancellationRequested) return
      const name = path.basename(filePath)
      inFlight.add(name)
      report()
      try {
        const stats = await fs.promises.stat(filePath)
        if (stats.size === 0 || stats.size > MAX_FILE_BYTES) return

        const content = await fs.promises.readFile(filePath, "utf-8")
        const chunks = [
          ...new Set(await getDocumentSplitChunks(content, filePath, this.context))
        ]

        pathsBatch.push({
          content: filePath,
          vector: await this.fetchModelEmbedding(filePath),
          file: filePath
        })
        for (const chunk of chunks) {
          if (failure || token?.isCancellationRequested) return
          docsBatch.push({
            content: chunk,
            vector: await this.fetchModelEmbedding(chunk),
            file: filePath
          })
          chunkCount++
        }
        if (pathsBatch.length >= WRITE_BATCH_FILES) await flush()
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
        queue.clear()
      } finally {
        inFlight.delete(name)
        processed++
        report()
      }
    }

    token?.onCancellationRequested(() => queue.clear())
    await Promise.all(filePaths.map((filePath) => queue.add(() => embedFile(filePath))))

    if (failure) throw failure
    await flush()
    return { files: processed, chunks: chunkCount }
  }

  /* ------------------------------------------------------------------------ */
  /*  Tables                                                                   */
  /* ------------------------------------------------------------------------ */

  public async clearDatabase() {
    try {
      const tableNames = (await this._db?.tableNames()) || []
      for (const table of [this._documentTable, this._filePathTable]) {
        if (tableNames.includes(table)) await this._db?.dropTable(table)
      }
    } catch (e) {
      console.log("Error clearing database", e)
    }
  }

  private async appendRows(tableName: string, rows: EmbeddedDocument[]) {
    if (!this._db || !rows.length) return
    const tableNames = await this._db.tableNames()
    if (!tableNames.includes(tableName)) {
      await this._db.createTable(tableName, rows, { mode: "overwrite" })
    } else {
      const table = await this._db.openTable(tableName)
      await table.add(rows)
    }
  }

  public async populateDatabase(
    documents: EmbeddedDocument[],
    filePaths: EmbeddedDocument[]
  ) {
    try {
      await this.appendRows(this._documentTable, documents)
      await this.appendRows(this._filePathTable, filePaths)
    } catch (e) {
      console.log("Error populating database", e)
    }
  }

  public async hasEmbeddingTable(name: string): Promise<boolean | undefined> {
    const tableNames = await this._db?.tableNames()
    return tableNames?.includes(name)
  }

  /** How much of the workspace is indexed, for the embeddings tab. */
  public async countRows(): Promise<{ files: number; chunks: number }> {
    const count = async (name: string) => {
      try {
        if (!(await this.hasEmbeddingTable(name))) return 0
        const table = await this._db!.openTable(name)
        return await table.countRows()
      } catch {
        return 0
      }
    }
    return {
      files: await count(this._filePathTable),
      chunks: await count(this._documentTable)
    }
  }

  public async getDocuments(
    vector: IntoVector,
    limit: number,
    tableName: string,
    where?: string
  ): Promise<EmbeddedDocument[] | undefined> {
    try {
      const table = await this._db?.openTable(tableName)
      const query = table?.vectorSearch(vector).limit(limit)
      if (where) query?.where(where)
      return query?.toArray()
    } catch {
      return undefined
    }
  }

  /** Exposed for the chat's workspace search, which reads the same provider. */
  public get provider(): TwinnyProvider | undefined {
    return this.getEmbeddingProvider()
  }
}

import * as lancedb from "@lancedb/lancedb"
import fs from "fs"
import path from "path"

import { logger } from "../../common/logger"

import { Candidate, sqlString } from "./rank"

const CHUNK_TABLE = "chunks"
const MANIFEST_FILE = "manifest.json"
const MANIFEST_VERSION = 2

/** One indexed chunk as stored. `file` is absolute so it can be re-read. */
export interface ChunkRow extends Record<string, unknown> {
  file: string
  content: string
  startLine: number
  endLine: number
  vector: number[]
}

/** What is known about one indexed file, to tell whether it changed. */
export interface FileStamp {
  hash: string
  size: number
  mtimeMs: number
  chunks: number
}

/**
 * The index's own record of what it holds. Lives next to the LanceDB
 * tables. It is what makes an index run incremental: files whose stamp
 * matches are not read again, let alone embedded.
 */
export interface IndexManifest {
  version: number
  /** The embedding model the vectors came from. Vectors from two models don't mix. */
  model: string
  dimensions: number
  files: Record<string, FileStamp>
  updatedAt?: number
}

const emptyManifest = (model = "", dimensions = 0): IndexManifest => ({
  version: MANIFEST_VERSION,
  model,
  dimensions,
  files: {}
})

/**
 * The workspace's vector store: one LanceDB table of chunks with both a
 * vector index and a full-text index over the same rows, plus the manifest.
 * Purely storage; embedding and searching logic lives in the indexer and
 * the search.
 */
export class EmbeddingDatabase {
  private _db: lancedb.Connection | null = null
  private _manifest: IndexManifest | null = null

  constructor(private readonly _dbPath: string) {}

  public async connect() {
    this._db = await lancedb.connect(this._dbPath)
    // Indexes from before the manifest existed are one table per workspace
    // name; they cannot be updated incrementally, so start over.
    if (!fs.existsSync(this.manifestPath)) {
      for (const name of await this._db.tableNames()) {
        await this._db.dropTable(name).catch(() => undefined)
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Manifest                                                                 */
  /* ------------------------------------------------------------------------ */

  private get manifestPath() {
    return path.join(this._dbPath, MANIFEST_FILE)
  }

  public get manifest(): IndexManifest {
    if (this._manifest) return this._manifest
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.manifestPath, "utf-8")
      ) as IndexManifest
      this._manifest =
        parsed.version === MANIFEST_VERSION ? parsed : emptyManifest()
    } catch {
      this._manifest = emptyManifest()
    }
    return this._manifest
  }

  public async saveManifest(manifest: IndexManifest) {
    this._manifest = manifest
    await fs.promises.mkdir(this._dbPath, { recursive: true })
    const tmp = `${this.manifestPath}.tmp`
    await fs.promises.writeFile(tmp, JSON.stringify(manifest))
    await fs.promises.rename(tmp, this.manifestPath)
  }

  /** Whether anything has been indexed. */
  public get hasIndex(): boolean {
    return Object.keys(this.manifest.files).length > 0
  }

  /* ------------------------------------------------------------------------ */
  /*  Writes                                                                   */
  /* ------------------------------------------------------------------------ */

  private async table(): Promise<lancedb.Table | undefined> {
    if (!this._db) return undefined
    const names = await this._db.tableNames()
    if (!names.includes(CHUNK_TABLE)) return undefined
    return this._db.openTable(CHUNK_TABLE)
  }

  /** Replaces every chunk of the given files with `rows`. */
  public async replaceFiles(files: string[], rows: ChunkRow[]) {
    if (!this._db) throw new Error("The embedding database is not open.")
    const table = await this.table()
    if (table && files.length) {
      await table.delete(`file IN (${files.map(sqlString).join(", ")})`)
    }
    if (!rows.length) return
    if (table) {
      await table.add(rows)
    } else {
      await this._db.createTable(CHUNK_TABLE, rows, { mode: "overwrite" })
    }
  }

  public async removeFiles(files: string[]) {
    if (!files.length) return
    const table = await this.table()
    await table?.delete(`file IN (${files.map(sqlString).join(", ")})`)
  }

  /** Drops everything, ready for a rebuild. */
  public async reset() {
    if (this._db) {
      for (const name of await this._db.tableNames()) {
        await this._db.dropTable(name).catch(() => undefined)
      }
    }
    await this.saveManifest(emptyManifest())
  }

  /**
   * Builds the keyword index over what was written and compacts the table.
   * Cheap on an unchanged table; run it at the end of every index run.
   */
  public async finishWrites() {
    const table = await this.table()
    if (!table) return
    const indices = await table.listIndices()
    if (!indices.some((index) => index.columns.includes("content"))) {
      await table.createIndex("content", { config: lancedb.Index.fts() })
    }
    await table.optimize()
  }

  /* ------------------------------------------------------------------------ */
  /*  Reads                                                                    */
  /* ------------------------------------------------------------------------ */

  public async countChunks(): Promise<number> {
    try {
      return (await (await this.table())?.countRows()) ?? 0
    } catch {
      return 0
    }
  }

  private toCandidates(rows: Record<string, unknown>[]): Candidate[] {
    return rows.map((row) => ({
      file: String(row.file),
      content: String(row.content),
      startLine: Number(row.startLine),
      endLine: Number(row.endLine)
    }))
  }

  /** Nearest chunks by vector distance, best first. */
  public async vectorSearch(vector: number[], limit: number): Promise<Candidate[]> {
    try {
      const table = await this.table()
      if (!table) return []
      return this.toCandidates(await table.vectorSearch(vector).limit(limit).toArray())
    } catch (error) {
      logger.error(`Vector search failed: ${error}`)
      return []
    }
  }

  /** Chunks matching the query's words (BM25), best first. */
  public async textSearch(query: string, limit: number): Promise<Candidate[]> {
    if (!query.trim()) return []
    try {
      const table = await this.table()
      if (!table) return []
      return this.toCandidates(
        await table.search(query, "fts", "content").limit(limit).toArray()
      )
    } catch (error) {
      logger.error(`Keyword search failed: ${error}`)
      return []
    }
  }
}

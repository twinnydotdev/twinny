import * as fs from "fs/promises"
import * as path from "path"
import { ExtensionContext, workspace } from "vscode"

import {
  DEFAULT_RELEVANT_CODE_COUNT,
  DEFAULT_RELEVANT_FILE_COUNT,
  DEFAULT_RERANK_THRESHOLD,
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME
} from "../../common/constants"
import { logger } from "../../common/logger"
import { EmbeddingDatabase } from "../embeddings/database"
import { Reranker } from "../embeddings/reranker"
import { sanitizeWorkspaceName } from "../utils"

/** A file path and how relevant the reranker thinks it is to the query. */
export type ScoredFile = [path: string, score: number]

/** Files bigger than this are summarised by their indexed chunks instead. */
const MAX_WHOLE_FILE_BYTES = 5 * 1024

/**
 * `@workspace`: what the embedding index knows that is relevant to a
 * question. Two passes — nearest file paths, then nearest code chunks
 * (biased towards those files) — each reranked with a cross-encoder so the
 * threshold is a real relevance score, not a vector distance.
 */
export class WorkspaceSearch {
  private readonly _workspaceName = sanitizeWorkspaceName(workspace.name)

  constructor(
    private readonly _context: ExtensionContext,
    private readonly _db: EmbeddingDatabase | undefined,
    private readonly _reranker: Reranker
  ) {}

  private setting(key: string, fallback: number): number {
    const stored = this._context.globalState.get(
      `${EVENT_NAME.twinnyGlobalContext}-${key}`
    )
    return Number(stored) || fallback
  }

  private get rerankThreshold() {
    return this.setting(
      EXTENSION_CONTEXT_NAME.twinnyRerankThreshold,
      DEFAULT_RERANK_THRESHOLD
    )
  }

  private get ready() {
    return !!this._db && !!this._workspaceName
  }

  /** The query vector, or nothing when the provider is down — search then degrades to no hits. */
  private async embed(query: string): Promise<number[] | undefined> {
    try {
      return await this._db!.fetchModelEmbedding(query)
    } catch (error) {
      logger.error(`Workspace search skipped: ${error}`)
      return undefined
    }
  }

  public async relevantFiles(query: string): Promise<ScoredFile[]> {
    if (!this.ready || !query) return []
    const table = `${this._workspaceName}-file-paths`
    if (!(await this._db!.hasEmbeddingTable(table))) return []

    const embedding = await this.embed(query)
    if (!embedding) return []

    const count = this.setting(
      EXTENSION_CONTEXT_NAME.twinnyRelevantFilePaths,
      DEFAULT_RELEVANT_FILE_COUNT
    )
    const documents = (await this._db!.getDocuments(embedding, count, table)) || []
    const filePaths = documents.map((document) => document.content)
    if (!filePaths.length) return []

    logger.log(`Reranking threshold: ${this.rerankThreshold}`)
    const scores = await this._reranker.rerank(
      query,
      filePaths.map((filePath) => path.basename(filePath))
    )
    if (!scores) return []
    return filePaths.map((filePath, i) => [filePath, scores[i]] as ScoredFile)
  }

  public async relevantCode(
    query: string,
    files: ScoredFile[]
  ): Promise<string> {
    if (!this.ready || !query) return ""
    const table = `${this._workspaceName}-documents`
    if (!(await this._db!.hasEmbeddingTable(table))) return ""

    const embedding = await this.embed(query)
    if (!embedding) return ""

    const count = Math.round(
      this.setting(
        EXTENSION_CONTEXT_NAME.twinnyRelevantCodeSnippets,
        DEFAULT_RELEVANT_CODE_COUNT
      ) / 2
    )
    const inFiles = files.length
      ? `file IN ("${files.map(([file]) => file).join("\",\"")}")`
      : ""
    const [scoped, global] = await Promise.all([
      this._db!.getDocuments(embedding, count, table, inFiles),
      this._db!.getDocuments(embedding, count, table)
    ])
    const documents = [...(global || []), ...(scoped || [])]

    const scores = await this._reranker.rerank(
      query,
      documents.map((item) => item.content?.trim() || "")
    )
    if (!scores) return ""

    const threshold = this.rerankThreshold
    const wholeFiles = await Promise.all(
      files
        .filter(([, score]) => score > threshold)
        .map(([file]) => this.readSmallFile(file))
    )
    const chunks = documents
      .filter((_, i) => scores[i] > threshold)
      .map(({ content }) => content)

    return [...wholeFiles, ...chunks]
      .filter(Boolean)
      .join("\n\n")
      .trim()
  }

  private async readSmallFile(filePath: string): Promise<string | null> {
    try {
      const stats = await fs.stat(filePath)
      if (stats.size > MAX_WHOLE_FILE_BYTES) return null
      if (stats.size === 0) return ""
      return await fs.readFile(filePath, "utf-8")
    } catch {
      return null
    }
  }
}

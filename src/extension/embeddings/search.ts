import * as fs from "fs/promises"
import { workspace } from "vscode"

import { logger } from "../../common/logger"

import { EmbeddingDatabase } from "./database"
import { Embedder } from "./embedder"
import {
  Candidate,
  fitHitsToBudget,
  fuseRankings,
  Hit,
  keywordQuery,
  mergeAdjacentHits
} from "./rank"
import { Reranker } from "./reranker"

/** Rows fetched from each of the two retrievers before fusion. */
const RETRIEVE_LIMIT = 20
/**
 * Fused candidates that go through the cross-encoder. Each one costs a
 * few hundred milliseconds of CPU, so this is the speed/recall dial.
 */
const RERANK_LIMIT = 12

export interface SearchOptions {
  /** Hits returned at most. */
  limit: number
  /** Minimum reranker probability, 0..1. */
  threshold: number
  /** Characters of chunk content across all hits. */
  maxChars: number
  /** Told about each stage as the search moves through it. */
  onProgress?: (progress: SearchProgress) => void
}

export type SearchProgress =
  /** Turning the question into a vector; slow when the server is cold. */
  | { stage: "embedding" }
  /** Both retrievers are running. */
  | { stage: "retrieving" }
  /** The cross-encoder is reading this many candidates. */
  | { stage: "reranking"; candidates: number }

export interface SearchResult {
  hits: Hit[]
  /** Fused candidates that went to the reranker. */
  candidates: number
  /** Scored candidates that fell under the threshold, best first. */
  nearMisses: Hit[]
  /** Something the user should know about how the search ran. */
  note?: string
}

/** Near misses kept for the user to see why nothing was found. */
const NEAR_MISS_LIMIT = 3

export { Hit }

/**
 * Answers "what in the workspace is about this?" Three stages:
 *
 * 1. Retrieve. Nearest chunks by embedding, and chunks that share the
 *    question's identifiers (BM25). Vectors find paraphrases; keywords find
 *    the exact function the user named. Both lists are fused by rank.
 * 2. Rerank. A cross-encoder reads the question with each candidate and
 *    gives an absolute relevance score, so a threshold has one meaning.
 * 3. Tidy. Adjacent hits from one file become one block, and the result is
 *    cut to a character budget so the prompt stays a prompt.
 */
export class WorkspaceSearch {
  constructor(
    private readonly _db: EmbeddingDatabase,
    private readonly _embedder: Embedder,
    private readonly _reranker: Reranker
  ) {}

  /** Whether a search can return anything right now. */
  public get available(): boolean {
    return this._db.hasIndex
  }

  public async search(query: string, options: SearchOptions): Promise<Hit[]> {
    return (await this.searchDetailed(query, options)).hits
  }

  /** The hits plus what it took to find them, for the chat to show. */
  public async searchDetailed(
    query: string,
    options: SearchOptions
  ): Promise<SearchResult> {
    const text = query.trim()
    const empty: SearchResult = { hits: [], candidates: 0, nearMisses: [] }
    if (!text || !this.available) return empty
    const progress = options.onProgress ?? (() => undefined)

    progress({ stage: "embedding" })
    const notes: string[] = []
    const vector = await this.embedQuery(text, notes)
    progress({ stage: "retrieving" })
    const [byVector, byKeyword] = await Promise.all([
      vector ? this._db.vectorSearch(vector, RETRIEVE_LIMIT) : [],
      this._db.textSearch(keywordQuery(text), RETRIEVE_LIMIT)
    ])
    const candidates = fuseRankings([byVector, byKeyword]).slice(0, RERANK_LIMIT)
    if (!candidates.length) return { ...empty, note: notes[0] }

    progress({ stage: "reranking", candidates: candidates.length })
    const scored = await this.score(text, candidates, notes)
    const kept = scored
      .filter((hit) => hit.score >= options.threshold)
      .sort((a, b) => b.score - a.score)
    const nearMisses = scored
      .filter((hit) => hit.score < options.threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, NEAR_MISS_LIMIT)

    const sources = new Map<string, string[] | undefined>()
    for (const file of new Set(kept.map((hit) => hit.file))) {
      sources.set(file, await this.readLines(file))
    }
    const merged = mergeAdjacentHits(kept, (file) => sources.get(file))
    return {
      hits: fitHitsToBudget(merged.slice(0, options.limit), options.maxChars),
      candidates: candidates.length,
      nearMisses,
      note: notes[0]
    }
  }

  private async embedQuery(
    text: string,
    notes: string[]
  ): Promise<number[] | undefined> {
    try {
      return await this._embedder.embedOne(text, "query")
    } catch (error) {
      // Keyword search still works when the embedding server is down.
      logger.error(`Semantic search skipped: ${error}`)
      notes.push("The embedding server did not answer, so only keywords were matched.")
      return undefined
    }
  }

  private async score(
    text: string,
    candidates: Candidate[],
    notes: string[]
  ): Promise<Hit[]> {
    const scores = await this._reranker.rerank(
      text,
      candidates.map(
        (candidate) => `${workspace.asRelativePath(candidate.file)}\n${candidate.content}`
      )
    )
    if (!scores) {
      // No reranker: trust the fused order and let every candidate through
      // by giving it a score above any sane threshold.
      notes.push("The reranker is unavailable, so scores are retrieval order.")
      return candidates.map((candidate, i) => ({
        ...candidate,
        score: 1 - i / candidates.length
      }))
    }
    return candidates.map((candidate, i) => ({ ...candidate, score: scores[i] }))
  }

  /** Current lines of a file: the editor buffer when open, else the disk. */
  private async readLines(file: string): Promise<string[] | undefined> {
    const open = workspace.textDocuments.find((document) => document.uri.fsPath === file)
    if (open) return open.getText().split("\n")
    try {
      return (await fs.readFile(file, "utf-8")).split("\n")
    } catch {
      return undefined
    }
  }
}

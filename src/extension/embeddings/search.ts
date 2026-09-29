import * as fs from "fs/promises"
import { workspace } from "vscode"

import { messageOf } from "../../common/errors"
import { logger } from "../../common/logger"
import { getParser } from "../completion/parser"

import { EmbeddingDatabase } from "./database"
import { Embedder } from "./embedder"
import { enclosingRange, importRange, SyntaxLike } from "./expand"
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
/** Rows fetched from the focus files alone, by each retriever. */
const FOCUS_LIMIT = 6
/** Focus files searched; the list is ordered, so the tail is the least hot. */
const FOCUS_FILE_LIMIT = 8
/** Characters of a file's imports worth adding under its hits. */
const IMPORT_CHARS = 1200

export interface SearchOptions {
  /** Hits returned at most. */
  limit: number
  /** Minimum reranker probability, 0..1. */
  threshold: number
  /** Characters of chunk content across all hits. */
  maxChars: number
  /**
   * Absolute paths of the files the user is working in, hottest first: the
   * active editor, the visible ones, the files the last answer used. Their
   * chunks are retrieved on their own as well, so the file under the
   * cursor is always among the candidates, and the fusion weighs them up.
   */
  focus?: string[]
  /**
   * Characters a hit may grow to when widened to the function or class
   * around it, with the file's imports added once. Off when unset.
   */
  expandChars?: number
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

/** A parsed file, released once the hits in it have been widened. */
export interface ParsedFile {
  root: SyntaxLike
  dispose(): void
}

/** Parses a file for expansion; undefined when there is no grammar for it. */
export type FileParser = (file: string, text: string) => Promise<ParsedFile | undefined>

const parseWithTreeSitter: FileParser = async (file, text) => {
  const parser = await getParser(file)
  if (!parser) return undefined
  const tree = parser.parse(text)
  return { root: tree.rootNode, dispose: () => tree.delete() }
}

export { Hit }

/**
 * Answers "what in the workspace is about this?" Four stages:
 *
 * 1. Retrieve. Nearest chunks by embedding, and chunks that share the
 *    question's identifiers (BM25). Vectors find paraphrases; keywords find
 *    the exact function the user named. The focus files get their own pass
 *    of each. All lists are fused by rank.
 * 2. Rerank. A cross-encoder reads the question with each candidate and
 *    gives an absolute relevance score, so a threshold has one meaning.
 * 3. Widen. A hit grows to the definition around it when that fits, and
 *    each file's imports come along once, so the model reads whole code.
 * 4. Tidy. Adjacent hits from one file become one block, and the result is
 *    cut to a character budget so the prompt stays a prompt.
 */
export class WorkspaceSearch {
  private readonly _reportedParseErrors = new Set<string>()
  constructor(
    private readonly _db: EmbeddingDatabase,
    private readonly _embedder: Embedder,
    private readonly _reranker: Reranker,
    private readonly _parse: FileParser = parseWithTreeSitter
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
    const keywords = keywordQuery(text)
    const focus = (options.focus ?? []).slice(0, FOCUS_FILE_LIMIT)
    const lists = await Promise.all([
      vector ? this._db.vectorSearch(vector, RETRIEVE_LIMIT) : [],
      this._db.textSearch(keywords, RETRIEVE_LIMIT),
      vector && focus.length ? this._db.vectorSearch(vector, FOCUS_LIMIT, focus) : [],
      focus.length ? this._db.textSearch(keywords, FOCUS_LIMIT, focus) : []
    ])
    const candidates = fuseRankings(lists).slice(0, RERANK_LIMIT)
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
    const { widened, imports } = await this.widen(kept, sources, options.expandChars)
    const merged = mergeAdjacentHits(widened, (file) => sources.get(file)).slice(
      0,
      options.limit
    )
    // Imports come last so the budget spends itself on the code first, and
    // only for files whose hits do not already show them.
    const trailing = [...imports.values()].filter(
      (block) =>
        merged.some((hit) => hit.file === block.file) &&
        !merged.some(
          (hit) =>
            hit.file === block.file &&
            hit.startLine <= block.startLine &&
            hit.endLine >= block.endLine
        )
    )
    return {
      hits: fitHitsToBudget([...merged, ...trailing], options.maxChars),
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

  /**
   * Each hit grown to the definition around it, and per file an imports
   * block carrying the file's best score. Files without a grammar, or that
   * cannot be parsed, keep their hits as they were.
   */
  private async widen(
    hits: Hit[],
    sources: Map<string, string[] | undefined>,
    maxChars: number | undefined
  ): Promise<{ widened: Hit[]; imports: Map<string, Hit> }> {
    const imports = new Map<string, Hit>()
    if (!maxChars) return { widened: hits, imports }

    const widened: Hit[] = []
    const byFile = new Map<string, Hit[]>()
    for (const hit of hits) byFile.set(hit.file, [...(byFile.get(hit.file) || []), hit])

    for (const [file, fileHits] of byFile) {
      const lines = sources.get(file)
      const parsed = lines && (await this.parseSafely(file, lines.join("\n")))
      if (!lines || !parsed) {
        widened.push(...fileHits)
        continue
      }
      try {
        const slice = ([from, to]: [number, number]) => lines.slice(from, to + 1).join("\n")
        for (const hit of fileHits) {
          const range = enclosingRange(parsed.root, lines, hit.startLine, hit.endLine, maxChars)
          widened.push(
            range
              ? { ...hit, startLine: range[0], endLine: range[1], content: slice(range) }
              : hit
          )
        }
        const range = importRange(parsed.root, lines, IMPORT_CHARS)
        if (range) {
          imports.set(file, {
            file,
            startLine: range[0],
            endLine: range[1],
            content: slice(range),
            score: Math.max(...fileHits.map((hit) => hit.score)),
            kind: "imports"
          })
        }
      } finally {
        parsed.dispose()
      }
    }
    return { widened, imports }
  }

  private async parseSafely(file: string, text: string): Promise<ParsedFile | undefined> {
    try {
      return await this._parse(file, text)
    } catch (error) {
      // One missing grammar fails every file of that language; say it once.
      const message = messageOf(error)
      if (!this._reportedParseErrors.has(message)) {
        this._reportedParseErrors.add(message)
        logger.warn(`Could not parse ${file} to widen hits (hits stay as chunks): ${message}`)
      }
      return undefined
    }
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

/**
 * The pure maths behind workspace search: fusing the vector and full-text
 * result lists, turning reranker logits into probabilities, and tidying the
 * final hit list. No I/O here, so all of it is unit-tested.
 */

export interface Hit {
  file: string
  content: string
  /** Zero-based, inclusive. */
  startLine: number
  endLine: number
  /** Reranker probability that the chunk answers the query, 0..1. */
  score: number
}

/** A row as the vector store returns it, before scoring. */
export type Candidate = Omit<Hit, "score">

const candidateKey = (candidate: Candidate) =>
  `${candidate.file}:${candidate.startLine}-${candidate.endLine}:${candidate.content.length}`

/**
 * Reciprocal rank fusion. Each result list votes for its members by rank;
 * a chunk near the top of both the semantic and the keyword list wins over
 * one that is top of only one. `k` damps the advantage of rank 1 over rank
 * 2 so a single list cannot dominate.
 */
export const fuseRankings = (
  lists: Candidate[][],
  k = 60
): Candidate[] => {
  const scores = new Map<string, { candidate: Candidate; score: number }>()
  for (const list of lists) {
    list.forEach((candidate, rank) => {
      const key = candidateKey(candidate)
      const entry = scores.get(key) || { candidate, score: 0 }
      entry.score += 1 / (k + rank + 1)
      scores.set(key, entry)
    })
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.candidate)
}

/** A cross-encoder logit as a probability of relevance. */
export const sigmoid = (logit: number) => 1 / (1 + Math.exp(-logit))

/**
 * Two hits from the same file that touch or overlap read better as one
 * block than as two fragments with a seam, up to `maxChars` so a run of
 * hits cannot become a whole file. The merged hit keeps the higher score.
 * Hits are re-sorted by score afterwards.
 */
export const mergeAdjacentHits = (
  hits: Hit[],
  lines: (file: string) => string[] | undefined,
  maxChars = 4000
): Hit[] => {
  const byFile = new Map<string, Hit[]>()
  for (const hit of hits) {
    byFile.set(hit.file, [...(byFile.get(hit.file) || []), hit])
  }

  const merged: Hit[] = []
  for (const [file, fileHits] of byFile) {
    const source = lines(file)
    const ordered = [...fileHits].sort((a, b) => a.startLine - b.startLine)
    let current = ordered[0]
    for (const next of ordered.slice(1)) {
      const endLine = Math.max(current.endLine, next.endLine)
      const joined = source?.slice(current.startLine, endLine + 1).join("\n")
      if (joined !== undefined && next.startLine <= current.endLine + 1 && joined.length <= maxChars) {
        current = {
          ...current,
          endLine,
          content: joined,
          score: Math.max(current.score, next.score)
        }
      } else {
        merged.push(current)
        current = next
      }
    }
    merged.push(current)
  }
  return merged.sort((a, b) => b.score - a.score)
}

/**
 * Keeps the best hits that fit in `maxChars`, so a question never drags
 * half the workspace into the prompt. Order is preserved.
 */
export const fitHitsToBudget = (hits: Hit[], maxChars: number): Hit[] => {
  const kept: Hit[] = []
  let remaining = maxChars
  for (const hit of hits) {
    if (hit.content.length > remaining) continue
    kept.push(hit)
    remaining -= hit.content.length
  }
  return kept
}

/**
 * The words in a question that a keyword index can match: identifiers kept
 * whole and also split on case and underscores (`fetchModelEmbedding` →
 * `fetch`, `model`, `embedding`), everything else dropped. Empty when the
 * question has no searchable words, in which case the keyword pass is
 * skipped.
 */
export const keywordQuery = (text: string): string => {
  const words = new Set<string>()
  for (const token of text.match(/[A-Za-z_][A-Za-z0-9_]{1,}/g) || []) {
    words.add(token)
    const parts = token
      .split(/_+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
      .filter((part) => part.length > 2)
    for (const part of parts) words.add(part.toLowerCase())
  }
  return [...words].join(" ")
}

/** A string literal for a LanceDB `where` clause. */
export const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`

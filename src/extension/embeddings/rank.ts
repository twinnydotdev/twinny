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
  /**
   * Set on a block added for the reader's sake rather than found: the
   * imports of a file another hit came from. Its score is that hit's.
   */
  kind?: "imports"
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
          score: Math.max(current.score, next.score),
          kind: current.kind === next.kind ? current.kind : undefined
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

/** Words that carry no meaning for a search on their own. */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "so", "then", "also", "of", "in",
  "on", "to", "for", "with", "from", "by", "at", "as", "is", "are", "was",
  "were", "be", "been", "do", "does", "did", "can", "could", "should",
  "would", "will", "how", "what", "where", "why", "when", "which", "who",
  "i", "me", "my", "we", "you", "your", "it", "its", "this", "that",
  "these", "those", "they", "them", "there", "ok", "okay", "please", "about"
])

/**
 * The words inside one identifier: `fetchModelEmbedding` → `fetch`,
 * `model`, `embedding`; `MAX_FILE_BYTES` → `max`, `file`, `bytes`. Digits
 * stay attached (`utf8Decoder` → `utf8`, `decoder`; `i18n` stays whole)
 * and single letters are dropped, they match everything.
 */
export const splitIdentifier = (token: string): string[] =>
  token
    .split(/_+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 1)

/** Identifier-like runs of a text, in order. */
const identifiers = (text: string): string[] =>
  text.match(/[A-Za-z_][A-Za-z0-9_]+/g) || []

/**
 * What the keyword index stores for a chunk: every identifier lowercased
 * and whole, followed by its parts, so `statusBar` in the code is found by
 * "status bar" and by "statusBar" alike. Repetition is kept on purpose, it
 * is what BM25 weighs. The tokenizer over this column splits on spaces and
 * punctuation and stems, so only the words themselves matter here.
 */
export const keywordText = (text: string): string => {
  const words: string[] = []
  for (const token of identifiers(text)) {
    const whole = token.toLowerCase()
    const parts = splitIdentifier(token)
    words.push(whole)
    if (parts.length > 1 || parts[0] !== whole) words.push(...parts)
  }
  return words.join(" ")
}

/**
 * Words of a file path worth matching: `src/extension/status-bar.ts` →
 * `src`, `extension`, `status`, `bar`, `ts`. Lets "where is the auth
 * stuff" find `auth/` and "csp" find `csp.ts` when the code inside never
 * says so.
 */
export const pathKeywords = (relativePath: string): string => {
  const words = new Set<string>()
  for (const token of relativePath.split(/[^A-Za-z0-9_]+/)) {
    if (!token) continue
    words.add(token.toLowerCase())
    for (const part of splitIdentifier(token)) words.add(part)
  }
  return [...words].join(" ")
}

/**
 * The words in a question that the keyword index can match, in the same
 * shape as `keywordText` stores them: identifiers whole and split, stop
 * words dropped. Empty when the question has no searchable words, in which
 * case the keyword pass is skipped.
 */
export const keywordQuery = (text: string): string => {
  const words = new Set<string>()
  for (const token of identifiers(text)) {
    const whole = token.toLowerCase()
    if (!STOP_WORDS.has(whole)) words.add(whole)
    for (const part of splitIdentifier(token)) {
      if (!STOP_WORDS.has(part)) words.add(part)
    }
  }
  return [...words].join(" ")
}

/** A string literal for a LanceDB `where` clause. */
export const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`

/** Words that point back at something already said. */
const PRONOUN = /\b(it|its|this|that|these|those|they|them|there|one|ones)\b/i

const contentWords = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z_][a-z0-9_]+/g) || []).filter(
    (word) => !STOP_WORDS.has(word)
  )

/**
 * Whether a message leans on the one before it: "and how is it tested?",
 * "why?", "what about the other one". Such a message has too few words of
 * its own to search with. The tell is a pronoun with little else, or almost
 * no content words at all; a short but self-contained question ("where is
 * the login handled") is left alone.
 */
export const isFollowUp = (text: string): boolean => {
  const words = contentWords(text)
  if (words.length < 2) return true
  return words.length < 3 && PRONOUN.test(text)
}

/**
 * The text to search for a message: the message itself, or, for a
 * follow-up, the previous question and the follow-up together so the
 * retrievers and the reranker know what "it" is.
 */
export const searchQuery = (text: string, previous?: string): string => {
  const current = text.trim()
  const before = previous?.trim()
  if (!before || !current || !isFollowUp(current)) return current
  return `${before}\n${current}`
}

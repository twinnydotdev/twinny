/**
 * Line diffs for the inline edit review. Pure: no vscode.
 *
 * A finished (or half-streamed) rewrite is shown inside the document as a
 * merged view: unchanged lines once, lines only in the original marked as
 * removed, lines only in the rewrite marked as added. Accepting deletes the
 * removed lines; rejecting deletes the added ones.
 */

export type DiffKind = "equal" | "remove" | "add"

export interface DiffOp {
  kind: DiffKind
  line: string
}

/** Past this many table cells the LCS is skipped and the hunk is replaced whole. */
const MAX_CELLS = 4_000_000

const op = (kind: DiffKind) => (line: string): DiffOp => ({ kind, line })
const equal = op("equal")
const remove = op("remove")
const add = op("add")

/**
 * Line-level diff of `a` against `b` as an ordered list of ops. Within a
 * hunk removals come before additions, which is how the review reads best.
 * With `early`, a line of `b` that could match in several places matches
 * the earliest; the hunk order flips, so only use it to locate things.
 */
export const diffLines = (a: string[], b: string[], early = false): DiffOp[] => {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  // Trimming a shared suffix would pin it to the end of `a`, which is the
  // late match early mode exists to avoid.
  while (!early && endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  return [
    ...a.slice(0, start).map(equal),
    ...lcsDiff(a.slice(start, endA), b.slice(start, endB), early),
    ...a.slice(endA).map(equal)
  ]
}

const lcsDiff = (a: string[], b: string[], early: boolean): DiffOp[] => {
  if (!a.length) return b.map(add)
  if (!b.length) return a.map(remove)
  if (a.length * b.length > MAX_CELLS) return [...a.map(remove), ...b.map(add)]

  // table[i][j] = length of the LCS of a[i:] and b[j:]
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }

  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push(equal(a[i++]))
      j++
    } else if (
      early
        ? table[(i + 1) * width + j] > table[i * width + j + 1]
        : table[(i + 1) * width + j] >= table[i * width + j + 1]
    ) {
      ops.push(remove(a[i++]))
    } else {
      ops.push(add(b[j++]))
    }
  }
  while (i < a.length) ops.push(remove(a[i++]))
  while (j < b.length) ops.push(add(b[j++]))
  return ops
}

/** A stretch of characters on one line of the layout. */
export interface Span {
  line: number
  start: number
  end: number
}

export interface DiffLayout {
  /** The merged text that replaces the edited region. */
  text: string
  /** Line offsets within `text` of lines that only the original had. */
  removed: number[]
  /** Line offsets within `text` of lines that only the rewrite has. */
  added: number[]
  /** The words that changed within a removed line and its replacement. */
  removedWords: Span[]
  addedWords: Span[]
}

const TOKEN = /\w+|\s+|[^\w\s]/g

/**
 * The words that differ between a line and its rewrite, as character
 * ranges in each. Lines that share too little are left alone: a solid
 * tint reads better than confetti.
 */
export const diffWords = (
  before: string,
  after: string
): { removed: [number, number][]; added: [number, number][] } => {
  const none = { removed: [], added: [] }
  if (before === after) return none
  const ops = diffLines(before.match(TOKEN) ?? [], after.match(TOKEN) ?? [])
  if (!similar(before, after, ops)) return none

  const removed: [number, number][] = []
  const added: [number, number][] = []
  let i = 0
  let j = 0
  const push = (spans: [number, number][], start: number, end: number) => {
    const last = spans[spans.length - 1]
    if (last && last[1] === start) last[1] = end
    else spans.push([start, end])
  }
  for (const op of ops) {
    if (op.kind === "equal") {
      i += op.line.length
      j += op.line.length
    } else if (op.kind === "remove") {
      push(removed, i, i + op.line.length)
      i += op.line.length
    } else {
      push(added, j, j + op.line.length)
      j += op.line.length
    }
  }
  return { removed, added }
}

/**
 * The merged view of `original` and `edited`.
 *
 * While the rewrite is still streaming its last line is incomplete, so only
 * the complete lines are diffed; the partial line is shown as added at the
 * bottom, below whatever original lines the stream has not reached yet.
 * That keeps the picture stable from one chunk to the next.
 */
export const layoutDiff = (
  original: string,
  edited: string,
  streaming = false
): DiffLayout => {
  const oldLines = original ? original.split("\n") : []
  const newLines = edited.split("\n")
  // The last line of a stream is unfinished (or empty, right after a newline).
  const partial = streaming ? newLines.pop() || undefined : undefined
  // Inserting: a trailing line break is not an extra line, but it stays.
  let tail = ""
  if (!oldLines.length && !streaming && newLines[newLines.length - 1] === "") {
    newLines.pop()
    tail = "\n"
  }

  const ops = diffLines(oldLines, newLines)
  if (partial !== undefined) ops.push(add(partial))

  const lines: string[] = []
  const removed: number[] = []
  const added: number[] = []
  for (const { kind, line } of ops) {
    if (kind === "remove") removed.push(lines.length)
    if (kind === "add") added.push(lines.length)
    lines.push(line)
  }
  const words = highlightWords(ops, partial !== undefined)
  return { text: lines.join("\n") + tail, removed, added, ...words }
}

/** How much of two lines their word diff keeps; below half, they differ. */
const similar = (before: string, after: string, ops: DiffOp[]) => {
  const shared = ops
    .filter((op) => op.kind === "equal" && op.line.trim())
    .reduce((n, op) => n + op.line.length, 0)
  return shared * 2 >= Math.min(before.trim().length, after.trim().length)
}

/**
 * Word highlights for each hunk. Every removed line is paired with the
 * added line it most resembles, most alike first, and lines that resemble
 * nothing stay a solid tint. A streaming partial line is never paired,
 * since it is not where it will end up.
 */
const highlightWords = (ops: DiffOp[], skipLast: boolean) => {
  const removedWords: Span[] = []
  const addedWords: Span[] = []
  const end = skipLast ? ops.length - 1 : ops.length
  let i = 0
  while (i < end) {
    if (ops[i].kind !== "remove") {
      i++
      continue
    }
    const removes: number[] = []
    while (i < end && ops[i].kind === "remove") removes.push(i++)
    const adds: number[] = []
    while (i < end && ops[i].kind === "add") adds.push(i++)

    const candidates: { remove: number; add: number; score: number }[] = []
    for (const remove of removes) {
      for (const add of adds) {
        const score = likeness(ops[remove].line, ops[add].line)
        if (score > 0) candidates.push({ remove, add, score })
      }
    }
    candidates.sort((a, b) => b.score - a.score)
    const taken = new Set<number>()
    for (const { remove, add } of candidates) {
      if (taken.has(remove) || taken.has(add)) continue
      taken.add(remove)
      taken.add(add)
      const words = diffWords(ops[remove].line, ops[add].line)
      for (const [start, stop] of words.removed) {
        removedWords.push({ line: remove, start, end: stop })
      }
      for (const [start, stop] of words.added) {
        addedWords.push({ line: add, start, end: stop })
      }
    }
  }
  removedWords.sort((a, b) => a.line - b.line || a.start - b.start)
  addedWords.sort((a, b) => a.line - b.line || a.start - b.start)
  return { removedWords, addedWords }
}

/** Shared non-blank characters of two lines, or 0 when they differ too much. */
const likeness = (before: string, after: string): number => {
  const ops = diffLines(before.match(TOKEN) ?? [], after.match(TOKEN) ?? [])
  if (!similar(before, after, ops)) return 0
  return ops
    .filter((op) => op.kind === "equal" && op.line.trim())
    .reduce((n, op) => n + op.line.length, 0)
}

/** Lines a model writes to stand for code it left out. */
const ELISION = /^\s*(\/\/|#|--|\/\*|<!--)?\s*(\.\.\.|…)/

/**
 * Where a snippet from the chat belongs in a file: the stretch between the
 * first and last file lines the snippet repeats. Undefined when the snippet
 * shares too little with the file to be a rewrite of any part of it.
 */
export const locateSnippet = (
  fileLines: string[],
  snippet: string[]
): { start: number; end: number } | undefined => {
  const wanted = snippet.filter((line) => line.trim() && !ELISION.test(line))
  if (!wanted.length) return undefined

  let matched = 0
  let first: number | undefined
  let last: number | undefined
  let line = 0
  for (const op of diffLines(fileLines, snippet, true)) {
    if (op.kind === "add") continue
    if (op.kind === "equal" && op.line.trim()) {
      matched++
      first ??= line
      last = line
    }
    line++
  }
  if (first === undefined || last === undefined) return undefined
  if (matched * 2 < wanted.length) return undefined
  return { start: first, end: last }
}

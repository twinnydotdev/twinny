import { ExtensionContext } from "vscode"
import { SyntaxNode } from "web-tree-sitter"

import { defaultChunkOptions, EVENT_NAME, EXTENSION_CONTEXT_NAME } from "../../common/constants"
import { ChunkOptions } from "../../common/types"
import { getParser } from "../completion/parser"

/**
 * One indexed piece of a file: a contiguous run of whole lines. Chunks are
 * exact slices of the source (never re-joined text), so a hit can be shown
 * to the model, and to the user, as `path:start-end`.
 */
export interface Chunk {
  content: string
  /** Zero-based, inclusive. */
  startLine: number
  endLine: number
}

/** A [start, end] line range the chunker treats as one unit. */
type Segment = [number, number]

const lineLength = (lines: string[], from: number, to: number) => {
  let total = 0
  for (let i = from; i <= to; i++) total += lines[i].length + 1
  return total
}

/**
 * Splits a file into segments along syntax boundaries. A node that fits in
 * one chunk is a unit; a bigger node is opened up so its children become
 * units; a leaf that is still too big (a huge string literal, a data blob)
 * is left to the line splitter. The result is a list of break rows, which
 * keeps every line of the file covered even where the tree has gaps.
 */
export const syntaxBreaks = (
  root: SyntaxNode,
  maxSize: number
): number[] => {
  const breaks = new Set<number>()
  const visit = (node: SyntaxNode) => {
    if (node.text.length <= maxSize || !node.children.length) {
      breaks.add(node.startPosition.row)
      return
    }
    for (const child of node.children) visit(child)
  }
  for (const child of root.children) visit(child)
  return [...breaks].sort((a, b) => a - b)
}

/**
 * Break rows for prose and config files, where the natural unit is a
 * paragraph: a blank line or a markdown heading starts a new segment.
 */
export const proseBreaks = (lines: string[]): number[] => {
  const breaks: number[] = []
  let previousBlank = true
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const blank = line.trim() === ""
    if ((previousBlank && !blank) || /^#{1,6}\s/.test(line)) breaks.push(i)
    previousBlank = blank
  }
  return breaks
}

const segmentsFromBreaks = (breaks: number[], lineCount: number): Segment[] => {
  if (!lineCount) return []
  const rows = [...new Set([0, ...breaks.filter((row) => row < lineCount)])]
    .sort((a, b) => a - b)
  return rows.map((row, i) => [row, (rows[i + 1] ?? lineCount) - 1])
}

/**
 * Packs segments into chunks of at most `maxSize` characters. A segment that
 * is itself too big is cut on line boundaries. Each chunk after the first
 * starts with up to `overlap` characters of the lines before it, so a
 * definition split across two chunks is findable from either side.
 */
export const packSegments = (
  lines: string[],
  segments: Segment[],
  options: ChunkOptions
): Chunk[] => {
  const { minSize, maxSize, overlap } = options
  const ranges: Segment[] = []
  let open: Segment | undefined

  const close = () => {
    if (open) ranges.push(open)
    open = undefined
  }

  for (const [start, end] of segments) {
    if (open && lineLength(lines, open[0], end) <= maxSize) {
      open[1] = end
      continue
    }
    close()
    if (lineLength(lines, start, end) <= maxSize) {
      open = [start, end]
      continue
    }
    // Too big for one chunk even on its own: cut it on line boundaries.
    let from = start
    for (let row = start; row <= end; row++) {
      if (row > from && lineLength(lines, from, row) > maxSize) {
        ranges.push([from, row - 1])
        from = row
      }
    }
    open = [from, end]
  }
  close()

  // A tail smaller than the minimum is noise on its own: fold it into the
  // chunk before it.
  const merged: Segment[] = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (
      previous &&
      lineLength(lines, range[0], range[1]) < minSize &&
      lineLength(lines, previous[0], range[1]) <= maxSize * 1.5
    ) {
      previous[1] = range[1]
    } else {
      merged.push(range)
    }
  }

  return merged
    .flatMap(([start, end], i): Chunk[] => {
      let from = start
      if (i > 0 && overlap > 0) {
        while (from > 0 && lineLength(lines, from - 1, start - 1) <= overlap) from--
      }
      const content = lines.slice(from, end + 1).join("\n")
      // One enormous line (minified code, a data literal) cannot be cut on
      // line boundaries; cut it on characters so the embedder never sees a
      // giant input.
      if (content.length <= maxSize * 2) return [{ content, startLine: from, endLine: end }]
      const pieces: Chunk[] = []
      for (let offset = 0; offset < content.length; offset += maxSize) {
        pieces.push({
          content: content.slice(offset, offset + maxSize),
          startLine: from,
          endLine: end
        })
      }
      return pieces
    })
    .filter((chunk) => chunk.content.trim().length > 0)
}

/** The chunk sizes the user set in the embeddings tab, or the defaults. */
export const getChunkOptions = (
  context: ExtensionContext | undefined
): ChunkOptions => {
  if (!context) return defaultChunkOptions
  const read = (key: string, fallback: number) =>
    Number(
      context.globalState.get(`${EVENT_NAME.twinnyGlobalContext}-${key}`)
    ) || fallback
  const maxSize = read(EXTENSION_CONTEXT_NAME.twinnyMaxChunkSize, defaultChunkOptions.maxSize)
  const minSize = Math.min(
    read(EXTENSION_CONTEXT_NAME.twinnyMinChunkSize, defaultChunkOptions.minSize),
    maxSize
  )
  const overlap = Math.min(
    read(EXTENSION_CONTEXT_NAME.twinnyOverlapSize, defaultChunkOptions.overlap),
    Math.floor(maxSize / 2)
  )
  return { maxSize, minSize, overlap }
}

/** Splits without a parser: paragraphs for prose, lines for everything else. */
export const chunkText = (content: string, options: ChunkOptions): Chunk[] => {
  const lines = content.split("\n")
  return packSegments(lines, segmentsFromBreaks(proseBreaks(lines), lines.length), options)
}

/**
 * Splits a file for indexing, along syntax boundaries when a tree-sitter
 * grammar is available for it and along paragraphs otherwise.
 */
export const chunkDocument = async (
  content: string,
  filePath: string,
  options: ChunkOptions
): Promise<Chunk[]> => {
  try {
    const parser = await getParser(filePath)
    if (!parser) return chunkText(content, options)
    const tree = parser.parse(content)
    const lines = content.split("\n")
    const breaks = syntaxBreaks(tree.rootNode, options.maxSize)
    tree.delete()
    return packSegments(lines, segmentsFromBreaks(breaks, lines.length), options)
  } catch (error) {
    console.error(`Could not parse ${filePath} for chunking: ${error}`)
    return chunkText(content, options)
  }
}

/**
 * Growing a hit from the chunk that matched into the code the model can
 * actually read: the function or class around it when that fits a budget,
 * and the file's imports once, so the names in the hit resolve. Pure
 * functions over a tree so they are unit-tested with fake trees; the search
 * feeds them real tree-sitter nodes.
 */

/** The little of a tree-sitter node that expansion needs. */
export interface SyntaxLike {
  type: string
  startPosition: { row: number }
  endPosition: { row: number; column?: number }
  children: SyntaxLike[]
}

/** Zero-based, inclusive. */
export type LineRange = [number, number]

/** Top-level nodes that bring names into a file, across grammars. */
const IMPORT_NODE = /import|use_declaration|preproc_include/
const COMMENT_NODE = /comment/

const lineChars = (lines: string[], from: number, to: number): number => {
  let total = 0
  for (let i = from; i <= to && i < lines.length; i++) total += lines[i].length + 1
  return total
}

/**
 * The last line a node has text on. A node that ends with a newline ends
 * at column 0 of the next row as far as tree-sitter is concerned.
 */
const lastRow = (node: SyntaxLike, lineCount: number): number => {
  const { row, column } = node.endPosition
  const last = column === 0 && row > node.startPosition.row ? row - 1 : row
  return Math.min(last, Math.max(0, lineCount - 1))
}

const contains = (node: SyntaxLike, start: number, end: number, lineCount: number) =>
  node.startPosition.row <= start && lastRow(node, lineCount) >= end

/**
 * The widest node around `[start, end]` whose text fits `maxChars`, when
 * it adds lines: a method grows to its class when the class is small, a
 * slice of a long function grows to the function, a hit in a tiny file
 * grows to the file. Undefined when no enclosing node both fits and grows.
 */
export const enclosingRange = (
  root: SyntaxLike,
  lines: string[],
  start: number,
  end: number,
  maxChars: number
): LineRange | undefined => {
  let node: SyntaxLike | undefined = root
  while (node) {
    const from = node.startPosition.row
    const to = lastRow(node, lines.length)
    const grows = from < start || to > end
    if (grows && lineChars(lines, from, to) <= maxChars) return [from, to]
    node = node.children.find((child) => contains(child, start, end, lines.length))
  }
  return undefined
}

/**
 * The run of imports at the top of a file, comments between them allowed,
 * up to `maxChars`. Undefined when the file has none or they are too long
 * to be worth the prompt space.
 */
export const importRange = (
  root: SyntaxLike,
  lines: string[],
  maxChars: number
): LineRange | undefined => {
  let first: number | undefined
  let last: number | undefined
  for (const child of root.children) {
    if (IMPORT_NODE.test(child.type)) {
      first ??= child.startPosition.row
      last = lastRow(child, lines.length)
    } else if (first !== undefined && !COMMENT_NODE.test(child.type)) {
      break
    }
  }
  if (first === undefined || last === undefined) return undefined
  return lineChars(lines, first, last) <= maxChars ? [first, last] : undefined
}

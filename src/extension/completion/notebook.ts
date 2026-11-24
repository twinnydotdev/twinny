/**
 * A notebook cell read as part of its notebook.
 *
 * VS Code hands the completion provider one cell at a time, as a document
 * of its own. A cell is rarely code on its own, though: the imports, the
 * data and the helpers it uses were written in the cells above, and a
 * model shown only the cell guesses at all of them (#430). The cells of
 * the same language are joined into one text, in order, so the window of
 * code round the cursor runs across cell boundaries like it would in a file.
 */
import { NotebookCellKind, Position, Range, TextDocument, workspace } from "vscode"

/** The part of a document the prefix and suffix window reads. */
export type DocumentText = Pick<TextDocument, "lineCount" | "getText">

/** The scheme VS Code gives the document of a notebook cell. */
const NOTEBOOK_CELL_SCHEME = "vscode-notebook-cell"

/** What goes between two cells: a blank line, as between two blocks of a file. */
const CELL_SEPARATOR = "\n\n"

/** A string read the way the prefix and suffix window reads a document. */
export const textDocumentOf = (text: string): DocumentText => {
  const starts = [0]
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
    starts.push(at + 1)
  }
  // Clamped like a document's own positions: a line past the end is the
  // end, a character past a line's end is that end.
  const offsetAt = (position: Position) => {
    if (position.line >= starts.length) return text.length
    const lineEnd = position.line + 1 < starts.length ? starts[position.line + 1] - 1 : text.length
    return Math.min(starts[position.line] + position.character, lineEnd)
  }
  return {
    lineCount: starts.length,
    getText: (range?: Range) =>
      range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text
  }
}

/**
 * The cells given joined into one text, and the line the cell being
 * edited starts on in it. Only code cells in that cell's language take
 * part: markdown, and code in another language (a SQL cell in a Python
 * notebook), would not parse as part of it.
 */
export const joinCells = (
  cells: { kind: NotebookCellKind; document: TextDocument }[],
  current: TextDocument
): { text: string; line: number } | undefined => {
  const parts: string[] = []
  let line: number | undefined
  for (const { kind, document } of cells) {
    const isCurrent = document.uri.toString() === current.uri.toString()
    if (isCurrent) {
      line = parts.length ? (parts.join(CELL_SEPARATOR) + CELL_SEPARATOR).split("\n").length - 1 : 0
    } else if (kind !== NotebookCellKind.Code || document.languageId !== current.languageId) {
      continue
    }
    parts.push(document.getText())
  }
  return line === undefined ? undefined : { text: parts.join(CELL_SEPARATOR), line }
}

/**
 * The notebook a cell belongs to, read as one document, and where the
 * cursor is in it. Undefined for a document that is not an open
 * notebook's cell.
 */
export const getNotebookText = (
  document: TextDocument,
  position: Position
): { document: DocumentText; position: Position } | undefined => {
  if (document.uri.scheme !== NOTEBOOK_CELL_SCHEME) return undefined
  const uri = document.uri.toString()
  const notebook = workspace.notebookDocuments.find((candidate) =>
    candidate.getCells().some((cell) => cell.document.uri.toString() === uri)
  )
  const joined = notebook && joinCells(notebook.getCells(), document)
  if (!joined) return undefined
  return {
    document: textDocumentOf(joined.text),
    position: position.translate(joined.line)
  }
}

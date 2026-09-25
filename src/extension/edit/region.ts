/**
 * The inline edit's diff, as it lives in the editor: a region of the
 * document showing old lines and new lines together, the decorations
 * that colour them, and the geometry that keeps them in place while the
 * model streams and other edits land around them.
 *
 * The service that asks the model and settles the verdict is in
 * service.ts.
 */
import * as vscode from "vscode"

import { DiffLayout, Span } from "./diff"

/** A run of neighbouring diff lines that stands or falls together. */
export interface Hunk {
  line: number
  removed: number[]
  added: number[]
}

/**
 * A merged diff living inside a document: where it is, which of its lines
 * are the old ones and which are the new ones.
 *
 * Renders are serialised so a fast stream cannot interleave two
 * replacements, and every edit up to and including the verdict shares one
 * undo stop. Edits made by anyone else are followed so the line numbers
 * stay right; one that cuts through a tracked line breaks the region.
 */
export class DiffRegion {
  public readonly document: vscode.TextDocument
  public range: vscode.Range
  /** Absolute line numbers of the old lines still shown. */
  public removed: number[] = []
  /** Absolute line numbers of the new lines. */
  public added: number[] = []
  /** Changed words within paired lines, on absolute lines. */
  public removedWords: Span[] = []
  public addedWords: Span[] = []
  public broken = false

  private _queue: Promise<boolean> = Promise.resolve(true)
  private _first = true
  private _applying = false

  constructor(private readonly _editor: vscode.TextEditor, range: vscode.Range) {
    this.document = _editor.document
    this.range = range
  }

  /** Replace the region with a layout; resolves false once it cannot. */
  public render(layout: DiffLayout): Promise<boolean> {
    this._queue = this._queue.then(() => this.replace(layout))
    return this._queue
  }

  /** The two sides of the diff as the document shows them right now. */
  public sides(): { baseline: string; proposed: string } {
    const lines = this.document.getText(this.range).split("\n")
    const base = this.range.start.line
    const removed = new Set(this.removed.map((line) => line - base))
    const added = new Set(this.added.map((line) => line - base))
    return {
      baseline: lines.filter((_, i) => !added.has(i)).join("\n"),
      proposed: lines.filter((_, i) => !removed.has(i)).join("\n")
    }
  }

  /** The current state as a layout, so it can be rendered again later. */
  public snapshot(): DiffLayout {
    const base = this.range.start.line
    const local = (span: Span) => ({ ...span, line: span.line - base })
    return {
      text: this.document.getText(this.range),
      removed: this.removed.map((line) => line - base),
      added: this.added.map((line) => line - base),
      removedWords: this.removedWords.map(local),
      addedWords: this.addedWords.map(local)
    }
  }

  /** Delete the losing side's lines and close the undo stop. */
  public async settle(
    editor: vscode.TextEditor,
    verdict: "accept" | "reject",
    hunk?: number
  ): Promise<boolean> {
    await this._queue
    if (this.broken) return false
    const hunks = this.hunks
    const targets = hunk === undefined ? hunks : [hunks[hunk]].filter(Boolean)
    const doomed = targets.flatMap((h) => (verdict === "accept" ? h.removed : h.added))
    const settled = new Set(targets.flatMap((h) => [...h.removed, ...h.added]))
    const last = settled.size === this.removed.length + this.added.length

    let ok = true
    if (doomed.length) {
      this._applying = true
      try {
        ok = await editor.edit(
          (builder) => {
            for (const range of lineRuns(this.document, doomed)) {
              builder.delete(range)
            }
          },
          { undoStopBefore: false, undoStopAfter: last }
        )
      } finally {
        this._applying = false
      }
    }
    if (!ok) {
      this.broken = true
      return false
    }

    // Forget the settled hunks and close the gaps the deletions left.
    const gone = [...doomed].sort((a, b) => a - b)
    const shift = (line: number) => {
      let n = 0
      while (n < gone.length && gone[n] < line) n++
      return line - n
    }
    const keep = (line: number) => !settled.has(line)
    this.removed = this.removed.filter(keep).map(shift)
    this.added = this.added.filter(keep).map(shift)
    const keepSpan = (span: Span) => keep(span.line)
    const shiftSpan = (span: Span) => ({ ...span, line: shift(span.line) })
    this.removedWords = this.removedWords.filter(keepSpan).map(shiftSpan)
    this.addedWords = this.addedWords.filter(keepSpan).map(shiftSpan)
    const end = Math.max(this.range.start.line, shift(this.range.end.line + 1) - 1)
    this.range = new vscode.Range(
      this.range.start.line,
      0,
      end,
      this.document.lineAt(end).range.end.character
    )
    return true
  }

  /** Nothing left to decide. */
  public get done() {
    return !this.removed.length && !this.added.length
  }

  /** The diff lines grouped into runs of neighbours. */
  public get hunks(): Hunk[] {
    const lines = [
      ...this.removed.map((line) => ({ line, removed: true })),
      ...this.added.map((line) => ({ line, removed: false }))
    ].sort((a, b) => a.line - b.line)
    const hunks: Hunk[] = []
    for (const { line, removed } of lines) {
      let hunk = hunks[hunks.length - 1]
      const previous = hunk && Math.max(...hunk.removed, ...hunk.added)
      if (!hunk || line !== previous + 1) {
        hunk = { line, removed: [], added: [] }
        hunks.push(hunk)
      }
      const side = removed ? hunk.removed : hunk.added
      side.push(line)
    }
    return hunks
  }

  /** Follow changes somebody else made; false when they were our own. */
  public track(
    changes: readonly vscode.TextDocumentContentChangeEvent[]
  ): boolean {
    if (this._applying) return false
    if (this.broken) return true
    for (const change of changes) {
      const first = change.range.start.line
      const last = change.range.end.line
      const delta = change.text.split("\n").length - 1 - (last - first)
      if (first > this.range.end.line) continue
      // Lines strictly after the change's first line and up to its last
      // one are gone (merged into the first); a tracked line among them
      // means the diff no longer describes the document.
      const gone = (line: number) => line > first && line <= last
      if (this.removed.some(gone) || this.added.some(gone)) {
        this.broken = true
        return true
      }
      const shift = (line: number) => (line > first ? line + delta : line)
      this.removed = this.removed.map(shift)
      this.added = this.added.map(shift)
      // Typing on a highlighted line moves its columns; drop its highlights.
      const shiftSpan = (span: Span) => ({ ...span, line: shift(span.line) })
      const untouched = (span: Span) => span.line !== first
      this.removedWords = this.removedWords.filter(untouched).map(shiftSpan)
      this.addedWords = this.addedWords.filter(untouched).map(shiftSpan)
      const start = gone(this.range.start.line)
        ? first
        : shift(this.range.start.line)
      const end = gone(this.range.end.line) ? first : shift(this.range.end.line)
      this.range = new vscode.Range(
        start,
        0,
        end,
        this.document.lineAt(Math.min(end, this.document.lineCount - 1)).range
          .end.character
      )
    }
    return true
  }

  private async replace(layout: DiffLayout): Promise<boolean> {
    if (this.broken) return false
    const start = this.range.start
    if (layout.text !== this.document.getText(this.range)) {
      this._applying = true
      let ok: boolean
      try {
        ok = await this._editor.edit(
          (builder) => builder.replace(this.range, layout.text),
          { undoStopBefore: this._first, undoStopAfter: false }
        )
      } finally {
        this._applying = false
      }
      this._first = false
      if (!ok) {
        this.broken = true
        return false
      }
      this.range = endOf(start, layout.text)
    }
    this.removed = layout.removed.map((line) => start.line + line)
    this.added = layout.added.map((line) => start.line + line)
    const place = (span: Span) => ({ ...span, line: start.line + span.line })
    this.removedWords = layout.removedWords.map(place)
    this.addedWords = layout.addedWords.map(place)
    return true
  }
}

export const lineRange = (line: number) => new vscode.Range(line, 0, line, 0)
export const spanRange = (span: Span) =>
  new vscode.Range(span.line, span.start, span.line, span.end)

const DIFF_COLORS = {
  "-": {
    gutter: "#f14c4c",
    line: "diffEditor.removedLineBackground",
    words: "diffEditor.removedTextBackground"
  },
  "+": {
    gutter: "#89d185",
    line: "diffEditor.insertedLineBackground",
    words: "diffEditor.insertedTextBackground"
  }
}

/** A "-" or "+" in the gutter, the SVG way, so no text moves. */
const gutterMarker = (sign: "-" | "+") => {
  const svg =
    "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\">" +
    "<text x=\"8\" y=\"12.5\" text-anchor=\"middle\" font-family=\"monospace\" " +
    `font-size="15" font-weight="bold" fill="${DIFF_COLORS[sign].gutter}">` +
    `${sign}</text></svg>`
  return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`)
}

/** One line of a unified diff: sign in the gutter, tinted line, ruler mark. */
export const diffLineDecoration = (sign: "-" | "+") =>
  vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor(DIFF_COLORS[sign].line),
    overviewRulerColor: new vscode.ThemeColor(DIFF_COLORS[sign].line),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    gutterIconPath: gutterMarker(sign),
    gutterIconSize: "contain",
    isWholeLine: true,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  })

/** The changed words within a line, tinted harder, as GitHub does. */
export const diffWordDecoration = (sign: "-" | "+") =>
  vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor(DIFF_COLORS[sign].words),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  })

/**
 * Ranges that delete the given lines, line breaks included, so nothing is
 * left behind. Consecutive lines become one range: neighbouring ranges
 * would overlap at the end of the document, which an edit does not allow.
 */
const lineRuns = (
  document: vscode.TextDocument,
  lines: number[]
): vscode.Range[] => {
  const sorted = [...lines].sort((a, b) => a - b)
  const runs: vscode.Range[] = []
  for (let i = 0; i < sorted.length; ) {
    const first = sorted[i]
    let last = first
    while (i + 1 < sorted.length && sorted[i + 1] === last + 1) last = sorted[++i]
    i++
    if (last + 1 < document.lineCount) {
      runs.push(new vscode.Range(first, 0, last + 1, 0))
    } else if (first > 0) {
      runs.push(
        new vscode.Range(
          document.lineAt(first - 1).range.end,
          document.lineAt(last).range.end
        )
      )
    } else {
      runs.push(new vscode.Range(0, 0, last, document.lineAt(last).range.end.character))
    }
  }
  return runs
}

/** Where `text` ends when inserted at `start`. */
const endOf = (start: vscode.Position, text: string): vscode.Range => {
  const lines = text.split("\n")
  const last = lines[lines.length - 1]
  const end =
    lines.length === 1
      ? new vscode.Position(start.line, start.character + last.length)
      : new vscode.Position(start.line + lines.length - 1, last.length)
  return new vscode.Range(start, end)
}

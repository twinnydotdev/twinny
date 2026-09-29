/**
 * What the user changed recently, as small diffs for the FIM prompt.
 *
 * A model that sees "the last three things you did" copies the pattern:
 * a rename half-done, an argument added to every call, a field being
 * threaded through. Small models copy it especially well, because it is
 * concrete and short.
 *
 * Every open document keeps a baseline. The live diff between baseline and
 * current text is one hunk (common leading and trailing lines trimmed).
 * When the user jumps far from that hunk, or the document is closed, the
 * hunk is frozen into the history and the baseline moves forward. So the
 * history is "one hunk per place the user worked", most recent last.
 */
import { Disposable, TextDocument, TextDocumentChangeEvent, workspace } from "vscode"

import { FimContextFile } from "../../common/types"

/** Hunks remembered across all files. */
export const MAX_HUNKS = 6
/** Lines kept per side of one hunk; the middle is cut when longer. */
export const MAX_HUNK_LINES = 30
/** Characters the whole block may take in the prompt. */
export const MAX_CHARS = 2500
/** A change this many lines from the live hunk starts a new hunk. */
const FAR_LINES = 30
/** Older hunks say nothing about what the user is doing now. */
const MAX_AGE_MS = 10 * 60 * 1000
/** Documents past this size are not snapshotted on every keystroke. */
const MAX_DOCUMENT_CHARS = 1_000_000
/** Documents worth tracking: files on disk and unsaved buffers. */
const SCHEMES = new Set(["file", "untitled"])

export interface EditHunk {
  /** Workspace-relative path. */
  file: string
  /** Lines as they were. */
  removed: string[]
  /** Lines as they are now. */
  added: string[]
  /** First line of the hunk in the current document, 0-based. */
  line: number
  /** Epoch ms of the last change in this hunk. */
  at: number
}

interface Tracked {
  document: TextDocument
  /** Text the live hunk is measured against. */
  baseline: string
  /** Text as of the last change seen; the pre-change text of the next one. */
  current: string
  /** Line of the last change, for the "jumped elsewhere" test. */
  lastLine: number
  lastAt: number
}

const splitLines = (text: string) => text.split(/\r?\n/)

/**
 * The one region where two texts differ: lines before and after the
 * change, with the shared head and tail removed. Undefined when the texts
 * are the same or differ only in whitespace.
 */
export const diffHunk = (
  before: string,
  after: string
): { removed: string[]; added: string[]; line: number } | undefined => {
  if (before === after) return undefined
  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  const max = Math.min(oldLines.length, newLines.length)
  let head = 0
  while (head < max && oldLines[head] === newLines[head]) head++
  let tail = 0
  while (
    tail < max - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail++
  }
  const removed = oldLines.slice(head, oldLines.length - tail)
  const added = newLines.slice(head, newLines.length - tail)
  const squash = (lines: string[]) => lines.map((l) => l.replace(/\s+/g, "")).join("\n")
  if (squash(removed) === squash(added)) return undefined
  return { removed, added, line: head }
}

/** A side of a hunk cut down to its first and last lines when too long. */
const clip = (lines: string[], max = MAX_HUNK_LINES): string[] => {
  if (lines.length <= max) return lines
  const half = Math.floor(max / 2)
  return [...lines.slice(0, half), `... ${lines.length - max} lines ...`, ...lines.slice(-half)]
}

export const renderHunk = (hunk: EditHunk): string =>
  [
    `${hunk.file}:`,
    ...clip(hunk.removed).map((l) => `-${l}`),
    ...clip(hunk.added).map((l) => `+${l}`)
  ].join("\n")

/**
 * The block the prompt gets: most recent last, since what the model reads
 * closest to the hole matters most. Oldest hunks go first when the budget
 * runs out.
 */
export const renderRecentEdits = (hunks: EditHunk[], maxChars = MAX_CHARS): string => {
  if (!hunks.length) return ""
  const rendered: string[] = []
  let used = 0
  for (const hunk of [...hunks].reverse()) {
    const text = renderHunk(hunk)
    if (used + text.length > maxChars && rendered.length) break
    rendered.unshift(text.slice(0, maxChars))
    used += text.length
  }
  return [
    "Recent edits by the user, most recent last. - is the old line, + the new one.",
    ...rendered
  ].join("\n\n")
}

export class RecentEdits implements Disposable {
  private readonly _tracked = new Map<string, Tracked>()
  private _history: EditHunk[] = []
  private readonly _disposables: Disposable[] = []

  constructor() {
    for (const document of workspace.textDocuments) this.track(document)
    this._disposables.push(
      workspace.onDidOpenTextDocument((document) => this.track(document)),
      workspace.onDidCloseTextDocument((document) => this.forget(document)),
      workspace.onDidChangeTextDocument((event) => this.onChange(event))
    )
  }

  public dispose() {
    Disposable.from(...this._disposables).dispose()
    this._tracked.clear()
    this._history = []
  }

  /**
   * Hunks to show while completing `document` at `cursorLine`: the frozen
   * history plus every live hunk, except a live hunk in this document that
   * contains the cursor, since the prefix already shows that and the model
   * would only echo it.
   */
  public hunks(document?: TextDocument, cursorLine?: number): EditHunk[] {
    const now = Date.now()
    this._history = this._history.filter((hunk) => now - hunk.at <= MAX_AGE_MS)
    const live: EditHunk[] = []
    for (const tracked of this._tracked.values()) {
      if (now - tracked.lastAt > MAX_AGE_MS) continue
      const hunk = this.liveHunk(tracked)
      if (!hunk) continue
      const isCurrent = document && tracked.document.uri.toString() === document.uri.toString()
      if (
        isCurrent &&
        cursorLine !== undefined &&
        cursorLine >= hunk.line &&
        cursorLine < hunk.line + Math.max(1, hunk.added.length)
      ) {
        continue
      }
      live.push(hunk)
    }
    return [...this._history, ...live]
      .sort((a, b) => a.at - b.at)
      .slice(-MAX_HUNKS)
  }

  /** The block for the prompt, or empty when nothing was edited lately. */
  public get(document?: TextDocument, cursorLine?: number): FimContextFile | undefined {
    const text = renderRecentEdits(this.hunks(document, cursorLine))
    return text ? { name: "Recent edits", text } : undefined
  }

  private key(document: TextDocument) {
    return document.uri.toString()
  }

  private track(document: TextDocument) {
    if (!SCHEMES.has(document.uri.scheme)) return
    if (this._tracked.has(this.key(document))) return
    const text = document.getText()
    if (text.length > MAX_DOCUMENT_CHARS) return
    this._tracked.set(this.key(document), {
      document,
      baseline: text,
      current: text,
      lastLine: -1,
      lastAt: 0
    })
  }

  private forget(document: TextDocument) {
    const tracked = this._tracked.get(this.key(document))
    if (!tracked) return
    this.freeze(tracked, tracked.current)
    this._tracked.delete(this.key(document))
  }

  private onChange(event: TextDocumentChangeEvent) {
    const tracked = this._tracked.get(this.key(event.document))
    if (!tracked || !event.contentChanges.length) return
    const line = Math.min(...event.contentChanges.map((c) => c.range.start.line))
    const previous = tracked.current
    if (tracked.lastLine >= 0 && Math.abs(line - tracked.lastLine) > FAR_LINES) {
      this.freeze(tracked, previous)
    }
    const text = event.document.getText()
    if (text.length > MAX_DOCUMENT_CHARS) {
      this._tracked.delete(this.key(event.document))
      return
    }
    tracked.current = text
    tracked.lastLine = line
    tracked.lastAt = Date.now()
  }

  /** Close the live hunk as of `text` and start measuring from there. */
  private freeze(tracked: Tracked, text: string) {
    const hunk = this.hunkBetween(tracked, tracked.baseline, text)
    if (hunk) {
      this._history.push(hunk)
      if (this._history.length > MAX_HUNKS) this._history.shift()
    }
    tracked.baseline = text
    tracked.lastLine = -1
  }

  private liveHunk(tracked: Tracked): EditHunk | undefined {
    return this.hunkBetween(tracked, tracked.baseline, tracked.current)
  }

  private hunkBetween(tracked: Tracked, before: string, after: string): EditHunk | undefined {
    const diff = diffHunk(before, after)
    if (!diff) return undefined
    return {
      file: workspace.asRelativePath(tracked.document.uri),
      ...diff,
      at: tracked.lastAt
    }
  }
}

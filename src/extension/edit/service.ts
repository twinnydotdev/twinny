import { TokenJS } from "fluency.js"
import * as vscode from "vscode"

import { EXTENSION_CONTEXT_NAME } from "../../common/constants"
import { logger } from "../../common/logger"
import { TwinnyProvider } from "../../common/types"
import {
  buildBlockingRequest,
  buildStreamingRequest,
  supportsStreaming
} from "../chat/messages"
import { Base } from "../providers/base"
import { describeProviderErrorPlain, isAbortError } from "../providers/errors"
import { TwinnyStatusBar } from "../status-bar"

import { DiffLayout, layoutDiff, Span } from "./diff"
import {
  buildEditMessages,
  clampContext,
  EDIT_CONTEXT_LINES,
  finalizeEdit,
  previewEdit
} from "./prompt"

export interface InlineEditArgs {
  uri?: vscode.Uri | string
  range?: vscode.Range
  instruction?: string
  /** Preset commands (refactor, add types) need something to work on. */
  requireSelection?: boolean
}

/** What the CodeLens needs to know about the edit in a document. */
export interface PendingEditInfo {
  line: number
  streaming: boolean
  /** First line of each hunk, in order. */
  hunks: number[]
}

/** A run of neighbouring diff lines that stands or falls together. */
export interface Hunk {
  line: number
  removed: number[]
  added: number[]
}

const mac = process.platform === "darwin"
const REVIEW_HINT = mac
  ? "Twinny: review the edit — ⌘⇧↩ accepts, ⌘⇧⌫ rejects"
  : "Twinny: review the edit — Ctrl+Shift+Enter accepts, Ctrl+Shift+Backspace rejects"

/**
 * Rewrites a region of the active editor to an instruction, as a diff the
 * user accepts or rejects.
 *
 * The model's reply streams into the document as it arrives, laid out as
 * a merged diff: lines the rewrite drops stay visible and turn red, lines
 * it adds appear green. When the stream ends the diff waits for a verdict.
 * Accepting deletes the red lines, rejecting deletes the green ones; either
 * way the whole thing is one undo step. Only one edit exists at a time.
 */
export class InlineEditService extends Base {
  private _controller?: AbortController
  private _running = false
  private _pending?: DiffRegion
  private readonly _emitter = new vscode.EventEmitter<void>()
  public readonly onDidChangePending = this._emitter.event

  private readonly _removedDecoration = diffLineDecoration("-")
  private readonly _addedDecoration = diffLineDecoration("+")
  private readonly _removedWords = diffWordDecoration("-")
  private readonly _addedWords = diffWordDecoration("+")

  constructor(
    context: vscode.ExtensionContext,
    private readonly _statusBar: TwinnyStatusBar
  ) {
    super(context)
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => this.onChange(event)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (this._pending?.document === document) this.clearPending()
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate())
    )
  }

  public get running() {
    return this._running
  }

  public abort() {
    this._controller?.abort()
  }

  public dispose() {
    super.dispose()
    this._emitter.dispose()
    this._removedDecoration.dispose()
    this._addedDecoration.dispose()
    this._removedWords.dispose()
    this._addedWords.dispose()
  }

  /** The edit waiting in `document`, if any; drives the CodeLens. */
  public pendingFor(document: vscode.TextDocument): PendingEditInfo | undefined {
    const pending = this._pending
    if (!pending || pending.document !== document) return undefined
    return {
      line: pending.range.start.line,
      streaming: this._running,
      hunks: pending.hunks.map((hunk) => hunk.line)
    }
  }

  /** The command's entry point: resolve the editor and range, ask, run. */
  public async run(args?: InlineEditArgs) {
    if (this._running) {
      vscode.window.showInformationMessage(
        "Twinny is already editing; stop it first (Ctrl+Shift+/)."
      )
      return
    }
    const provider = this.getProvider()
    if (!provider) {
      const choice = await vscode.window.showWarningMessage(
        "Twinny has no chat provider configured.",
        "Manage providers"
      )
      if (choice) {
        await vscode.commands.executeCommand("twinny.sidebar.focus")
        await vscode.commands.executeCommand("twinny.manageProviders")
      }
      return
    }

    // A pending diff is refined: the instruction applies to the proposal.
    const pending = this._pending
    if (pending) {
      const editor = await this.editorFor(pending.document)
      const instruction =
        args?.instruction?.trim() ||
        (await this.askInstruction(editor, pending.range, true))
      if (!instruction) return
      await this.edit(editor, pending, instruction, provider)
      return
    }

    const editor = await this.resolveEditor(args?.uri)
    if (!editor) {
      vscode.window.showInformationMessage("Open a file to edit with Twinny.")
      return
    }

    if (args?.requireSelection && !args.range && editor.selection.isEmpty) {
      vscode.window.showInformationMessage("Select the code to edit first.")
      return
    }

    const range = this.wholeLines(editor.document, args?.range ?? editor.selection)
    const instruction =
      args?.instruction?.trim() || (await this.askInstruction(editor, range))
    if (!instruction) return

    await this.edit(editor, new DiffRegion(editor, range), instruction, provider)
  }

  /** Keep the rewrite, or one hunk of it: delete the lines it replaced. */
  public accept(hunk?: number) {
    return this.resolve("accept", hunk)
  }

  /** Discard the rewrite, or one hunk of it: delete the lines it added. */
  public reject(hunk?: number) {
    return this.resolve("reject", hunk)
  }

  /* ------------------------------------------------------------------------ */

  private async resolve(verdict: "accept" | "reject", hunk?: number) {
    const pending = this._pending
    if (!pending || this._running) return
    const editor = await this.editorFor(pending.document)
    const ok = await pending.settle(editor, verdict, hunk)
    if (!ok) {
      this.clearPending()
      vscode.window.showWarningMessage(
        "Twinny could not tidy up the edit; use Undo (Ctrl+Z) to revert it."
      )
      return
    }
    const what = pending.done ? "edit" : "hunk"
    if (pending.done) this.clearPending()
    else {
      this.decorate()
      this._emitter.fire()
    }
    vscode.window.setStatusBarMessage(
      `Twinny: ${what} ${verdict === "accept" ? "accepted" : "rejected"}`,
      3000
    )
  }

  private async editorFor(document: vscode.TextDocument) {
    const visible = vscode.window.visibleTextEditors.find(
      (editor) => editor.document === document
    )
    return visible ?? vscode.window.showTextDocument(document)
  }

  private async resolveEditor(
    uri?: vscode.Uri | string
  ): Promise<vscode.TextEditor | undefined> {
    const active = vscode.window.activeTextEditor
    if (!uri) return active
    const target = typeof uri === "string" ? vscode.Uri.parse(uri) : uri
    if (active && active.document.uri.toString() === target.toString()) {
      return active
    }
    const document = await vscode.workspace.openTextDocument(target)
    return vscode.window.showTextDocument(document)
  }

  /** The selection widened to full lines; an empty selection is its line. */
  private wholeLines(
    document: vscode.TextDocument,
    range: vscode.Range
  ): vscode.Range {
    let endLine = range.end.line
    if (endLine > range.start.line && range.end.character === 0) endLine--
    return new vscode.Range(
      range.start.line,
      0,
      endLine,
      document.lineAt(endLine).range.end.character
    )
  }

  private async askInstruction(
    editor: vscode.TextEditor,
    range: vscode.Range,
    refine = false
  ): Promise<string | undefined> {
    const lines = range.end.line - range.start.line + 1
    const what =
      lines === 1
        ? `line ${range.start.line + 1}`
        : `lines ${range.start.line + 1}-${range.end.line + 1}`
    const file = vscode.workspace.asRelativePath(editor.document.uri)
    const value = await vscode.window.showInputBox(
      refine
        ? {
            title: `Twinny: refine the edit in ${file}`,
            prompt:
              "Describe how to change the proposed code. Enter to preview, Escape to keep it as is.",
            placeHolder: "e.g. shorter, keep the original names, add a comment",
            ignoreFocusOut: true
          }
        : {
            title: `Twinny: edit ${what} of ${file}`,
            prompt: "Describe the change. Enter to preview it, Escape to cancel.",
            placeHolder:
              "e.g. add error handling, convert to async/await, rename x to count",
            ignoreFocusOut: true
          }
    )
    return value?.trim() || undefined
  }

  /**
   * Ask the model and stream the answer into `region`. A fresh region
   * edits the selection; a pending one edits its proposal, and the diff
   * keeps showing against what was there before.
   */
  private async edit(
    editor: vscode.TextEditor,
    region: DiffRegion,
    instruction: string,
    provider: TwinnyProvider
  ) {
    const document = editor.document
    const range = region.range
    const { baseline, proposed } = region.sides()
    const snapshot = region.snapshot()
    const messages = buildEditMessages({
      instruction,
      code: proposed,
      language: document.languageId,
      fileName: vscode.workspace.asRelativePath(document.uri),
      before: clampContext(
        document.getText(
          new vscode.Range(
            Math.max(0, range.start.line - EDIT_CONTEXT_LINES),
            0,
            range.start.line,
            0
          )
        ),
        true
      ),
      after: clampContext(
        document.getText(
          new vscode.Range(
            range.end.line + 1,
            0,
            Math.min(document.lineCount, range.end.line + 1 + EDIT_CONTEXT_LINES),
            0
          )
        ),
        false
      )
    })

    const client = new TokenJS({
      baseURL: this.getProviderBaseUrl(provider),
      apiKey: provider.apiKey
    })

    this._pending = region
    this.begin()
    let reply = ""

    try {
      logger.log(
        `Inline edit request (${provider.modelName}): ${JSON.stringify({
          file: vscode.workspace.asRelativePath(document.uri),
          lines: `${range.start.line + 1}-${range.end.line + 1}`,
          instruction
        })}`
      )

      if (supportsStreaming(provider)) {
        const parts = await client.chat.completions.create(
          buildStreamingRequest(provider, messages)
        )
        for await (const part of parts) {
          if (this._controller?.signal.aborted || region.broken) break
          const delta = part.choices[0]?.delta?.content
          if (!delta) continue
          reply += delta
          await region.render(
            layoutDiff(baseline, previewEdit(reply, proposed), true)
          )
          this.decorate()
        }
      } else {
        const result = await client.chat.completions.create(
          buildBlockingRequest(provider, messages)
        )
        reply = result.choices[0]?.message?.content || ""
      }

      if (region.broken) {
        this.clearPending()
        vscode.window.showWarningMessage(
          "Twinny stopped: the file changed under the edit. Undo (Ctrl+Z) reverts it."
        )
        return
      }

      if (this._controller?.signal.aborted) {
        await this.rewind(region, snapshot)
        vscode.window.setStatusBarMessage("Twinny: edit cancelled", 3000)
        return
      }

      const final = finalizeEdit(reply, proposed)
      logger.log(`Inline edit response: ${final.length} chars`)
      if (final === proposed) {
        await this.rewind(region, snapshot)
        vscode.window.setStatusBarMessage("Twinny: no changes suggested", 4000)
        return
      }
      const layout = layoutDiff(baseline, final)
      await region.render(layout)
      if (region.done) {
        this.clearPending()
        vscode.window.setStatusBarMessage("Twinny: no changes suggested", 4000)
        return
      }
      this.end()
      this.decorate()
      void vscode.commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyInlineEditPending,
        true
      )
      this._emitter.fire()
      vscode.window.setStatusBarMessage(REVIEW_HINT, 8000)
    } catch (error) {
      if (!region.broken) await this.rewind(region, snapshot)
      else this.clearPending()
      if (!isAbortError(error)) {
        logger.error(error instanceof Error ? error : String(error))
        vscode.window.showErrorMessage(
          `Twinny could not edit: ${describeProviderErrorPlain(error, provider)}`
        )
      }
    } finally {
      if (this._running) this.end()
    }
  }

  /** Put the region back the way it was before a request started. */
  private async rewind(region: DiffRegion, snapshot: DiffLayout) {
    await region.render(snapshot)
    if (region.done) {
      this.clearPending()
      return
    }
    this.end()
    this.decorate()
    this._emitter.fire()
  }

  /** Paint the pending diff in every editor showing its document. */
  private decorate() {
    const pending = this._pending
    for (const editor of vscode.window.visibleTextEditors) {
      const own = pending && editor.document === pending.document
      editor.setDecorations(
        this._removedDecoration,
        own ? pending.removed.map(lineRange) : []
      )
      editor.setDecorations(
        this._addedDecoration,
        own ? pending.added.map(lineRange) : []
      )
      editor.setDecorations(
        this._removedWords,
        own ? pending.removedWords.map(spanRange) : []
      )
      editor.setDecorations(
        this._addedWords,
        own ? pending.addedWords.map(spanRange) : []
      )
    }
  }

  private onChange(event: vscode.TextDocumentChangeEvent) {
    const pending = this._pending
    if (!pending || event.document !== pending.document) return
    const undo =
      event.reason === vscode.TextDocumentChangeReason.Undo ||
      event.reason === vscode.TextDocumentChangeReason.Redo
    if (!pending.track(event.contentChanges)) return
    if (!pending.broken) {
      this.decorate()
      this._emitter.fire()
      return
    }
    if (this._running) return // the stream loop reports it
    this.clearPending()
    if (!undo) {
      vscode.window.setStatusBarMessage(
        "Twinny: the file changed under the pending edit; Undo (Ctrl+Z) reverts it.",
        6000
      )
    }
  }

  private clearPending() {
    this._pending = undefined
    this.decorate()
    void vscode.commands.executeCommand(
      "setContext",
      EXTENSION_CONTEXT_NAME.twinnyInlineEditPending,
      false
    )
    this._emitter.fire()
  }

  private begin() {
    this._running = true
    this._controller = new AbortController()
    this._statusBar.busy()
    void vscode.commands.executeCommand(
      "setContext",
      EXTENSION_CONTEXT_NAME.twinnyGeneratingText,
      true
    )
    this._emitter.fire()
  }

  private end() {
    this._running = false
    this._controller = undefined
    this._statusBar.idle()
    void vscode.commands.executeCommand(
      "setContext",
      EXTENSION_CONTEXT_NAME.twinnyGeneratingText,
      false
    )
    this._emitter.fire()
  }
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

const lineRange = (line: number) => new vscode.Range(line, 0, line, 0)
const spanRange = (span: Span) =>
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
const diffLineDecoration = (sign: "-" | "+") =>
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
const diffWordDecoration = (sign: "-" | "+") =>
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

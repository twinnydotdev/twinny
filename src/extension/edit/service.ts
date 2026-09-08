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

import {
  buildEditMessages,
  clampContext,
  EDIT_CONTEXT_LINES,
  extractEditedCode,
  finalizeEdit
} from "./prompt"

export interface InlineEditArgs {
  uri?: vscode.Uri | string
  range?: vscode.Range
  instruction?: string
  /** Preset commands (refactor, add types) need something to work on. */
  requireSelection?: boolean
}

/**
 * Rewrites a region of the active editor to an instruction, in place.
 *
 * The model's reply streams straight into the document as it arrives, so
 * the user watches the code change rather than a spinner. The whole edit is
 * one undo step, and a notification offers to revert it when it is done.
 * Only one edit runs at a time.
 */
export class InlineEditService extends Base {
  private _controller?: AbortController
  private _running = false
  private readonly _decoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
    isWholeLine: true
  })

  constructor(
    context: vscode.ExtensionContext,
    private readonly _statusBar: TwinnyStatusBar
  ) {
    super(context)
  }

  public get running() {
    return this._running
  }

  public abort() {
    this._controller?.abort()
  }

  public dispose() {
    super.dispose()
    this._decoration.dispose()
  }

  /** The command's entry point: resolve the editor and range, ask, run. */
  public async run(args?: InlineEditArgs) {
    if (this._running) {
      vscode.window.showInformationMessage(
        "Twinny is already editing; stop it first (Ctrl+Shift+/)."
      )
      return
    }

    const editor = await this.resolveEditor(args?.uri)
    if (!editor) {
      vscode.window.showInformationMessage("Open a file to edit with Twinny.")
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

    if (args?.requireSelection && !args.range && editor.selection.isEmpty) {
      vscode.window.showInformationMessage("Select the code to edit first.")
      return
    }

    const range = this.wholeLines(editor.document, args?.range ?? editor.selection)
    const instruction =
      args?.instruction?.trim() || (await this.askInstruction(editor, range))
    if (!instruction) return

    await this.edit(editor, range, instruction, provider)
  }

  /* ------------------------------------------------------------------------ */

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
    range: vscode.Range
  ): Promise<string | undefined> {
    const lines = range.end.line - range.start.line + 1
    const what =
      lines === 1
        ? `line ${range.start.line + 1}`
        : `lines ${range.start.line + 1}-${range.end.line + 1}`
    const value = await vscode.window.showInputBox({
      title: `Twinny: edit ${what} of ${vscode.workspace.asRelativePath(
        editor.document.uri
      )}`,
      prompt: "Describe the change. Enter to apply, Escape to cancel.",
      placeHolder: "e.g. add error handling, convert to async/await, rename x to count",
      ignoreFocusOut: true
    })
    return value?.trim() || undefined
  }

  private async edit(
    editor: vscode.TextEditor,
    range: vscode.Range,
    instruction: string,
    provider: TwinnyProvider
  ) {
    const document = editor.document
    const original = document.getText(range)
    const messages = buildEditMessages({
      instruction,
      code: original,
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

    const applier = new RangeApplier(editor, range, this._decoration)
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
          if (this._controller?.signal.aborted) break
          const delta = part.choices[0]?.delta?.content
          if (!delta) continue
          reply += delta
          await applier.apply(extractEditedCode(reply))
        }
      } else {
        const result = await client.chat.completions.create(
          buildBlockingRequest(provider, messages)
        )
        reply = result.choices[0]?.message?.content || ""
      }

      if (this._controller?.signal.aborted) {
        await applier.apply(original, true)
        vscode.window.setStatusBarMessage("Twinny: edit cancelled", 3000)
        return
      }

      const final = finalizeEdit(reply, original)
      await applier.apply(final, true)
      logger.log(`Inline edit response: ${final.length} chars`)
      this.offerUndo(editor, applier, original, final)
    } catch (error) {
      await applier.apply(original, true)
      if (!isAbortError(error)) {
        logger.error(error instanceof Error ? error : String(error))
        vscode.window.showErrorMessage(
          `Twinny could not edit: ${describeProviderErrorPlain(error, provider)}`
        )
      }
    } finally {
      applier.finish()
      this.end()
    }
  }

  private offerUndo(
    editor: vscode.TextEditor,
    applier: RangeApplier,
    original: string,
    final: string
  ) {
    editor.selection = new vscode.Selection(applier.range.start, applier.range.end)
    if (final === original) {
      vscode.window.setStatusBarMessage("Twinny: no changes suggested", 4000)
      return
    }
    const lines = final.split("\n").length
    void vscode.window
      .showInformationMessage(
        `Twinny edited ${lines} line${lines === 1 ? "" : "s"}.`,
        "Undo"
      )
      .then(async (choice) => {
        if (choice !== "Undo") return
        const ok = await applier.apply(original, true)
        if (!ok) {
          vscode.window.showWarningMessage(
            "The edited text has changed since; use Undo (Ctrl+Z) instead."
          )
        }
      })
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
  }
}

/**
 * Keeps replacing one region of a document as new text arrives, tracking
 * where the region now ends. Edits are serialised so a fast stream cannot
 * interleave two replacements, and all of them share a single undo stop.
 */
class RangeApplier {
  public range: vscode.Range
  private _current: string
  private _queue: Promise<boolean> = Promise.resolve(true)
  private _first = true
  private _broken = false

  constructor(
    private readonly _editor: vscode.TextEditor,
    range: vscode.Range,
    private readonly _decoration: vscode.TextEditorDecorationType
  ) {
    this.range = range
    this._current = _editor.document.getText(range)
  }

  /** Replace the region with `text`; resolves false once the document drifted. */
  public apply(text: string, last = false): Promise<boolean> {
    this._queue = this._queue.then(() => this.replace(text, last))
    return this._queue
  }

  public finish() {
    this._editor.setDecorations(this._decoration, [])
  }

  private async replace(text: string, last: boolean): Promise<boolean> {
    if (this._broken) return false
    if (text === this._current) {
      if (last) this.decorate()
      return true
    }
    const before = this.range
    const ok = await this._editor.edit(
      (builder) => builder.replace(before, text),
      { undoStopBefore: this._first, undoStopAfter: last }
    )
    this._first = false
    if (!ok) {
      this._broken = true
      return false
    }
    this.range = endOf(before.start, text)
    this._current = text
    this.decorate()
    return true
  }

  private decorate() {
    this._editor.setDecorations(this._decoration, [this.range])
  }
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

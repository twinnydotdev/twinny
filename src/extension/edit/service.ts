import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"

import { EXTENSION_CONTEXT_NAME } from "../../common/constants"
import { logger } from "../../common/logger"
import { ChatCompletionMessage, TwinnyProvider } from "../../common/types"
import { GenerationRun, GenerationTracker } from "../generations"
import { isCancelled, resolveInferenceProvider } from "../inference"
import { Base } from "../providers/base"
import { describeProviderErrorPlain, isAbortError } from "../providers/errors"

import { DiffLayout, layoutDiff, locateSnippet } from "./diff"
import {
  buildEditMessages,
  clampContext,
  EDIT_CONTEXT_LINES,
  finalizeEdit,
  matchIndentation,
  previewEdit
} from "./prompt"
import {
  diffLineDecoration,
  DiffRegion,
  diffWordDecoration,
  lineRange,
  spanRange
} from "./region"
import {
  appendTests,
  buildTestMessages,
  declaredDependencies,
  isTestFile,
  testFilePath,
  testFrameworkFor
} from "./tests"

export interface InlineEditArgs {
  uri?: vscode.Uri | string
  range?: vscode.Range
  instruction?: string
  /** Preset commands (refactor, add types) need something to work on. */
  requireSelection?: boolean
}

/** What the CodeLens needs to know about the edit in a document. */
export type { Hunk } from "./region"

export interface PendingEditInfo {
  line: number
  streaming: boolean
  /** First line of each hunk, in order. */
  hunks: number[]
}

/** One request to the model whose answer streams into a region. */
interface Generation {
  region: DiffRegion
  messages: ChatCompletionMessage[]
  /** The region's proposed text for what the model has said so far. */
  preview: (reply: string) => string
  /** The region's proposed text for the complete reply. */
  finalize: (reply: string) => string
  /** For the log and the messages: "edit" or "tests". */
  what: string
  /** The log line describing the request. */
  describe: string
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
  private _run?: GenerationRun
  private _pending?: DiffRegion
  private readonly _emitter = new vscode.EventEmitter<void>()
  public readonly onDidChangePending = this._emitter.event

  private readonly _removedDecoration = diffLineDecoration("-")
  private readonly _addedDecoration = diffLineDecoration("+")
  private readonly _removedWords = diffWordDecoration("-")
  private readonly _addedWords = diffWordDecoration("+")

  constructor(
    context: vscode.ExtensionContext,
    private readonly _generations: GenerationTracker
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
    return this._run !== undefined
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
      streaming: this.running,
      hunks: pending.hunks.map((hunk) => hunk.line)
    }
  }

  /** The command's entry point: resolve the editor and range, ask, run. */
  public async run(args?: InlineEditArgs) {
    if (this.running) {
      vscode.window.showInformationMessage(
        "Twinny is already editing; stop it first (Ctrl+Shift+/)."
      )
      return
    }
    const provider = await this.requireProvider()
    if (!provider) return

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

  /**
   * Put a piece of code from the chat into the active editor for review.
   * A selection is replaced. Without one the snippet is matched against the
   * file and shown over the stretch it rewrites; a snippet that matches
   * nothing is inserted at the cursor.
   */
  public async propose(code: string) {
    if (this.running || this._pending) {
      vscode.window.showInformationMessage(
        "Twinny has an edit in progress. Accept or reject it first."
      )
      return
    }
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      vscode.window.showInformationMessage("Open a file to apply the code to.")
      return
    }
    const document = editor.document
    const snippet = code.replace(/\s+$/, "")
    if (!snippet.trim()) return

    let range: vscode.Range
    let text: string
    let how: string
    if (!editor.selection.isEmpty) {
      range = this.wholeLines(document, editor.selection)
      text = matchIndentation(snippet, document.getText(range))
      how = "over the selection"
    } else {
      const found = locateSnippet(
        document.getText().split("\n"),
        snippet.split("\n")
      )
      if (found) {
        range = new vscode.Range(
          found.start,
          0,
          found.end,
          document.lineAt(found.end).range.end.character
        )
        text = matchIndentation(snippet, document.getText(range))
        how = `over lines ${found.start + 1}-${found.end + 1}`
      } else {
        const line = editor.selection.active.line
        range = new vscode.Range(line, 0, line, 0)
        text = snippet + "\n"
        how = `at line ${line + 1}`
      }
    }

    const region = new DiffRegion(editor, range)
    const layout = layoutDiff(document.getText(range), text)
    if (!layout.removed.length && !layout.added.length) {
      vscode.window.setStatusBarMessage("Twinny: the file already has that code", 4000)
      return
    }
    this._pending = region
    await region.render(layout)
    editor.revealRange(region.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    this.present()
    logger.info(`Applied chat code ${how} in ${vscode.workspace.asRelativePath(document.uri)}`)
  }

  /**
   * Write tests for the selection (or the whole file) into the file's test
   * file, opened beside it. A test file that does not exist yet opens
   * untitled with its path, so nothing lands on disk until it is saved;
   * one that exists gets the new tests appended. Either way the tests
   * stream in as a diff to accept or reject, like an edit.
   */
  public async writeTests() {
    if (this.running || this._pending) {
      vscode.window.showInformationMessage(
        "Twinny has an edit in progress. Accept or reject it first."
      )
      return
    }
    const provider = await this.requireProvider()
    if (!provider) return

    const source = vscode.window.activeTextEditor
    if (!source || source.document.uri.scheme !== "file") {
      vscode.window.showInformationMessage("Open a file to write tests for.")
      return
    }
    const document = source.document
    if (isTestFile(document.uri.fsPath)) {
      vscode.window.showInformationMessage(
        "This is a test file already. Open the code to test and try again."
      )
      return
    }

    const range = source.selection.isEmpty
      ? new vscode.Range(
          0,
          0,
          document.lineCount - 1,
          document.lineAt(document.lineCount - 1).range.end.character
        )
      : this.wholeLines(document, source.selection)
    const code = document.getText(range)
    if (!code.trim()) {
      vscode.window.showInformationMessage("There is no code to write tests for.")
      return
    }

    const target = vscode.Uri.file(testFilePath(document.uri.fsPath, document.languageId))
    const editor = await this.openTestFile(target, document.languageId, source)
    const testDocument = editor.document
    const last = testDocument.lineCount - 1
    const region = new DiffRegion(
      editor,
      new vscode.Range(last, 0, last, testDocument.lineAt(last).range.end.character)
    )
    const lastLine = testDocument.getText(region.range)
    const empty = !testDocument.getText().trim()
    const shape = (body: string) => appendTests(lastLine, empty, body)

    const messages = buildTestMessages({
      code,
      language: document.languageId,
      fileName: vscode.workspace.asRelativePath(document.uri),
      testFileName: vscode.workspace.asRelativePath(target),
      framework: testFrameworkFor(
        document.languageId,
        this.dependenciesNear(document.uri.fsPath)
      ),
      existing: empty ? undefined : testDocument.getText()
    })

    await this.generate(provider, {
      region,
      messages,
      preview: (reply) => shape(previewEdit(reply, "")),
      finalize: (reply) => {
        const body = finalizeEdit(reply, "")
        return body ? shape(body) + "\n" : lastLine
      },
      what: "tests",
      describe: JSON.stringify({
        file: vscode.workspace.asRelativePath(document.uri),
        lines: `${range.start.line + 1}-${range.end.line + 1}`,
        testFile: vscode.workspace.asRelativePath(target)
      })
    })
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
    if (!pending || this.running) return
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
    if (pending.done) {
      this.clearPending()
      if (verdict === "reject") await this.closeIfEmptyUntitled(pending.document)
    } else {
      this.decorate()
      this._emitter.fire()
    }
    vscode.window.setStatusBarMessage(
      `Twinny: ${what} ${verdict === "accept" ? "accepted" : "rejected"}`,
      3000
    )
  }

  private async requireProvider(): Promise<TwinnyProvider | undefined> {
    const provider = this.getProvider()
    if (provider) return provider
    const choice = await vscode.window.showWarningMessage(
      "Twinny has no chat provider configured.",
      "Manage providers"
    )
    if (choice) {
      await vscode.commands.executeCommand("twinny.sidebar.focus")
      await vscode.commands.executeCommand("twinny.manageProviders")
    }
    return undefined
  }

  private async editorFor(document: vscode.TextDocument) {
    const visible = vscode.window.visibleTextEditors.find(
      (editor) => editor.document === document
    )
    return visible ?? vscode.window.showTextDocument(document)
  }

  /**
   * The test file in an editor beside the source. An existing file opens
   * as itself; a new one opens untitled at that path, so saving it puts
   * it there and rejecting the tests leaves nothing behind.
   */
  private async openTestFile(
    target: vscode.Uri,
    languageId: string,
    source: vscode.TextEditor
  ): Promise<vscode.TextEditor> {
    const exists = fs.existsSync(target.fsPath)
    const uri = exists ? target : target.with({ scheme: "untitled" })
    const shown = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === uri.toString()
    )
    if (shown) return shown
    const document = await vscode.workspace.openTextDocument(uri)
    if (!exists && document.languageId !== languageId) {
      await vscode.languages.setTextDocumentLanguage(document, languageId)
    }
    // Beside means the group next to the active one, so make sure the
    // source is the active editor first.
    if (vscode.window.activeTextEditor !== source) {
      await vscode.window.showTextDocument(source.document, source.viewColumn)
    }
    return vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false
    })
  }

  /** The dependencies of the nearest package.json above a file. */
  private dependenciesNear(filePath: string): string[] {
    let dir = path.dirname(filePath)
    for (let depth = 0; depth < 12; depth++) {
      const candidate = path.join(dir, "package.json")
      if (fs.existsSync(candidate)) {
        try {
          return declaredDependencies(fs.readFileSync(candidate, "utf8"))
        } catch {
          return []
        }
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return []
  }

  /**
   * An untitled test file with nothing left in it is closed rather than
   * left behind asking to be saved.
   */
  private async closeIfEmptyUntitled(document: vscode.TextDocument) {
    if (!document.isUntitled || document.getText().trim()) return
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document === document
    )
    if (!editor) return
    await vscode.window.showTextDocument(document, editor.viewColumn)
    await vscode.commands.executeCommand(
      "workbench.action.revertAndCloseActiveEditor"
    )
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
   * Rewrite `region` to an instruction. A fresh region edits the
   * selection; a pending one edits its proposal, and the diff keeps
   * showing against what was there before.
   */
  private async edit(
    editor: vscode.TextEditor,
    region: DiffRegion,
    instruction: string,
    provider: TwinnyProvider
  ) {
    const document = editor.document
    const range = region.range
    const { proposed } = region.sides()
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

    await this.generate(provider, {
      region,
      messages,
      preview: (reply) => previewEdit(reply, proposed),
      finalize: (reply) => finalizeEdit(reply, proposed),
      what: "edit",
      describe: JSON.stringify({
        file: vscode.workspace.asRelativePath(document.uri),
        lines: `${range.start.line + 1}-${range.end.line + 1}`,
        instruction
      })
    })
  }

  /**
   * Ask the model and stream the answer into the generation's region as
   * a diff against what the region shows now, then hand it over for a
   * verdict. Nothing changes if the model has nothing to add.
   */
  private async generate(provider: TwinnyProvider, generation: Generation) {
    const { region, messages, what } = generation
    const { baseline, proposed } = region.sides()
    const snapshot = region.snapshot()

    const inference = resolveInferenceProvider(provider)

    this._pending = region
    const run = this.begin()
    let reply = ""

    try {
      logger.info(
        `Inline ${what} request (${provider.modelName}): ${generation.describe}`
      )

      const chunks = inference.chat(
        { model: provider.modelName, messages },
        { signal: run.signal }
      )
      try {
        for await (const chunk of chunks) {
          if (region.broken) break
          reply += chunk.content
          await region.render(
            layoutDiff(baseline, generation.preview(reply), true)
          )
          this.decorate()
        }
      } catch (error) {
        // The user stopped it; the checks below put the region back.
        if (!isCancelled(error)) throw error
      }

      if (region.broken) {
        this.clearPending()
        vscode.window.showWarningMessage(
          `Twinny stopped: the file changed under the ${what}. Undo (Ctrl+Z) reverts it.`
        )
        return
      }

      if (run.signal.aborted) {
        await this.rewind(region, snapshot)
        vscode.window.setStatusBarMessage(`Twinny: ${what} cancelled`, 3000)
        return
      }

      const final = generation.finalize(reply)
      logger.info(`Inline ${what} response: ${final.length} chars`)
      const nothing =
        what === "edit" ? "no changes suggested" : `no ${what} written`
      if (final === proposed) {
        await this.rewind(region, snapshot)
        vscode.window.setStatusBarMessage(`Twinny: ${nothing}`, 4000)
        return
      }
      const layout = layoutDiff(baseline, final)
      await region.render(layout)
      if (region.done) {
        this.clearPending()
        vscode.window.setStatusBarMessage(`Twinny: ${nothing}`, 4000)
        return
      }
      this.end()
      this.present()
    } catch (error) {
      if (!region.broken) await this.rewind(region, snapshot)
      else this.clearPending()
      if (!isAbortError(error)) {
        logger.error(error instanceof Error ? error : String(error))
        vscode.window.showErrorMessage(
          `Twinny could not write the ${what}: ${describeProviderErrorPlain(error, provider)}`
        )
      }
    } finally {
      if (this._run === run) this.end()
    }
  }

  /** Hand the rendered diff over to the user for a verdict. */
  private present() {
    this.decorate()
    void vscode.commands.executeCommand(
      "setContext",
      EXTENSION_CONTEXT_NAME.twinnyInlineEditPending,
      true
    )
    this._emitter.fire()
    vscode.window.setStatusBarMessage(REVIEW_HINT, 8000)
  }

  /** Put the region back the way it was before a request started. */
  private async rewind(region: DiffRegion, snapshot: DiffLayout) {
    await region.render(snapshot)
    if (region.done) {
      this.clearPending()
      await this.closeIfEmptyUntitled(region.document)
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
    if (this.running) return // the stream loop reports it
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
    const run = this._generations.start("edit")
    this._run = run
    this._emitter.fire()
    return run
  }

  private end() {
    this._run?.finish()
    this._run = undefined
    this._emitter.fire()
  }
}

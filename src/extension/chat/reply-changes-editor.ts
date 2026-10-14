/**
 * The editor's side of what a reply changed (`reply-changes.ts`): a
 * read-only view of a file as it was before the reply, the diff of that
 * against the file now, and undoing through a workspace edit, so the
 * editor's own Undo brings the agent's change back again.
 */
import { existsSync } from "fs"
import path from "path"
import { commands, Disposable, Range, TextDocumentContentProvider, Uri, window, workspace, WorkspaceEdit } from "vscode"

import { logger } from "../../common/logger"
import { ReplyChangesView } from "../../common/types"

import { ChangeStore, planUndo, viewOf } from "./reply-changes"

/** `twinny-before:/src/a.ts?<id>`: a file as it was before reply `<id>` changed it. */
export const BEFORE_SCHEME = "twinny-before"

/** The store the read-only views read from; every chat in a window shares one. */
let current: ChangeStore | undefined
let provider: Disposable | undefined

const beforeProvider: TextDocumentContentProvider = {
  provideTextDocumentContent(uri) {
    const record = current?.load(uri.query)
    const file = record?.files.find((f) => `/${f.path}` === uri.path)
    return file?.before ?? ""
  }
}

const beforeUri = (id: string, file: string) => Uri.from({ scheme: BEFORE_SCHEME, path: `/${file}`, query: id })

export interface UndoAnswer {
  /** The changes as they stand afterwards, for the chat to show. */
  view?: ReplyChangesView
  /** Why nothing was undone, for the user. */
  error?: string
}

export class ReplyChangesEditor {
  constructor(
    private readonly _store: ChangeStore,
    private readonly _open: (file: string) => Promise<string | undefined>
  ) {
    current = _store
    provider ??= workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, beforeProvider)
  }

  /** The file as the reply found it beside the file now; a deleted file shows as it was. */
  async openDiff(id: string, file: string): Promise<void> {
    const record = this._store.load(id)
    const change = record?.files.find((f) => f.path === file)
    if (!record || !change) {
      void window.showInformationMessage("twinny no longer keeps what this reply changed.")
      return
    }
    const absolute = Uri.file(path.join(record.root, ...file.split("/")))
    const before = beforeUri(id, file)
    if (!existsSync(absolute.fsPath)) {
      await window.showTextDocument(before, { preview: true })
      return
    }
    await commands.executeCommand("vscode.diff", before, absolute, `${path.posix.basename(file)} · before the agent ↔ now`, {
      preview: true
    })
  }

  /**
   * Put `paths` (all of the reply's, by default) back as they were before
   * it. A file changed since the reply ended is put back only if the user
   * says so: what changed since is lost.
   */
  async undo(id: string, paths?: string[]): Promise<UndoAnswer> {
    const record = this._store.load(id)
    if (!record) return { error: "twinny no longer keeps what this reply changed, so it cannot be undone from here." }
    const steps = await planUndo(record, paths, this._open)
    if (!steps.length) return { view: viewOf(record) }

    const drifted = steps.filter((step) => step.drifted).map((step) => step.path)
    if (drifted.length) {
      const named = drifted.length > 3 ? `${drifted.slice(0, 3).join(", ")} and ${drifted.length - 3} more` : drifted.join(", ")
      const choice = await window.showWarningMessage(
        `${named} changed after this reply. Undo anyway? The later changes to ${drifted.length === 1 ? "it" : "them"} are lost too.`,
        { modal: true },
        "Undo anyway"
      )
      if (choice !== "Undo anyway") return { view: viewOf(record) }
    }

    const edit = new WorkspaceEdit()
    const saved: Uri[] = []
    for (const step of steps) {
      const uri = Uri.file(step.absolute)
      const there = existsSync(step.absolute)
      if (step.restore === null) {
        if (there) edit.deleteFile(uri, { ignoreIfNotExists: true })
      } else if (there) {
        const document = await workspace.openTextDocument(uri)
        edit.replace(uri, document.validateRange(new Range(0, 0, document.lineCount, 0)), step.restore)
        saved.push(uri)
      } else {
        edit.createFile(uri, { contents: Buffer.from(step.restore, "utf8"), ignoreIfExists: false })
      }
    }
    if (!(await workspace.applyEdit(edit))) return { error: "The editor refused to undo the changes." }
    for (const uri of saved) {
      const document = workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
      if (document?.isDirty) await document.save()
    }
    const updated = this._store.markUndone(id, steps.map((step) => step.path))
    logger.info(`Chat undid ${steps.length} file change${steps.length === 1 ? "" : "s"} from a reply`)
    return { view: updated ? viewOf(updated) : undefined }
  }
}

/**
 * The empty chat's first questions: one click asks about the open file, or
 * the selection when there is one. Each is a short, plain instruction a
 * small local model follows well, with the code attached and cut to what
 * the model's context has room for.
 */
import { window, workspace } from "vscode"

import type { StarterKind } from "../../common/model-status"

import type { Chat } from "./index"
import { starterRequest } from "./starter-request"

export const runStarter = async (chat: Chat, kind: StarterKind) => {
  const editor = window.activeTextEditor
  if (!editor || !editor.document.getText().trim()) {
    void window.showInformationMessage("Open a file first: twinny asks about the file or selection in the editor.")
    return
  }
  const selected = !editor.selection.isEmpty
  const status = await chat.modelStatus()
  const request = starterRequest(
    kind,
    {
      path: workspace.asRelativePath(editor.document.uri, false),
      text: editor.document.getText(selected ? editor.selection : undefined),
      ...(selected
        ? { selection: { startLine: editor.selection.start.line, endLine: editor.selection.end.line } }
        : {})
    },
    status?.contextWindow
  )
  await chat.ask(request.display, request.prompt, [request.entry])
}

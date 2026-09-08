import * as vscode from "vscode"

import { TWINNY_COMMAND_NAME } from "../../common/constants"

import { InlineEditService } from "./service"

const mac = process.platform === "darwin"
const ACCEPT_KEY = mac ? "⌘⇧↩" : "Ctrl+Shift+Enter"
const REJECT_KEY = mac ? "⌘⇧⌫" : "Ctrl+Shift+Backspace"
const STOP_KEY = mac ? "⌘⇧/" : "Ctrl+Shift+/"

/**
 * The buttons above an inline edit: "Stop" while it streams, then
 * "Accept" and "Reject" while the diff waits for a verdict.
 */
export class InlineEditCodeLensProvider implements vscode.CodeLensProvider {
  public readonly onDidChangeCodeLenses: vscode.Event<void>

  constructor(private readonly _service: InlineEditService) {
    this.onDidChangeCodeLenses = _service.onDidChangePending
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const pending = this._service.pendingFor(document)
    if (!pending) return []
    const range = new vscode.Range(pending.line, 0, pending.line, 0)
    const lens = (title: string, command: string, tooltip?: string) =>
      new vscode.CodeLens(range, { title, command, tooltip })

    if (pending.streaming) {
      return [
        lens("$(loading~spin) Twinny is editing…", ""),
        lens(
          `$(debug-stop) Stop (${STOP_KEY})`,
          TWINNY_COMMAND_NAME.stopGeneration,
          "Stop and put the original code back"
        )
      ]
    }
    return [
      lens(
        `$(check) Accept (${ACCEPT_KEY})`,
        TWINNY_COMMAND_NAME.acceptEdit,
        "Keep the new lines and delete the old ones"
      ),
      lens(
        `$(close) Reject (${REJECT_KEY})`,
        TWINNY_COMMAND_NAME.rejectEdit,
        "Delete the new lines and keep the old ones"
      )
    ]
  }
}

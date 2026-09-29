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
    if (pending.hunks.length <= 1) {
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

    const lenses = [
      lens(
        `$(check-all) Accept all (${ACCEPT_KEY})`,
        TWINNY_COMMAND_NAME.acceptEdit,
        "Keep every new line and delete every old one"
      ),
      lens(
        `$(close-all) Reject all (${REJECT_KEY})`,
        TWINNY_COMMAND_NAME.rejectEdit,
        "Delete every new line and keep every old one"
      )
    ]
    pending.hunks.forEach((line, index) => {
      const at = new vscode.Range(line, 0, line, 0)
      lenses.push(
        new vscode.CodeLens(at, {
          title: "$(check) Accept",
          command: TWINNY_COMMAND_NAME.acceptEdit,
          arguments: [index],
          tooltip: "Keep this hunk's new lines and delete its old ones"
        }),
        new vscode.CodeLens(at, {
          title: "$(close) Reject",
          command: TWINNY_COMMAND_NAME.rejectEdit,
          arguments: [index],
          tooltip: "Delete this hunk's new lines and keep its old ones"
        })
      )
    })
    return lenses
  }
}

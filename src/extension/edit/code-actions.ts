import * as vscode from "vscode"

import { TWINNY_COMMAND_NAME } from "../../common/constants"

import { InlineEditArgs } from "./service"

/** Diagnostics worth offering a fix for; hints and infos are not bugs. */
const FIXABLE = new Set([
  vscode.DiagnosticSeverity.Error,
  vscode.DiagnosticSeverity.Warning
])

const MAX_FIX_LINES = 60

/**
 * The lightbulb: "Fix with Twinny" on an error or warning, and "Edit with
 * Twinny" on any selection. Both run the inline edit command; the fix
 * passes the diagnostic's message as the instruction, so there is nothing
 * to type.
 */
export class InlineEditCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.RefactorRewrite
  ]

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = []
    const seen = new Set<string>()

    for (const diagnostic of context.diagnostics) {
      if (!FIXABLE.has(diagnostic.severity)) continue
      const message = diagnostic.message.trim().replace(/\s+/g, " ")
      const key = `${diagnostic.range.start.line}:${message}`
      if (seen.has(key)) continue
      seen.add(key)

      const action = new vscode.CodeAction(
        `Fix with Twinny: ${shorten(message, 60)}`,
        vscode.CodeActionKind.QuickFix
      )
      action.diagnostics = [diagnostic]
      action.command = this.command("Fix with Twinny", {
        uri: document.uri,
        range: this.fixRange(document, diagnostic.range),
        instruction: fixInstruction(diagnostic)
      })
      actions.push(action)
    }

    if (!range.isEmpty) {
      const action = new vscode.CodeAction(
        "Edit with Twinny…",
        vscode.CodeActionKind.RefactorRewrite
      )
      action.command = this.command("Edit with Twinny", {
        uri: document.uri,
        range
      })
      actions.push(action)
    }

    return actions
  }

  private command(title: string, args: InlineEditArgs): vscode.Command {
    return { title, command: TWINNY_COMMAND_NAME.edit, arguments: [args] }
  }

  /**
   * A diagnostic often points at one token; the fix usually needs the
   * statement around it. Give the model the whole lines, capped so a
   * file-wide diagnostic does not turn into a file-wide rewrite.
   */
  private fixRange(
    document: vscode.TextDocument,
    range: vscode.Range
  ): vscode.Range {
    const endLine = Math.min(range.end.line, range.start.line + MAX_FIX_LINES - 1)
    return new vscode.Range(
      range.start.line,
      0,
      endLine,
      document.lineAt(endLine).range.end.character
    )
  }
}

const shorten = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

const fixInstruction = (diagnostic: vscode.Diagnostic): string => {
  const source = diagnostic.source ? ` (${diagnostic.source})` : ""
  return `Fix this problem${source}: ${diagnostic.message.trim()}`
}

import * as os from "os"
import { ProgressLocation, window, workspace } from "vscode"

import { Chat } from "../chat"
import { getTerminal } from "../utils"

import { TerminalHistory } from "./history"
import { extractShellCommand, tailOutput } from "./output"

export interface ShellCommandRequest {
  request: string
  platform: string
  shell: string
  cwd?: string
  /** The previous command and its output, so "again but verbose" works. */
  previous?: { commandLine: string; output: string }
}

/** The one-shot prompt: everything a small model needs, nothing it does not. */
export const buildShellCommandPrompt = (input: ShellCommandRequest): string => {
  const parts = [
    `Write a single ${input.shell} command line for ${input.platform} that does the following:`,
    input.request.trim(),
    "",
    "Rules:",
    "- Reply with the command only, on one line. No explanation, no markdown fences.",
    "- Use pipes or && if more than one step is needed; never a script.",
    "- Do not invent flags. Prefer widely available tools.",
    "- Never include commands that delete or overwrite data unless the request asks for exactly that."
  ]
  if (input.cwd) parts.push(`- The working directory is ${input.cwd}.`)
  if (input.previous?.commandLine) {
    parts.push(
      "",
      "For reference, the previous command in this terminal was:",
      input.previous.commandLine,
      ...(input.previous.output.trim()
        ? ["and it printed:", tailOutput(input.previous.output, { maxChars: 1500, maxLines: 30 })]
        : [])
    )
  }
  return parts.join("\n")
}

const shellName = () => {
  const shell = process.env.SHELL || os.userInfo().shell || ""
  if (os.platform() === "win32") return "PowerShell"
  return shell.split(/[\\/]/).pop() || "sh"
}

/**
 * Describe what you want, get a command, check it, run it. The command is
 * shown in an editable box before anything happens; Escape runs nothing.
 */
export const runDescribedCommand = async (
  chat: Chat,
  history: TerminalHistory
) => {
  const request = await window.showInputBox({
    title: "Twinny: describe the command",
    prompt: "What do you want to run? Twinny writes the command and shows it before running anything.",
    placeHolder: "e.g. list the ten largest files under src",
    ignoreFocusOut: true
  })
  if (!request?.trim()) return

  const previous = history.last()
  const prompt = buildShellCommandPrompt({
    request,
    platform: `${os.platform()} (${os.release()})`,
    shell: shellName(),
    cwd: workspace.workspaceFolders?.[0]?.uri.fsPath,
    previous: previous
      ? { commandLine: previous.commandLine, output: previous.output }
      : undefined
  })

  const reply = await window.withProgress(
    { location: ProgressLocation.Notification, title: "Twinny is writing the command…" },
    () => chat.generateSimpleCompletion(prompt)
  )
  const command = reply ? extractShellCommand(reply) : ""
  if (!command) {
    window.showErrorMessage("Twinny could not come up with a command for that.")
    return
  }

  const confirmed = await window.showInputBox({
    title: "Twinny: run this command?",
    value: command,
    prompt: "Check it, edit if needed, then press Enter to run it in the Twinny terminal. Escape cancels.",
    ignoreFocusOut: true
  })
  if (!confirmed?.trim()) return

  const terminal = await getTerminal()
  if (!terminal) return
  terminal.show()
  terminal.sendText(confirmed.trim(), true)
}

import * as fs from "fs"
import * as path from "path"
import { commands, Range, Uri, window, workspace } from "vscode"

import { TWINNY_COMMAND_NAME } from "../../common/constants"
import { Chat } from "../chat"
import { ContextEntry } from "../chat/context-files"
import { symbolAtLine } from "../chat/symbols"
import { InlineEditArgs } from "../edit/service"

import { NO_TERMINAL_OUTPUT, TerminalHistory } from "./history"
import {
  extractFileLocations,
  FileLocation,
  formatTerminalRun,
  stripAnsi,
  tailOutput,
  TerminalRun
} from "./output"

/** How many referenced files travel to the chat with the error. */
const MAX_ATTACHED = 3
/** Lines either side of a referenced line when no enclosing symbol is known. */
const CONTEXT_LINES = 20

interface ResolvedLocation extends FileLocation {
  uri: Uri
  relative: string
}

/**
 * The lines from an output that name the problem: the last few mentioning
 * an error, else the last few lines. Short enough to be an instruction.
 */
export const summariseError = (output: string, maxChars = 400): string => {
  const lines = stripAnsi(output)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const errorLines = lines.filter((line) =>
    /\b(error|exception|failed|fatal|panic|cannot|undefined|not found)\b/i.test(line)
  )
  const picked = (errorLines.length ? errorLines : lines).slice(-3)
  const text = picked.join(" ")
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Locations from the output that are real files in this workspace. */
const resolveLocations = (run: TerminalRun): ResolvedLocation[] => {
  const roots = [
    ...(run.cwd ? [run.cwd] : []),
    ...(workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)
  ]
  const resolved: ResolvedLocation[] = []
  for (const location of extractFileLocations(run.output)) {
    const candidates = path.isAbsolute(location.path)
      ? [location.path]
      : roots.map((root) => path.join(root, location.path))
    const found = candidates.find(
      (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    )
    if (!found) continue
    const uri = Uri.file(found)
    const relative = workspace.asRelativePath(uri, false)
    if (workspace.getWorkspaceFolder(uri) && !resolved.some((r) => r.uri.fsPath === found && r.line === location.line)) {
      resolved.push({ ...location, uri, relative })
    }
  }
  return resolved
}

/** The code around a referenced line: its enclosing symbol, else a window. */
const entryFor = async (location: ResolvedLocation): Promise<ContextEntry> => {
  const document = await workspace.openTextDocument(location.uri)
  const zeroLine = Math.max(0, location.line - 1)
  const enclosing = await symbolAtLine(location.uri, zeroLine)
  const range =
    enclosing && enclosing.range.end.line - enclosing.range.start.line < 200
      ? enclosing.range
      : new Range(
          Math.max(0, zeroLine - CONTEXT_LINES),
          0,
          Math.min(document.lineCount - 1, zeroLine + CONTEXT_LINES),
          0
        )
  const full = new Range(
    range.start.line,
    0,
    range.end.line,
    document.lineAt(range.end.line).range.end.character
  )
  return {
    path: location.relative,
    content: document.getText(full),
    range: { startLine: full.start.line, endLine: full.end.line }
  }
}

const sendToChat = async (
  chat: Chat,
  run: TerminalRun,
  locations: ResolvedLocation[]
) => {
  const entries: ContextEntry[] = []
  for (const location of locations.slice(0, MAX_ATTACHED)) {
    try {
      entries.push(await entryFor(location))
    } catch {
      // The file vanished between the check and the read; skip it.
    }
  }
  const shown = tailOutput(run.output, { maxChars: 3000, maxLines: 40 })
  const display =
    "Fix this terminal error\n\n\n<pre><code>" +
    escapeHtml(`$ ${run.commandLine}\n${shown}`.trim()) +
    "</code></pre>"
  const prompt = [
    "A command I ran in the terminal failed. Explain what went wrong and show me the fix.",
    "If the fix is a code change, show the corrected code. If it is a different command, give the command.",
    "",
    formatTerminalRun(run)
  ].join("\n")
  await chat.ask(display, prompt, entries)
}

const fixInEditor = async (
  run: TerminalRun,
  location: ResolvedLocation
) => {
  const document = await workspace.openTextDocument(location.uri)
  const zeroLine = Math.min(document.lineCount - 1, Math.max(0, location.line - 1))
  const enclosing = await symbolAtLine(location.uri, zeroLine)
  const range =
    enclosing && enclosing.range.end.line - enclosing.range.start.line < 120
      ? enclosing.range
      : new Range(zeroLine, 0, zeroLine, document.lineAt(zeroLine).range.end.character)
  await window.showTextDocument(document, { selection: range })
  const args: InlineEditArgs = {
    uri: location.uri,
    range,
    instruction: `Fix this error reported by \`${run.commandLine.trim()}\` at line ${location.line}: ${summariseError(run.output)}`
  }
  await commands.executeCommand(TWINNY_COMMAND_NAME.edit, args)
}

/**
 * "Fix the last terminal error": the most recent failed command's output goes
 * to the chat with the files it names attached, or, when it names one line
 * in this workspace, straight into an inline edit there.
 */
export const fixTerminalError = async (
  chat: Chat,
  history: TerminalHistory
) => {
  const run = history.lastFailed() ?? history.last()
  if (!run) {
    window.showInformationMessage(NO_TERMINAL_OUTPUT)
    return
  }
  const locations = resolveLocations(run)
  const first = locations[0]

  if (!first) {
    await sendToChat(chat, run, [])
    return
  }

  const choice = await window.showQuickPick(
    [
      {
        label: `$(edit) Fix in editor: ${first.relative}:${first.line}`,
        description: "Inline edit at the reported line",
        action: "edit" as const
      },
      {
        label: "$(comment-discussion) Ask in chat",
        description: `Attach the output and ${locations.length === 1 ? "the file it names" : `${Math.min(locations.length, MAX_ATTACHED)} files it names`}`,
        action: "chat" as const
      }
    ],
    { title: "Twinny: fix the last terminal error", placeHolder: summariseError(run.output, 120) }
  )
  if (!choice) return
  if (choice.action === "edit") await fixInEditor(run, first)
  else await sendToChat(chat, run, locations)
}

/**
 * What the chat's tools reach in the editor: edits go through the inline
 * edit service, commands run in the Twinny terminal, `search_code` asks
 * the embeddings index. The tools themselves (`tools/workspace.ts`) know
 * none of this, so they run headless in tests and the eval.
 */
import { exec } from "child_process"
import {
  commands,
  Diagnostic,
  DiagnosticSeverity,
  languages,
  Location,
  LocationLink,
  Position,
  Range,
  Terminal,
  TerminalShellIntegration,
  Uri,
  window,
  workspace,
  WorkspaceEdit
} from "vscode"

import {
  DEFAULT_RERANK_THRESHOLD,
  DEFAULT_WORKSPACE_HIT_CHARS,
  TWINNY,
  TWINNY_COMMAND_NAME
} from "../../common/constants"
import { logger } from "../../common/logger"
import type { ChatEditMode, ChatEditOutcome } from "../edit/service"
import { WorkspaceSearch } from "../embeddings/search"
import { stripAnsi, tailOutput } from "../terminal/output"
import { EditorDiagnostic, EditorLocation, EditorSink, FileOpsSink } from "../tools/more"
import { CodeSearch, CommandOutcome, CommandSink, EditSink } from "../tools/workspace"

export type ChatCommandMode = "ask" | "allow" | "off"

/** How long a command may run before the model is given what it has so far. */
const COMMAND_TIMEOUT_MS = 120_000
/** How long a new terminal gets to report shell integration. */
const INTEGRATION_WAIT_MS = 4000
const OUTPUT_TAIL = { maxChars: 4000, maxLines: 80 }
const MAX_CAPTURE_CHARS = 200_000
const SEARCH_HITS = 6
const SEARCH_CHARS = 8000

/** Asks the user to approve a change in the chat's tool steps; true to go ahead. */
export type ApproveChange = (detail: string, approval: "command" | "change") => Promise<boolean>

const relative = (file: string) => workspace.asRelativePath(Uri.file(file), false)

/** Apply a workspace edit and save what it touched, so later reads and searches of the disk agree. */
const applyAndSave = async (edit: WorkspaceEdit): Promise<boolean> => {
  if (!(await workspace.applyEdit(edit))) return false
  for (const [uri] of edit.entries()) {
    const document = workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
    if (document?.isDirty) await document.save()
  }
  return true
}

/**
 * Edits and new files applied and saved, or shown for review, as
 * `twinny.chatToolsEdits` says; deletes and moves likewise, asked in the
 * chat when reviewing since they have no diff. Reads see unsaved changes.
 */
export const editorEdits = (mode: ChatEditMode, approve: ApproveChange): EditSink & FileOpsSink => ({
  mode,
  read: async (file) =>
    workspace.textDocuments.find((document) => document.uri.fsPath === file)?.getText(),
  edit: async (file, replacement) =>
    (await commands.executeCommand<ChatEditOutcome>(
      TWINNY_COMMAND_NAME.chatFileEdit,
      { file, ...replacement },
      mode
    )) ?? { ok: false, message: "Not changed: the editor did not answer." },
  create: async (file, content) =>
    (await commands.executeCommand<ChatEditOutcome>(
      TWINNY_COMMAND_NAME.chatFileCreate,
      file,
      content,
      mode
    )) ?? { ok: false, message: "Not created: the editor did not answer." },
  async remove(file) {
    if (mode === "review" && !(await approve(`delete ${relative(file)}`, "change"))) {
      return { ok: false, message: "The user chose not to delete it." }
    }
    const edit = new WorkspaceEdit()
    edit.deleteFile(Uri.file(file), { ignoreIfNotExists: false })
    return (await workspace.applyEdit(edit))
      ? { ok: true, message: `Deleted ${relative(file)}. The user can undo it.` }
      : { ok: false, message: `The editor refused to delete ${relative(file)}.` }
  },
  async move(from, to) {
    if (mode === "review" && !(await approve(`move ${relative(from)} → ${relative(to)}`, "change"))) {
      return { ok: false, message: "The user chose not to move it." }
    }
    const edit = new WorkspaceEdit()
    edit.renameFile(Uri.file(from), Uri.file(to), { overwrite: false })
    return (await applyAndSave(edit))
      ? { ok: true, message: `Moved ${relative(from)} to ${relative(to)}. The user can undo it.` }
      : { ok: false, message: `The editor refused to move ${relative(from)}.` }
  }
})

/** How long diagnostics get to settle after a file is opened or changed. */
const DIAGNOSTICS_SETTLE_MS = 1500
const MAX_SELECTION_CHARS = 4000

const SEVERITY: Record<DiagnosticSeverity, EditorDiagnostic["severity"]> = {
  [DiagnosticSeverity.Error]: "error",
  [DiagnosticSeverity.Warning]: "warning",
  [DiagnosticSeverity.Information]: "info",
  [DiagnosticSeverity.Hint]: "info"
}

/** Resolves once the language server reports on `uri`, or after a short wait if it has nothing new. */
const settledDiagnostics = (uri: Uri) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      listener.dispose()
      resolve()
    }, DIAGNOSTICS_SETTLE_MS)
    const listener = languages.onDidChangeDiagnostics((event) => {
      if (!event.uris.some((changed) => changed.toString() === uri.toString())) return
      clearTimeout(timer)
      listener.dispose()
      resolve()
    })
  })

const lineText = async (uri: Uri, line: number) => {
  try {
    const document = await workspace.openTextDocument(uri)
    return line < document.lineCount ? document.lineAt(line).text : undefined
  } catch {
    return undefined
  }
}

const toLocations = async (found: Array<Location | LocationLink> | undefined): Promise<EditorLocation[]> => {
  const locations = (found ?? []).map((item) =>
    "targetUri" in item
      ? { uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange }
      : { uri: item.uri, range: item.range }
  )
  return Promise.all(
    locations.map(async ({ uri, range }) => ({
      file: uri.fsPath,
      line: range.start.line + 1,
      text: await lineText(uri, range.start.line)
    }))
  )
}

const toDiagnostic = (uri: Uri, diagnostic: Diagnostic): EditorDiagnostic => ({
  file: uri.fsPath,
  line: diagnostic.range.start.line + 1,
  severity: SEVERITY[diagnostic.severity],
  message: diagnostic.message.split("\n")[0],
  source: diagnostic.source
})

/** What VS Code and its language servers know, for the chat's tools. */
export const editorKnowledge = (root: string, mode: ChatEditMode, approve: ApproveChange): EditorSink => ({
  async diagnostics(file) {
    if (file) {
      const uri = Uri.file(file)
      const settled = settledDiagnostics(uri)
      await workspace.openTextDocument(uri)
      await settled
      return languages.getDiagnostics(uri).map((d) => toDiagnostic(uri, d))
    }
    return languages
      .getDiagnostics()
      .filter(([uri]) => uri.scheme === "file" && uri.fsPath.startsWith(root))
      .flatMap(([uri, found]) => found.map((d) => toDiagnostic(uri, d)))
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1))
  },
  async references(file, line, character) {
    const found = await commands.executeCommand<Location[]>(
      "vscode.executeReferenceProvider",
      Uri.file(file),
      new Position(line, character)
    )
    return toLocations(found)
  },
  async definition(file, line, character) {
    const found = await commands.executeCommand<Array<Location | LocationLink>>(
      "vscode.executeDefinitionProvider",
      Uri.file(file),
      new Position(line, character)
    )
    return toLocations(found)
  },
  async rename(file, line, character, newName) {
    let edit: WorkspaceEdit | undefined
    try {
      edit = await commands.executeCommand<WorkspaceEdit>(
        "vscode.executeDocumentRenameProvider",
        Uri.file(file),
        new Position(line, character),
        newName
      )
    } catch (error) {
      return { ok: false, message: `The language server could not rename it: ${error instanceof Error ? error.message : error}` }
    }
    if (!edit || !edit.size) {
      return { ok: false, message: "The language server has no rename here; edit the uses with edit_file instead." }
    }
    const files = edit.entries().map(([uri]) => relative(uri.fsPath))
    const changes = edit.entries().reduce((n, [, edits]) => n + edits.length, 0)
    if (mode === "review" && !(await approve(`rename to ${newName}: ${changes} changes in ${files.join(", ")}`, "change"))) {
      return { ok: false, message: "The user chose not to rename it." }
    }
    return (await applyAndSave(edit))
      ? { ok: true, files, message: `Renamed to ${newName}: ${changes} changes in ${files.join(", ")}. Saved; the user can undo it.` }
      : { ok: false, message: "The editor refused the rename." }
  },
  async context() {
    const editor = window.activeTextEditor
    const selection = editor && !editor.selection.isEmpty ? editor.selection : undefined
    const text = selection ? editor!.document.getText(new Range(selection.start, selection.end)) : ""
    return {
      activeFile: editor?.document.uri.scheme === "file" ? editor.document.uri.fsPath : undefined,
      cursorLine: editor ? editor.selection.active.line + 1 : undefined,
      selection: selection
        ? {
            startLine: selection.start.line + 1,
            endLine: selection.end.line + 1,
            text: text.length > MAX_SELECTION_CHARS ? `${text.slice(0, MAX_SELECTION_CHARS)}\n… (cut)` : text
          }
        : undefined,
      openFiles: window.tabGroups.all
        .flatMap((group) => group.tabs)
        .map((tab) => (tab.input as { uri?: Uri } | undefined)?.uri)
        .filter((uri): uri is Uri => uri?.scheme === "file")
        .map((uri) => uri.fsPath)
    }
  }
})

const twinnyTerminal = (cwd: string): Terminal =>
  window.terminals.find((terminal) => terminal.name === TWINNY && terminal.exitStatus === undefined) ??
  window.createTerminal({ name: TWINNY, cwd })

/** The terminal's shell integration, waiting briefly for a new terminal's shell to report it. */
const integrationOf = (terminal: Terminal): Promise<TerminalShellIntegration | undefined> => {
  if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      listener.dispose()
      resolve(undefined)
    }, INTEGRATION_WAIT_MS)
    const listener = window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal !== terminal) return
      clearTimeout(timer)
      listener.dispose()
      resolve(event.shellIntegration)
    })
  })
}

/** In the Twinny terminal, so the user sees it and `@terminal` has it afterwards. */
const runInTerminal = async (
  terminal: Terminal,
  integration: TerminalShellIntegration,
  command: string
): Promise<CommandOutcome> => {
  const execution = integration.executeCommand(command)
  let output = ""
  const reading = (async () => {
    for await (const chunk of execution.read()) {
      output = (output + chunk).slice(-MAX_CAPTURE_CHARS)
    }
  })().catch((error) => logger.warn(`Chat command output: ${error}`))
  const ended = await new Promise<{ exitCode?: number } | "timeout">((resolve) => {
    const done = (result: { exitCode?: number } | "timeout") => {
      clearTimeout(timer)
      finished.dispose()
      closed.dispose()
      resolve(result)
    }
    const timer = setTimeout(() => done("timeout"), COMMAND_TIMEOUT_MS)
    const finished = window.onDidEndTerminalShellExecution((event) => {
      if (event.execution === execution) done({ exitCode: event.exitCode })
    })
    // `exit` and friends end the shell itself, and with it any end event.
    const closed = window.onDidCloseTerminal((gone) => {
      if (gone === terminal) done({ exitCode: gone.exitStatus?.code })
    })
  })
  // The last chunk can land just after the end event.
  await Promise.race([reading, new Promise((resolve) => setTimeout(resolve, 300))])
  const tail = tailOutput(stripAnsi(output), OUTPUT_TAIL)
  return ended === "timeout"
    ? { ran: true, output: tail, timedOut: true }
    : { ran: true, output: tail, exitCode: ended.exitCode }
}

/** Without shell integration: in the background, from the workspace root. */
const runDetached = (command: string, cwd: string): Promise<CommandOutcome> =>
  new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const output = tailOutput(`${stdout}${stderr ? `\n${stderr}` : ""}`, OUTPUT_TAIL)
        const timedOut = !!error && (error as { killed?: boolean }).killed === true
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
        resolve(timedOut ? { ran: true, output, timedOut } : { ran: true, output, exitCode: code })
      }
    )
  })

/** Asks in a notification, for hosts without a chat to ask in. */
const askInNotification = async (command: string) =>
  (await window.showInformationMessage(`Twinny wants to run: ${command}`, "Run", "Skip")) === "Run"

/**
 * Commands the model asks for: put to the user first in `ask` mode (in
 * the chat's tool steps when `approve` is given), then run.
 */
export const terminalCommands = (
  mode: "ask" | "allow",
  cwd: string,
  approve: (command: string) => Promise<boolean> = askInNotification
): CommandSink => ({
  mode,
  async run(command) {
    if (mode === "ask") {
      if (!(await approve(command))) {
        logger.info(`Chat command skipped: ${command}`)
        return { ran: false, output: "" }
      }
    }
    logger.info(`Chat command: ${command}`)
    const terminal = twinnyTerminal(cwd)
    terminal.show(true)
    const integration = await integrationOf(terminal)
    if (integration) return runInTerminal(terminal, integration, command)
    logger.info("Chat command: no shell integration in the Twinny terminal, running in the background")
    return runDetached(command, cwd)
  }
})

/** `search_code` over the embeddings index, with the chat's own threshold. */
export const indexSearch = (
  search: WorkspaceSearch,
  threshold: () => number | undefined
): CodeSearch => ({
  async search(query) {
    const result = await search.searchDetailed(query, {
      limit: SEARCH_HITS,
      threshold: threshold() || DEFAULT_RERANK_THRESHOLD,
      maxChars: SEARCH_CHARS,
      expandChars: DEFAULT_WORKSPACE_HIT_CHARS
    })
    return result.hits.filter((hit) => hit.kind !== "imports")
  }
})

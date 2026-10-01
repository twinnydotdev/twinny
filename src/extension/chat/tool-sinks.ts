/**
 * What the chat's tools reach in the editor: edits go through the inline
 * edit service, commands run in a terminal of their own, `search_code`
 * asks the embeddings index, and the language servers answer for errors,
 * references and renames. The tools themselves (`tools/workspace.ts`)
 * know none of this, so they run headless in tests and the eval.
 *
 * Edits apply straight away or wait for review, as the user set. A few
 * things wait for the user whatever the setting, because undo would not
 * bring them back or because they widen what the model may do: deleting a
 * file git has no copy of, and changing `.vscode/` or a `.gitignore`.
 */
import { exec, execFile } from "child_process"
import path from "path"
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
import { isProtectedPath } from "../tools/helpers"
import { EditorDiagnostic, EditorLocation, EditorSink, FileOpsSink } from "../tools/more"
import { WorkspaceView } from "../tools/view"
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

/** Asks the user to approve something in the chat's tool steps; true to go ahead. */
export type ApproveChange = (detail: string, approval: "command" | "change") => Promise<boolean>

/** A file as the editor has it when it is open there, unsaved changes included. */
export const openDocumentText = async (file: string): Promise<string | undefined> =>
  // Only the file itself: a diff view holds another version of it under
  // the same path with a different scheme.
  workspace.textDocuments.find((document) => document.uri.scheme === "file" && document.uri.fsPath === file)?.getText()

/** Apply a workspace edit and save what it touched, so later reads and searches of the disk agree. */
const applyAndSave = async (edit: WorkspaceEdit): Promise<boolean> => {
  if (!(await workspace.applyEdit(edit))) return false
  for (const [uri] of edit.entries()) {
    const document = workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
    if (document?.isDirty) await document.save()
  }
  return true
}

const gitSays = (cwd: string, args: string[]) =>
  new Promise<boolean>((resolve) => {
    execFile("git", args, { cwd, timeout: 5000 }, (error) => resolve(!error))
  })

/** Whether git could give the file back exactly as it is: tracked, unchanged since the last commit, nothing unsaved. */
const recoverableFromGit = async (file: string): Promise<boolean> => {
  if (workspace.textDocuments.some((d) => d.uri.scheme === "file" && d.uri.fsPath === file && d.isDirty)) return false
  const cwd = path.dirname(file)
  return (
    (await gitSays(cwd, ["ls-files", "--error-unmatch", "--", file])) &&
    (await gitSays(cwd, ["diff", "--quiet", "HEAD", "--", file]))
  )
}

/**
 * Edits and new files applied and saved, or shown for review, as
 * `twinny.chatToolsEdits` says; deletes and moves likewise, asked in the
 * chat when reviewing since they have no diff.
 */
export const editorEdits = (
  view: WorkspaceView,
  mode: ChatEditMode,
  approve: ApproveChange
): EditSink & FileOpsSink => {
  /** A protected file's change is always shown as a diff first. */
  const modeFor = (file: string): ChatEditMode => (isProtectedPath(view.relative(file)) ? "review" : mode)
  return {
    mode,
    edit: async (file, replacement) =>
      (await commands.executeCommand<ChatEditOutcome>(
        TWINNY_COMMAND_NAME.chatFileEdit,
        { file, ...replacement },
        modeFor(file)
      )) ?? { ok: false, message: "Not changed: the editor did not answer." },
    create: async (file, content) =>
      (await commands.executeCommand<ChatEditOutcome>(
        TWINNY_COMMAND_NAME.chatFileCreate,
        file,
        content,
        modeFor(file)
      )) ?? { ok: false, message: "Not created: the editor did not answer." },
    async remove(file) {
      const relative = view.relative(file)
      // Without asking only when nothing is lost: git has the file as it is.
      const lost = mode === "apply" && !isProtectedPath(relative) && !(await recoverableFromGit(file))
      if (
        (mode === "review" || isProtectedPath(relative) || lost) &&
        !(await approve(`delete ${relative}${lost ? "\n(git has no copy of it as it is now)" : ""}`, "change"))
      ) {
        return { ok: false, message: "The user chose not to delete it." }
      }
      const edit = new WorkspaceEdit()
      edit.deleteFile(Uri.file(file), { ignoreIfNotExists: false })
      return (await workspace.applyEdit(edit))
        ? { ok: true, message: `Deleted ${relative}.` }
        : { ok: false, message: `The editor refused to delete ${relative}.` }
    },
    async move(from, to) {
      const [source, target] = [view.relative(from), view.relative(to)]
      if (
        (mode === "review" || isProtectedPath(source) || isProtectedPath(target)) &&
        !(await approve(`move ${source} → ${target}`, "change"))
      ) {
        return { ok: false, message: "The user chose not to move it." }
      }
      const edit = new WorkspaceEdit()
      edit.renameFile(Uri.file(from), Uri.file(to), { overwrite: false })
      return (await applyAndSave(edit))
        ? { ok: true, message: `Moved ${source} to ${target}.` }
        : { ok: false, message: `The editor refused to move ${source}.` }
    }
  }
}

/** How long to wait for a first word on a file from its language server. */
const DIAGNOSTICS_WAIT_MS = 1500
/** Once it has spoken: how long it must stay quiet to count as finished (syntax errors come first, type errors after). */
const DIAGNOSTICS_QUIET_MS = 400
const DIAGNOSTICS_MAX_MS = 4000
const MAX_SELECTION_CHARS = 4000
const MAX_PLACES = 200

const SEVERITY: Record<DiagnosticSeverity, EditorDiagnostic["severity"]> = {
  [DiagnosticSeverity.Error]: "error",
  [DiagnosticSeverity.Warning]: "warning",
  [DiagnosticSeverity.Information]: "info",
  [DiagnosticSeverity.Hint]: "info"
}

/**
 * Resolves once the language server has had its say on `uri`: a moment of
 * quiet after it reports, or a short wait when it has nothing new.
 */
const settledDiagnostics = (uri: Uri) =>
  new Promise<void>((resolve) => {
    let quiet: NodeJS.Timeout | undefined
    const finish = () => {
      clearTimeout(first)
      clearTimeout(quiet)
      clearTimeout(longest)
      listener.dispose()
      resolve()
    }
    const first = setTimeout(finish, DIAGNOSTICS_WAIT_MS)
    const longest = setTimeout(finish, DIAGNOSTICS_MAX_MS)
    const listener = languages.onDidChangeDiagnostics((event) => {
      if (!event.uris.some((changed) => changed.toString() === uri.toString())) return
      clearTimeout(first)
      clearTimeout(quiet)
      quiet = setTimeout(finish, DIAGNOSTICS_QUIET_MS)
    })
  })

const toLocations = (found: Array<Location | LocationLink> | undefined): EditorLocation[] =>
  (found ?? []).slice(0, MAX_PLACES).map((item) => {
    const [uri, range] =
      "targetUri" in item
        ? [item.targetUri, item.targetSelectionRange ?? item.targetRange]
        : [item.uri, item.range]
    return { file: uri.fsPath, line: range.start.line + 1 }
  })

const toDiagnostic = (uri: Uri, diagnostic: Diagnostic): EditorDiagnostic => ({
  file: uri.fsPath,
  line: diagnostic.range.start.line + 1,
  severity: SEVERITY[diagnostic.severity],
  message: diagnostic.message.split("\n")[0],
  source: diagnostic.source
})

/** What VS Code and its language servers know, for the chat's tools. */
export const editorKnowledge = (view: WorkspaceView, mode: ChatEditMode, approve: ApproveChange): EditorSink => ({
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
      .filter(([uri]) => uri.scheme === "file" && view.visible(uri.fsPath))
      .flatMap(([uri, found]) => found.map((d) => toDiagnostic(uri, d)))
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1))
  },
  async references(file, line, character) {
    return toLocations(
      await commands.executeCommand<Location[]>(
        "vscode.executeReferenceProvider",
        Uri.file(file),
        new Position(line, character)
      )
    )
  },
  async definition(file, line, character) {
    return toLocations(
      await commands.executeCommand<Array<Location | LocationLink>>(
        "vscode.executeDefinitionProvider",
        Uri.file(file),
        new Position(line, character)
      )
    )
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
    // A rename reaches wherever the language server follows the symbol.
    // It is held to the files the other tools may touch.
    const beyond = edit.entries().find(([uri]) => uri.scheme !== "file" || !view.visible(uri.fsPath))
    if (beyond) {
      return {
        ok: false,
        message: `Not renamed: it would change ${beyond[0].fsPath}, which is outside the workspace or ignored.`
      }
    }
    const files = edit.entries().map(([uri]) => view.relative(uri.fsPath))
    const changes = edit.entries().reduce((n, [, edits]) => n + edits.length, 0)
    if (
      (mode === "review" || files.some(isProtectedPath)) &&
      !(await approve(`rename to ${newName}: ${changes} changes in ${files.join(", ")}`, "change"))
    ) {
      return { ok: false, message: "The user chose not to rename it." }
    }
    return (await applyAndSave(edit))
      ? { ok: true, files, message: `Renamed to ${newName}: ${changes} changes in ${files.join(", ")}, saved.` }
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

/**
 * One line on where the user is in the editor, sent with their message so
 * "this function" and "here" need no tool call to resolve. Nothing when
 * the file is one the tools may not read.
 */
export const editorHint = (view: WorkspaceView): string => {
  const editor = window.activeTextEditor
  if (!editor || editor.document.uri.scheme !== "file" || !view.visible(editor.document.uri.fsPath)) return ""
  const file = view.relative(editor.document.uri.fsPath)
  const { selection } = editor
  return selection.isEmpty
    ? `The user's active editor is ${file}, cursor on line ${selection.active.line + 1}.`
    : `The user's active editor is ${file}, with lines ${selection.start.line + 1}-${selection.end.line + 1} selected.`
}

/** The terminal the chat's commands run in, apart from the one other features type into. */
export const TOOLS_TERMINAL = `${TWINNY} tools`

/** Terminals with a command of ours still running in them: one that outlived its wait. */
const busy = new WeakSet<Terminal>()
/** Terminals whose shell never reported integration; no need to wait to find that out again. */
const withoutIntegration = new WeakSet<Terminal>()

/** When a command of ours last ended in a terminal. */
const lastEnded = new WeakMap<Terminal, number>()
/**
 * A shell reports where it is with its next prompt, a moment after a
 * command ends. Sooner than this after one, what it last reported is not
 * taken as where it is now.
 */
const CWD_SETTLE_MS = 2000

/** A terminal to run in: ours, alive, and not in the middle of something; `fresh` when it was just opened at `cwd`. */
const toolsTerminal = (cwd: string): { terminal: Terminal; fresh: boolean } => {
  const existing = window.terminals.find(
    (terminal) => terminal.name === TOOLS_TERMINAL && terminal.exitStatus === undefined && !busy.has(terminal)
  )
  return existing
    ? { terminal: existing, fresh: false }
    : { terminal: window.createTerminal({ name: TOOLS_TERMINAL, cwd }), fresh: true }
}

/** The terminal's shell integration, waiting briefly for a new terminal's shell to report it. */
const integrationOf = (terminal: Terminal): Promise<TerminalShellIntegration | undefined> => {
  if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration)
  if (withoutIntegration.has(terminal)) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      listener.dispose()
      withoutIntegration.add(terminal)
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

type Ended = { exitCode?: number } | "timeout" | "stopped"

/** Runs to its end in the terminal, or until the wait or the user's patience runs out. */
const execute = (
  terminal: Terminal,
  run: () => ReturnType<TerminalShellIntegration["executeCommand"]>,
  timeoutMs: number,
  signal?: AbortSignal
) => {
  const execution = run()
  busy.add(terminal)
  let output = ""
  const reading = (async () => {
    for await (const chunk of execution.read()) {
      output = (output + chunk).slice(-MAX_CAPTURE_CHARS)
    }
  })().catch((error) => logger.warn(`Chat command output: ${error}`))

  let settle: (ended: Ended) => void = () => undefined
  const ended = new Promise<Ended>((resolve) => {
    settle = resolve
  })
  // These two listeners outlive the wait: a command left running frees
  // its terminal only when it really ends.
  const release = () => {
    finished.dispose()
    closed.dispose()
    busy.delete(terminal)
    lastEnded.set(terminal, Date.now())
  }
  const finished = window.onDidEndTerminalShellExecution((event) => {
    if (event.execution !== execution) return
    release()
    settle({ exitCode: event.exitCode })
  })
  // `exit` and friends end the shell itself, and with it any end event.
  const closed = window.onDidCloseTerminal((gone) => {
    if (gone !== terminal) return
    release()
    settle({ exitCode: gone.exitStatus?.code })
  })
  const timer = setTimeout(() => settle("timeout"), timeoutMs)
  const stop = () => {
    // The user stopped the reply: the command is interrupted as Ctrl+C would.
    terminal.sendText("\x03", false)
    settle("stopped")
  }
  if (signal?.aborted) stop()
  else signal?.addEventListener("abort", stop, { once: true })
  void ended.then(() => {
    clearTimeout(timer)
    signal?.removeEventListener("abort", stop)
  })
  return { ended, output: () => output, reading }
}

/** In the tools terminal, so the user sees it and `@terminal` has it afterwards. */
const runInTerminal = async (
  terminal: Terminal,
  integration: TerminalShellIntegration,
  command: string,
  cwd: string,
  fresh: boolean,
  signal?: AbortSignal
): Promise<CommandOutcome> => {
  // Commands are promised the workspace root, and an earlier one may have
  // left the shell elsewhere. Unless the shell is new, or has sat idle
  // and says it is at the root, it is sent there first.
  const idle = Date.now() - (lastEnded.get(terminal) ?? 0) > CWD_SETTLE_MS
  if (!fresh && !(idle && integration.cwd?.fsPath === cwd)) {
    await execute(terminal, () => integration.executeCommand("cd", [cwd]), 5000, signal).ended
  }
  const run = execute(terminal, () => integration.executeCommand(command), COMMAND_TIMEOUT_MS, signal)
  const ended = await run.ended
  // The last chunk can land just after the end event.
  await Promise.race([run.reading, new Promise((resolve) => setTimeout(resolve, 300))])
  const tail = tailOutput(stripAnsi(run.output()), OUTPUT_TAIL)
  if (ended === "timeout") return { ran: true, output: tail, timedOut: "running" }
  if (ended === "stopped") return { ran: true, output: tail, timedOut: "stopped" }
  return { ran: true, output: tail, exitCode: ended.exitCode }
}

/** Without shell integration: in the background, from the workspace root. */
const runDetached = (command: string, cwd: string, signal?: AbortSignal): Promise<CommandOutcome> =>
  new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, windowsHide: true, signal },
      (error, stdout, stderr) => {
        const output = tailOutput(`${stdout}${stderr ? `\n${stderr}` : ""}`, OUTPUT_TAIL)
        // Ended by the wait running out, or by the user stopping the reply.
        const ended = !!error && ((error as { killed?: boolean }).killed === true || error.name === "AbortError")
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
        resolve(ended ? { ran: true, output, timedOut: "stopped" } : { ran: true, output, exitCode: code })
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
  async run(command, signal) {
    if (mode === "ask") {
      if (!(await approve(command))) {
        logger.info(`Chat command skipped: ${command}`)
        return { ran: false, output: "" }
      }
    }
    if (signal?.aborted) return { ran: false, output: "" }
    logger.info(`Chat command: ${command}`)
    const { terminal, fresh } = toolsTerminal(cwd)
    terminal.show(true)
    const integration = await integrationOf(terminal)
    if (integration) return runInTerminal(terminal, integration, command, cwd, fresh, signal)
    logger.info("Chat command: no shell integration in the tools terminal, running in the background")
    return runDetached(command, cwd, signal)
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

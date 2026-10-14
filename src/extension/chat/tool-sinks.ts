/**
 * What the chat's tools reach in the editor: edits go through the inline
 * edit service, commands run in the background (or a terminal of their
 * own, as the user set), `search_code`
 * asks the embeddings index, and the language servers answer for errors,
 * references and renames. The tools themselves (`tools/workspace.ts`)
 * know none of this, so they run headless in tests and the eval.
 *
 * Edits apply straight away or wait for review, as the user set. A few
 * things wait for the user whatever the setting, because undo would not
 * bring them back or because they widen what the model may do: deleting a
 * file git has no copy of, and changing `.vscode/` or a `.gitignore`.
 */
import { ChildProcess, execFile, spawn } from "child_process"
import { existsSync } from "fs"
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
import type { Replacement } from "../tools/edit"
import { isProtectedPath } from "../tools/helpers"
import { EditorDiagnostic, EditorLocation, EditorSink, FileOpsSink } from "../tools/more"
import { WorkspaceView } from "../tools/view"
import { CodeSearch, CommandOutcome, CommandSink, EditOutcome, EditSink } from "../tools/workspace"

import { changesBetween, MAX_COMMAND_CHANGES, snapshotTree, TreeSnapshot } from "./command-snapshot"
import type { ReplyChanges } from "./reply-changes"

export type ChatCommandMode = "ask" | "allow" | "off"
/** Where the model's commands run: a process of their own, or the twinny tools terminal. */
export type ChatCommandPlace = "background" | "terminal"

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

/**
 * How git lists a tracked file: `H` as usual; lowercase when marked
 * assume-unchanged and `S` for skip-worktree, where git no longer looks
 * at the file and so cannot say whether it changed.
 */
const gitTag = (cwd: string, file: string) =>
  new Promise<string>((resolve) => {
    execFile("git", ["ls-files", "-v", "--", file], { cwd, timeout: 5000 }, (error, stdout) =>
      resolve(error ? "" : stdout.charAt(0))
    )
  })

/** Whether git could give the file back exactly as it is: tracked, unchanged since the last commit, nothing unsaved. */
const recoverableFromGit = async (file: string): Promise<boolean> => {
  if (workspace.textDocuments.some((d) => d.uri.scheme === "file" && d.uri.fsPath === file && d.isDirty)) return false
  const cwd = path.dirname(file)
  return (
    (await gitSays(cwd, ["ls-files", "--error-unmatch", "--", file])) &&
    (await gitTag(cwd, file)) === "H" &&
    (await gitSays(cwd, ["diff", "--quiet", "HEAD", "--", file]))
  )
}

/** Errors named after an edit; any more are counted. */
const MAX_NEW_ERRORS = 5
/** Languages with no checker to wait for, and the file names that are one before the file exists. */
const UNCHECKED_LANGUAGES = new Set(["plaintext", "markdown", "log", "ignore"])
const UNCHECKED_FILES = /\.(md|markdown|txt|log|csv)$|(^|[\\/])\.\w*ignore$/i

const errorsIn = (uri: Uri) =>
  languages.getDiagnostics(uri).filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error)

/** The lines a replacement leaves in their place, 0-based in the new text; none for a deletion. */
const changedLines = ({ startLine, text }: Replacement) =>
  text ? { start: startLine, end: startLine + text.split("\n").length - 1 } : { start: startLine, end: startLine - 1 }

/** A file first opened by the edit: its checker gets longer to finish, since a project may be loading. */
const FIRST_CHECK_QUIET_MS = 1200

/**
 * An applied change, followed by the errors the language server then
 * reports that the change brought: the model sees what it broke without
 * spending a step on `diagnostics`. Warnings are left out; a small model
 * chases them.
 *
 * Which errors are the change's: in a file the editor already had open,
 * and so had checked, those whose message is new (the edit moves lines,
 * not words). A file opened by the edit has no checked "before" to
 * compare with (a cold language server reports a file's old errors late,
 * and they would be put down to the edit), so only errors on the lines
 * it changed are named. `changed` is those lines in the new text,
 * 0-based; a new file is all changed.
 */
const withNewErrors = async (
  view: WorkspaceView,
  file: string,
  mode: ChatEditMode,
  changed: { start: number; end: number } | undefined,
  change: () => Promise<ChatEditOutcome>
): Promise<EditOutcome> => {
  if (mode !== "apply" || UNCHECKED_FILES.test(file)) return change()
  const uri = Uri.file(file)
  const open = workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
  if (open && UNCHECKED_LANGUAGES.has(open.languageId)) return change()
  const known = !!open && !!changed
  const before = known ? errorsIn(uri).map((diagnostic) => diagnostic.message) : []
  const checked = settledDiagnostics(uri, known ? DIAGNOSTICS_QUIET_MS : FIRST_CHECK_QUIET_MS)
  const outcome = await change()
  if (!outcome.ok || outcome.pending) return outcome
  await checked
  const fresh = errorsIn(uri).filter((diagnostic) => {
    if (!known) {
      const line = diagnostic.range.start.line
      return !changed || (line >= changed.start && line <= changed.end)
    }
    const seen = before.indexOf(diagnostic.message)
    if (seen === -1) return true
    before.splice(seen, 1)
    return false
  })
  if (!fresh.length) return outcome
  const one = fresh.length === 1
  const named = fresh
    .slice(0, MAX_NEW_ERRORS)
    .map(
      (diagnostic) =>
        `${diagnostic.range.start.line + 1}: ${diagnostic.message.split("\n")[0]}${diagnostic.source ? ` (${diagnostic.source})` : ""}`
    )
  const more = fresh.length > named.length ? `\n… and ${fresh.length - named.length} more` : ""
  const where = known
    ? `that ${one ? "was" : "were"} not there before`
    : changed
      ? "on the lines you changed"
      : "in the new file"
  return {
    ...outcome,
    newErrors: fresh.length,
    message:
      `${outcome.message}\nThe editor now reports ${one ? "an error" : `${fresh.length} errors`} in ${view.relative(file)} ${where}:\n` +
      `${named.join("\n")}${more}\nFix ${one ? "it" : "them"} if your change caused ${one ? "it" : "them"}.`
  }
}

/**
 * Edits and new files applied and saved, or shown for review, as
 * `twinny.chatToolsEdits` says; deletes and moves likewise, asked in the
 * chat when reviewing since they have no diff.
 */
export const editorEdits = (
  view: WorkspaceView,
  mode: ChatEditMode,
  approve: ApproveChange,
  /** Keeps each file as it was before the reply changed it, for undo. */
  changes?: Pick<ReplyChanges, "touch" | "hold">
): EditSink & FileOpsSink => {
  /** A protected file's change is always shown as a diff first, by its name or by where a link leads. */
  const isProtected = (file: string) => isProtectedPath(view.relative(file)) || isProtectedPath(view.realRelative(file))
  const modeFor = (file: string): ChatEditMode => (isProtected(file) ? "review" : mode)
  /** A change in progress, which the reply's record waits for. */
  const held = <T>(work: () => Promise<T>): Promise<T> => changes?.hold(work()) ?? work()
  return {
    mode,
    edit: (file, replacement) =>
      withNewErrors(view, file, modeFor(file), changedLines(replacement), () =>
        held(async () => {
          // A change waiting for review is the user's to make; one applied now is kept for undo.
          if (modeFor(file) === "apply") await changes?.touch(file)
          return (
            (await commands.executeCommand<ChatEditOutcome>(
              TWINNY_COMMAND_NAME.chatFileEdit,
              { file, ...replacement },
              modeFor(file)
            )) ?? {
              ok: false,
              message: "Not changed: the editor did not answer."
            }
          )
        })
      ),
    create: (file, content) =>
      withNewErrors(view, file, modeFor(file), undefined, () =>
        held(async () => {
          if (modeFor(file) === "apply") await changes?.touch(file)
          return (
            (await commands.executeCommand<ChatEditOutcome>(
              TWINNY_COMMAND_NAME.chatFileCreate,
              file,
              content,
              modeFor(file)
            )) ?? {
              ok: false,
              message: "Not created: the editor did not answer."
            }
          )
        })
      ),
    async remove(file) {
      const relative = view.relative(file)
      // Without asking only when nothing is lost: git has the file as it is.
      const lost = mode === "apply" && !isProtected(file) && !(await recoverableFromGit(file))
      if (
        (mode === "review" || isProtected(file) || lost) &&
        !(await approve(`delete ${relative}${lost ? "\n(git has no copy of it as it is now)" : ""}`, "change"))
      ) {
        return { ok: false, message: "The user chose not to delete it." }
      }
      return held(async () => {
        await changes?.touch(file)
        const edit = new WorkspaceEdit()
        edit.deleteFile(Uri.file(file), { ignoreIfNotExists: false })
        return (await workspace.applyEdit(edit))
          ? { ok: true, message: `Deleted ${relative}.` }
          : { ok: false, message: `The editor refused to delete ${relative}.` }
      })
    },
    async move(from, to) {
      const [source, target] = [view.relative(from), view.relative(to)]
      if (
        (mode === "review" || isProtected(from) || isProtected(to)) &&
        !(await approve(`move ${source} → ${target}`, "change"))
      ) {
        return { ok: false, message: "The user chose not to move it." }
      }
      return held(async () => {
        await changes?.touch(from)
        await changes?.touch(to)
        const edit = new WorkspaceEdit()
        edit.renameFile(Uri.file(from), Uri.file(to), { overwrite: false })
        return (await applyAndSave(edit))
          ? { ok: true, message: `Moved ${source} to ${target}.` }
          : { ok: false, message: `The editor refused to move ${source}.` }
      })
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
const settledDiagnostics = (uri: Uri, quietMs = DIAGNOSTICS_QUIET_MS) =>
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
      quiet = setTimeout(finish, quietMs)
    })
  })

const toLocations = (found: Array<Location | LocationLink> | undefined): EditorLocation[] =>
  (found ?? []).slice(0, MAX_PLACES).map((item) => {
    const [uri, range] =
      "targetUri" in item ? [item.targetUri, item.targetSelectionRange ?? item.targetRange] : [item.uri, item.range]
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
export const editorKnowledge = (
  view: WorkspaceView,
  mode: ChatEditMode,
  approve: ApproveChange,
  /** Keeps each file a rename reaches as it was, for undo. */
  replyChanges?: Pick<ReplyChanges, "touch" | "hold">
): EditorSink => ({
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
      return {
        ok: false,
        message: `The language server could not rename it: ${error instanceof Error ? error.message : error}`
      }
    }
    if (!edit || !edit.size) {
      return {
        ok: false,
        message: "The language server has no rename here; edit the uses with edit_file instead."
      }
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
    const rename = async () => {
      for (const [uri] of edit!.entries()) await replyChanges?.touch(uri.fsPath)
      return applyAndSave(edit!)
    }
    return (await (replyChanges?.hold(rename()) ?? rename()))
      ? {
          ok: true,
          files,
          message: `Renamed to ${newName}: ${changes} changes in ${files.join(", ")}, saved.`
        }
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
    : {
        terminal: window.createTerminal({ name: TOOLS_TERMINAL, cwd }),
        fresh: true
      }
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
  signal?: AbortSignal,
  onOutput?: (output: string) => void
) => {
  const execution = run()
  busy.add(terminal)
  let output = ""
  const reading = (async () => {
    for await (const chunk of execution.read()) {
      output = (output + chunk).slice(-MAX_CAPTURE_CHARS)
      onOutput?.(output)
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
  signal?: AbortSignal,
  onOutput?: (output: string) => void
): Promise<CommandOutcome> => {
  // Commands are promised the workspace root, and an earlier one may have
  // left the shell elsewhere. Unless the shell is new, or has sat idle
  // and says it is at the root, it is sent there first.
  const idle = Date.now() - (lastEnded.get(terminal) ?? 0) > CWD_SETTLE_MS
  if (!fresh && !(idle && integration.cwd?.fsPath === cwd)) {
    await execute(terminal, () => integration.executeCommand("cd", [cwd]), 5000, signal).ended
  }
  const run = execute(terminal, () => integration.executeCommand(command), COMMAND_TIMEOUT_MS, signal, onOutput)
  const ended = await run.ended
  // The last chunk can land just after the end event.
  await Promise.race([run.reading, new Promise((resolve) => setTimeout(resolve, 300))])
  const tail = tailOutput(stripAnsi(run.output()), OUTPUT_TAIL)
  if (ended === "timeout") return { ran: true, output: tail, timedOut: "running" }
  if (ended === "stopped") return { ran: true, output: tail, timedOut: "stopped" }
  return { ran: true, output: tail, exitCode: ended.exitCode }
}

/**
 * bash where there is one: the lines models write assume a POSIX shell,
 * which fish, say, is not. PATH comes from the extension host either way.
 */
const BACKGROUND_SHELL: string | boolean = process.platform !== "win32" && existsSync("/bin/bash") ? "/bin/bash" : true

/** After the shell exits, how long its output may take to finish arriving. */
const EXIT_GRACE_MS = 500
/** How long a stopped command gets to end on SIGTERM before it is killed outright. */
const KILL_AFTER_MS = 2000

/**
 * Ends a background command and whatever it started: its process group
 * on POSIX (even once the shell itself has exited, since what it left
 * running is still in the group); on Windows, where killing the shell
 * leaves its children running, `taskkill /T` down the tree.
 */
const killTree = (child: ChildProcess, group: boolean, signal: NodeJS.Signals = "SIGTERM") => {
  try {
    if (process.platform === "win32" && child.pid) {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => {
        if (error) child.kill()
      })
    } else if (group && child.pid) {
      process.kill(-child.pid, signal)
    } else {
      child.kill(signal)
    }
  } catch {
    // Nothing left in the group, or it is not ours to signal.
    if (child.exitCode === null) child.kill(signal)
  }
}

/**
 * In a process of its own, through a shell, from the workspace
 * root. Nothing can type into it, so a command that waits for input gets
 * end-of-file instead of hanging. Ending it (the wait ran out, or the
 * user stopped the reply) ends whatever it started too, and so does the
 * command finishing: a server it put in the background (`npm start &`)
 * has nobody to read it once the step is over, and would hold its port.
 */
const runInBackground = (
  command: string,
  cwd: string,
  signal?: AbortSignal,
  onOutput?: (output: string) => void,
  timeoutMs = COMMAND_TIMEOUT_MS
): Promise<CommandOutcome> =>
  new Promise((resolve) => {
    const group = process.platform !== "win32"
    const child = spawn(command, {
      cwd,
      shell: BACKGROUND_SHELL,
      detached: group,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat", NO_COLOR: "1" }
    })
    let output = ""
    let ended: "stopped" | undefined
    let settled = false
    let leftovers = false
    let exitCode: number | undefined
    const timers: ReturnType<typeof setTimeout>[] = []
    const take = (chunk: string) => {
      output = (output + chunk).slice(-MAX_CAPTURE_CHARS)
      onOutput?.(output)
    }
    // Whole characters, however the bytes fall across chunks.
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", take)
    child.stderr?.on("data", take)
    const finish = () => {
      if (settled) return
      settled = true
      timers.forEach(clearTimeout)
      signal?.removeEventListener("abort", stop)
      // Whatever the command left behind ends with it.
      if (leftovers || ended) killTree(child, group, "SIGKILL")
      const note = leftovers && !ended ? "\n(it left processes running in the background; they were ended with it)" : ""
      const tail = tailOutput(stripAnsi(output), OUTPUT_TAIL) + note
      resolve(ended ? { ran: true, output: tail, timedOut: ended } : { ran: true, output: tail, exitCode })
    }
    function stop() {
      if (ended || settled) return
      ended = "stopped"
      killTree(child, group)
      // A command that ignores SIGTERM is killed; one whose pipes stay
      // open after that is not waited on.
      timers.push(setTimeout(() => killTree(child, group, "SIGKILL"), KILL_AFTER_MS))
      timers.push(setTimeout(finish, KILL_AFTER_MS + EXIT_GRACE_MS))
    }
    timers.push(setTimeout(stop, timeoutMs))
    if (signal?.aborted) stop()
    else signal?.addEventListener("abort", stop, { once: true })
    child.on("error", (error) => {
      output += `\n${error.message}`
      exitCode = 127
      finish()
    })
    child.on("exit", (code) => {
      exitCode = code ?? undefined
      // The shell is done; its output follows within a moment unless
      // something it started still holds the pipes.
      timers.push(
        setTimeout(() => {
          leftovers = true
          finish()
        }, EXIT_GRACE_MS)
      )
    })
    child.on("close", () => finish())
  })

/** Asks in a notification, for hosts without a chat to ask in. */
const askInNotification = async (command: string) =>
  (await window.showInformationMessage(`Twinny wants to run: ${command}`, "Run", "Skip")) === "Run"

/**
 * Commands the model asks for: put to the user first while `mode` says
 * `ask` (in the chat's tool steps when `approve` is given), then run in
 * the background or in the tools terminal. `mode` is asked for each
 * command, so switching auto-run on mid-reply holds for the rest of it.
 * `onOutput` hears what the command prints as it prints it.
 */
export const terminalCommands = (
  mode: (command: string) => "ask" | "allow",
  cwd: string,
  approve: (command: string) => Promise<boolean> = askInNotification,
  options: {
    place?: ChatCommandPlace
    onOutput?: (output: string) => void
    /** Hears, as a command starts, how to stop just that command. */
    onStart?: (stop: () => void) => void
    /** How long a background command may run; two minutes unless a test says less. */
    timeoutMs?: number
    /** Ends when the chat does (a closed panel, a reload): its commands end with it. */
    lifetime?: AbortSignal
    /**
     * Files a command changes are kept for undo with the edits' (inside a
     * git repository); `visible` says which the agent may show.
     */
    changes?: Pick<ReplyChanges, "touchWith" | "hold">
    visible?: (file: string) => boolean
  } = {}
): CommandSink => ({
  get mode() {
    return mode("")
  },
  async run(command, signal) {
    if (mode(command) === "ask") {
      if (!(await approve(command))) {
        logger.info(`Chat command skipped: ${command}`)
        return { ran: false, output: "" }
      }
    }
    if (signal?.aborted) return { ran: false, output: "" }
    logger.info(`Chat command: ${command}`)
    // Output is passed on while this step lasts: a command left running in
    // the terminal after the wait keeps printing, and that is not the next
    // step's output.
    let current = true
    const onOutput = options.onOutput && ((output: string) => current && options.onOutput!(stripAnsi(output)))
    // Its own stop, which the reply's stop also pulls.
    const own = new AbortController()
    const follow = () => own.abort()
    signal?.addEventListener("abort", follow, { once: true })
    options.lifetime?.addEventListener("abort", follow, { once: true })
    if (options.lifetime?.aborted) follow()
    let stoppedByUser = false
    options.onStart?.(() => {
      stoppedByUser = true
      own.abort()
    })
    // The tree before it runs, so what it changed can be undone with the reply.
    const before = options.changes ? await snapshotTree(cwd) : undefined
    try {
      const outcome = await (async () => {
        if (options.place !== "terminal") return runInBackground(command, cwd, own.signal, onOutput, options.timeoutMs)
        const { terminal, fresh } = toolsTerminal(cwd)
        terminal.show(true)
        const integration = await integrationOf(terminal)
        if (integration) return runInTerminal(terminal, integration, command, cwd, fresh, own.signal, onOutput)
        logger.info("Chat command: no shell integration in the tools terminal, running in the background")
        return runInBackground(command, cwd, own.signal, onOutput, options.timeoutMs)
      })()
      return stoppedByUser && outcome.timedOut === "stopped" ? { ...outcome, stoppedByUser: true } : outcome
    } finally {
      current = false
      signal?.removeEventListener("abort", follow)
      options.lifetime?.removeEventListener("abort", follow)
      if (before && options.changes) {
        await options.changes.hold(keepCommandChanges(before, cwd, command, options.changes, options.visible))
      }
    }
  }
})

/** What a command changed, kept with the reply's other changes; files the agent may not show are left out. */
const keepCommandChanges = async (
  before: TreeSnapshot,
  cwd: string,
  command: string,
  changes: Pick<ReplyChanges, "touchWith">,
  visible: (file: string) => boolean = () => true
) => {
  const started = Date.now()
  const after = await snapshotTree(cwd)
  if (!after) return
  const changed = await changesBetween(before, after)
  const took = Date.now() - started
  if (!changed) {
    logger.warn(`Chat command changed more than ${MAX_COMMAND_CHANGES} files; they are not listed for undo: ${command}`)
    return
  }
  const shown = changed.filter((change) => visible(change.file))
  for (const change of shown) changes.touchWith(change.file, change.before)
  logger.info(
    `Chat command changed ${shown.length} file${shown.length === 1 ? "" : "s"} (read from git in ${took} ms): ${command}`
  )
}

/** A command as Always run keeps it: trimmed, its spaces collapsed. */
export const normalCommand = (command: string) => command.trim().replace(/\s+/g, " ")

/** `search_code` over the embeddings index, with the chat's own threshold. */
export const indexSearch = (search: WorkspaceSearch, threshold: () => number | undefined): CodeSearch => ({
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

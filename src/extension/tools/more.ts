/**
 * The tools beyond reading and editing: finding files by name, read-only
 * git, and what the editor knows (errors, references, definitions,
 * renames, what the user has open), plus deleting and moving files.
 *
 * Git and file finding are plain Node. The editor's knowledge comes
 * through an `EditorSink` the extension provides, so these tools are
 * offered only where there is an editor to ask.
 */
import { execFile } from "child_process"

import { globToRegExp,locateSymbol, readOnlyGitArgs } from "./helpers"
import { clip, plural, ToolInputError, WorkspaceView } from "./view"
import type { EditOutcome, Tool } from "./workspace"

const MAX_FOUND_FILES = 200
const MAX_GIT_OUTPUT = 12_000
const GIT_TIMEOUT_MS = 20_000
const MAX_LOCATIONS = 50

/** A place in a file, as the editor reports it. `line` is 1-based. */
export interface EditorLocation {
  file: string
  line: number
  /** The line's text, for the model to see without reading the file. */
  text?: string
}

export interface EditorDiagnostic extends EditorLocation {
  severity: "error" | "warning" | "info"
  message: string
  source?: string
}

export interface EditorContextView {
  activeFile?: string
  /** 1-based. */
  cursorLine?: number
  selection?: { startLine: number; endLine: number; text: string }
  openFiles: string[]
}

/**
 * What the extension answers from VS Code and its language servers.
 * Positions are 0-based here, as the editor takes them.
 */
export interface EditorSink {
  diagnostics(file?: string): Promise<EditorDiagnostic[]>
  references(file: string, line: number, character: number): Promise<EditorLocation[]>
  definition(file: string, line: number, character: number): Promise<EditorLocation[]>
  /** Rename everywhere the language server knows of; applied or put to the user as the edit mode says. */
  rename(file: string, line: number, character: number, newName: string): Promise<EditOutcome & { files?: string[] }>
  context(): Promise<EditorContextView>
}

/** Deleting and moving files, applied or put to the user as the edit mode says. */
export interface FileOpsSink {
  remove(file: string): Promise<EditOutcome>
  move(from: string, to: string): Promise<EditOutcome>
}

export const findFiles = (view: WorkspaceView): Tool => ({
  name: "find_files",
  description: "Files whose path matches a glob, e.g. **/*.test.ts or src/**/index.*; a pattern without / matches the file name anywhere.",
  parameters: [{ name: "pattern", description: "A glob." }],
  async run({ pattern }) {
    const glob = pattern?.trim()
    if (!glob) throw new ToolInputError("find_files needs a pattern.")
    const regex = globToRegExp(glob)
    const matches = (await view.allFiles()).map((file) => view.relative(file)).filter((rel) => regex.test(rel))
    const shown = matches.slice(0, MAX_FOUND_FILES)
    return {
      output: shown.length
        ? shown.join("\n") + (matches.length > shown.length ? `\n… ${matches.length - shown.length} more; narrow the pattern` : "")
        : "No files match.",
      summary: `found files \`${glob}\` · ${plural(matches.length, "file")}`
    }
  }
})

const runGit = (root: string, args: string[]) =>
  new Promise<{ output: string; exitCode: number }>((resolve) => {
    execFile(
      "git",
      ["--no-pager", ...args],
      { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr ? `${stdout ? "\n" : ""}${stderr}` : ""}`
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
        resolve({ output, exitCode: code })
      }
    )
  })

export const git = (view: WorkspaceView): Tool => ({
  name: "git",
  description:
    "Run a read-only git command in the workspace: status, diff, log, show, blame, branch (listing), shortlog, ls-files, rev-parse. No approval needed; nothing is changed.",
  guidance: "Use git to see what changed (git diff, git status) or the history of a file (git log -p -- path) before you edit.",
  parameters: [{ name: "args", description: "The git command without `git`, e.g. `diff --stat` or `log -5 --oneline -- src/a.ts`." }],
  async run({ args }) {
    const line = args?.trim()
    if (!line) throw new ToolInputError("git needs arguments, e.g. status.")
    const parsed = readOnlyGitArgs(line)
    if (typeof parsed === "string") throw new ToolInputError(parsed)
    const { output, exitCode } = await runGit(view.root, parsed)
    const shown =
      output.length > MAX_GIT_OUTPUT
        ? `${output.slice(0, MAX_GIT_OUTPUT)}\n… ${output.length - MAX_GIT_OUTPUT} more characters; narrow it with a path or --stat`
        : output
    const command = line.replace(/^\s*git\s+/, "")
    return {
      output: `$ git ${command}\n(exit code ${exitCode})\n${shown.trim() || "(no output)"}`,
      summary: `git \`${command}\`${exitCode ? ` · exit ${exitCode}` : ""}`,
      failed: exitCode !== 0
    }
  }
})

const locatedLines = (view: WorkspaceView, locations: EditorLocation[]) =>
  locations
    .slice(0, MAX_LOCATIONS)
    .map((l) => `${view.relative(l.file)}:${l.line}: ${clip((l.text ?? "").trim())}`)
    .join("\n") + (locations.length > MAX_LOCATIONS ? `\n… ${locations.length - MAX_LOCATIONS} more` : "")

/** The position of `symbol` in `file`, for asking the language server. */
const symbolAt = async (view: WorkspaceView, file: string | undefined, symbol: string | undefined, line?: string) => {
  if (!file) throw new ToolInputError("A path is needed.")
  const wanted = symbol?.trim()
  if (!wanted) throw new ToolInputError("A symbol name is needed.")
  const absolute = view.resolve(file, "file")
  const text = await view.text(absolute)
  if (text === undefined) throw new ToolInputError(`${view.relative(absolute)} is binary or too large.`)
  const at = locateSymbol(text, wanted, line ? Number.parseInt(line, 10) || undefined : undefined)
  if (!at) throw new ToolInputError(`${wanted} does not appear in ${view.relative(absolute)}.`)
  return { absolute, rel: view.relative(absolute), wanted, ...at }
}

const SYMBOL_PARAMETERS = [
  { name: "path", description: "A file where the symbol appears." },
  { name: "symbol", description: "The symbol's name." },
  { name: "line", description: "The line it is on, when the name appears more than once.", optional: true, type: "integer" as const }
]

export const diagnostics = (view: WorkspaceView, editor: EditorSink): Tool => ({
  name: "diagnostics",
  description: "The errors and warnings the editor's language servers report, for one file or the whole workspace.",
  guidance: "After editing, call diagnostics on the files you changed to catch errors before you finish.",
  parameters: [{ name: "path", description: "A file; the whole workspace when left out.", optional: true }],
  async run({ path: file }) {
    const absolute = file ? view.resolve(file, "file") : undefined
    const found = (await editor.diagnostics(absolute)).filter((d) => d.severity !== "info")
    const errors = found.filter((d) => d.severity === "error").length
    const where = absolute ? `\`${view.relative(absolute)}\`` : "the workspace"
    return {
      output: found.length
        ? found
            .slice(0, MAX_LOCATIONS)
            .map((d) => `${view.relative(d.file)}:${d.line}: ${d.severity}: ${d.message}${d.source ? ` (${d.source})` : ""}`)
            .join("\n") + (found.length > MAX_LOCATIONS ? `\n… ${found.length - MAX_LOCATIONS} more` : "")
        : `No errors or warnings in ${absolute ? view.relative(absolute) : "the workspace"}.`,
      summary: `checked ${where} · ${found.length ? `${plural(errors, "error")}, ${plural(found.length - errors, "warning")}` : "clean"}`
    }
  }
})

export const findReferences = (view: WorkspaceView, editor: EditorSink): Tool => ({
  name: "find_references",
  description: "Every place a function, class, variable or type is used, from the language server; exact, unlike grep.",
  parameters: SYMBOL_PARAMETERS,
  async run({ path: file, symbol, line }) {
    const at = await symbolAt(view, file, symbol, line)
    const found = await editor.references(at.absolute, at.line, at.character)
    return {
      output: found.length ? locatedLines(view, found) : `The language server found no references to ${at.wanted}.`,
      summary: `references to \`${at.wanted}\` · ${plural(found.length, "place")}`
    }
  }
})

export const goToDefinition = (view: WorkspaceView, editor: EditorSink): Tool => ({
  name: "go_to_definition",
  description: "Where the symbol used at a place is defined, from the language server; follows imports.",
  parameters: SYMBOL_PARAMETERS,
  async run({ path: file, symbol, line }) {
    const at = await symbolAt(view, file, symbol, line)
    const found = await editor.definition(at.absolute, at.line, at.character)
    return {
      output: found.length ? locatedLines(view, found) : `The language server does not know where ${at.wanted} is defined.`,
      summary: `definition of \`${at.wanted}\` · ${found.length ? view.relative(found[0].file) : "not found"}`
    }
  }
})

export const renameSymbol = (view: WorkspaceView, editor: EditorSink): Tool => ({
  name: "rename_symbol",
  description: "Rename a function, class, variable or type everywhere it is used, through the language server. Better than editing each use.",
  parameters: [...SYMBOL_PARAMETERS.slice(0, 2), { name: "new_name", description: "The new name." }, SYMBOL_PARAMETERS[2]],
  async run({ path: file, symbol, new_name, line }) {
    const newName = new_name?.trim()
    if (!newName) throw new ToolInputError("rename_symbol needs new_name.")
    const at = await symbolAt(view, file, symbol, line)
    const outcome = await editor.rename(at.absolute, at.line, at.character, newName)
    view.forgetFiles()
    if (!outcome.ok) {
      return { output: outcome.message, summary: `\`${at.wanted}\` not renamed · ${outcome.message}`, failed: true }
    }
    const files = outcome.files?.length ?? 0
    return {
      output: outcome.message,
      summary: `renamed \`${at.wanted}\` → \`${newName}\`${files ? ` · ${plural(files, "file")}` : ""}`,
      final: outcome.pending
    }
  }
})

export const editorContext = (view: WorkspaceView, editor: EditorSink): Tool => ({
  name: "editor_context",
  description: "What the user is looking at: the active file, the cursor line, the selected text and the other open files.",
  guidance: "When the user says \"this\", \"here\" or \"the selection\", call editor_context first.",
  parameters: [],
  async run() {
    const context = await editor.context()
    const inside = (file: string) => {
      const rel = view.relative(file)
      return rel.startsWith("..") ? undefined : rel
    }
    const active = context.activeFile && inside(context.activeFile)
    const open = context.openFiles.map(inside).filter((f): f is string => !!f && f !== active)
    const lines = [
      active ? `Active file: ${active}${context.cursorLine ? `, cursor on line ${context.cursorLine}` : ""}` : "No file is active.",
      ...(context.selection && active
        ? [`Selected, lines ${context.selection.startLine}-${context.selection.endLine}:`, context.selection.text]
        : []),
      ...(open.length ? [`Also open: ${open.join(", ")}`] : [])
    ]
    return {
      output: lines.join("\n"),
      summary: `looked at the editor · ${active ? `\`${active}\`` : "nothing open"}${context.selection && active ? " with a selection" : ""}`
    }
  }
})

export const deleteFile = (view: WorkspaceView, ops: FileOpsSink): Tool => ({
  name: "delete_file",
  description: "Delete a file in the workspace. The editor can undo it.",
  parameters: [{ name: "path", description: "The file to delete." }],
  async run({ path: file }) {
    if (!file) throw new ToolInputError("delete_file needs a path.")
    const absolute = view.resolve(file, "file")
    const rel = view.relative(absolute)
    const outcome = await ops.remove(absolute)
    view.forgetFiles()
    return outcome.ok
      ? { output: outcome.message, summary: `deleted \`${rel}\`` }
      : { output: outcome.message, summary: `\`${rel}\` not deleted · ${outcome.message}`, failed: true }
  }
})

export const moveFile = (view: WorkspaceView, ops: FileOpsSink): Tool => ({
  name: "move_file",
  description: "Move or rename a file; missing folders are made. In TypeScript and JavaScript projects the editor updates imports of it.",
  parameters: [
    { name: "from", description: "The file now." },
    { name: "to", description: "Where it goes; must not exist yet." }
  ],
  async run({ from, to }) {
    if (!from || !to) throw new ToolInputError("move_file needs from and to.")
    const source = view.resolve(from, "file")
    const target = view.resolveNew(to)
    const outcome = await ops.move(source, target)
    view.forgetFiles()
    const summary = `\`${view.relative(source)}\` → \`${view.relative(target)}\``
    return outcome.ok
      ? { output: outcome.message, summary: `moved ${summary}` }
      : { output: outcome.message, summary: `not moved ${summary} · ${outcome.message}`, failed: true }
  }
})

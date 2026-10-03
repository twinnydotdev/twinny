/**
 * The tools beyond reading and editing: finding files by name, read-only
 * git, and what the editor knows (errors, references, definitions,
 * renames, what the user has open), plus deleting and moving files.
 *
 * Git and file finding are plain Node. The editor's knowledge comes
 * through an `EditorSink` the extension provides, so these tools are
 * offered only where there is an editor to ask. What the editor reports
 * is held to the same rules as everything else: a place outside the
 * workspace, or in a file `.gitignore` ignores, is named but never read.
 */
import { execFile } from "child_process"
import fs from "fs"
import path from "path"

import { gitNamedPaths, globToRegExp, locateSymbol, readOnlyGitArgs, withoutHiddenDiffs } from "./helpers"
import { clip, linesOf, plural, ToolInputError, WorkspaceView } from "./view"
import type { EditOutcome, Tool } from "./workspace"

const MAX_FOUND_FILES = 100
const MAX_GIT_OUTPUT = 10_000
const GIT_TIMEOUT_MS = 20_000
const MAX_LOCATIONS = 50

/** A place in a file, as the editor reports it. `line` is 1-based. */
export interface EditorLocation {
  file: string
  line: number
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

// The words in a glob, for looking around when it matches nothing:
// "src/**" + "/*adapter*.ts" gives "adapter".
const globWords = (glob: string) =>
  [...new Set(glob.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [])].filter(
    (word) => !["src", "test", "tests", "index"].includes(word)
  )

export const findFiles = (view: WorkspaceView): Tool => ({
  name: "find_files",
  description:
    "Files and folders whose path matches a glob, e.g. **/*.test.ts or src/**/index.*; a pattern without / matches the name anywhere. Folders end in /.",
  parameters: [{ name: "pattern", description: "A glob." }],
  async run({ pattern }) {
    const glob = pattern?.trim().replace(/\/+$/, "")
    if (!glob) throw new ToolInputError("find_files needs a pattern.")
    const regex = globToRegExp(glob)
    const files = (await view.allFiles()).map((file) => view.relative(file)).filter((rel) => regex.test(rel))
    const dirs = (await view.allDirs()).map((dir) => view.relative(dir))
    const matches = [...dirs.filter((rel) => regex.test(rel)).map((rel) => `${rel}/`), ...files].sort()
    const shown = matches.slice(0, MAX_FOUND_FILES)
    if (!shown.length) {
      // A dead end costs a step; a folder with the same word in its name is usually where to look.
      const words = globWords(glob)
      const near = dirs
        .filter((rel) => words.some((word) => (rel.split("/").pop() ?? "").toLowerCase().includes(word)))
        .slice(0, 5)
      return {
        output: near.length ? `No files match. Folders with a similar name: ${near.map((rel) => `${rel}/`).join(", ")}` : "No files match.",
        summary: `found files \`${glob}\` · none`
      }
    }
    return {
      output: shown.join("\n") + (matches.length > shown.length ? `\n… ${matches.length - shown.length} more; narrow the pattern` : ""),
      summary: `found files \`${glob}\` · ${plural(files.length, "file")}${matches.length > files.length ? `, ${plural(matches.length - files.length, "folder")}` : ""}`
    }
  }
})

/** Whether `root` is in a git working tree: a `.git` in it or in a folder above. */
export const insideGitRepository = (root: string): boolean => {
  for (let dir = root; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return true
    if (path.dirname(dir) === dir) return false
  }
}

/**
 * Settings a user's git configuration could turn another way, pinned so
 * the output is the same on every machine: no colour codes, and diff
 * headers that name each file as `a/path b/path`.
 */
const GIT_PINNED = [
  "--no-pager",
  "-c", "color.ui=false",
  "-c", "diff.noprefix=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "core.quotepath=false"
]

const runGit = (root: string, args: string[], signal?: AbortSignal) =>
  new Promise<{ output: string; exitCode: number }>((resolve) => {
    const child = execFile(
      "git",
      [...GIT_PINNED, ...args],
      {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        signal
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr ? `${stdout ? "\n" : ""}${stderr}` : ""}`
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
        resolve({ output, exitCode: code })
      }
    )
    // Nothing is ever typed at it; a command that would wait for input gets none.
    child.stdin?.end()
  })

/** `text` up to `max` characters, ending on a whole line where one is near. */
const cutToLine = (text: string, max: number) => {
  if (text.length <= max) return text
  const newline = text.lastIndexOf("\n", max)
  return text.slice(0, newline > max / 2 ? newline : max)
}

export const git = (view: WorkspaceView): Tool => {
  /** The workspace root's path inside its repository, e.g. `packages/app/`; empty at the top. */
  let prefix: Promise<string> | undefined
  const repoPrefix = () =>
    (prefix ??= runGit(view.root, ["rev-parse", "--show-prefix"]).then(({ output, exitCode }) =>
      exitCode === 0 ? output.trim() : ""
    ))
  /**
   * Whether a path as the repository names it is one the tools may not
   * show: ignored, or in a part of the repository outside the workspace
   * folder (a sibling package, when one package is what is open).
   */
  const hiddenIn = (inRepo: string, at: string) =>
    inRepo.startsWith(at) ? view.ignored(inRepo.slice(at.length)) : at !== ""
  /**
   * The same for a path given from the workspace root, where git runs.
   * Pathspec magic (`:/`, `:(top)`) addresses the repository's top, so it
   * is refused with the rest.
   */
  const hiddenHere = (relative: string) =>
    relative.startsWith(":") || /^\.\.(\/|$)/.test(path.posix.normalize(relative.replace(/\\/g, "/"))) || path.isAbsolute(relative) || view.ignored(relative)

  return {
    name: "git",
    description:
      "Run a read-only git command in the workspace: status, diff, log, show, blame, branch (listing), shortlog, ls-files, rev-parse. No approval needed; nothing is changed.",
    guidance: "Use git to see what changed (git diff, git status) or the history of a file (git log -p -- path) before you edit.",
    parameters: [{ name: "args", description: "The git command without `git`, e.g. `diff --stat` or `log -5 --oneline -- src/a.ts`." }],
    async run({ args }, context) {
      const line = args?.trim()
      if (!line) throw new ToolInputError("git needs arguments, e.g. status.")
      const parsed = readOnlyGitArgs(line)
      if (typeof parsed === "string") throw new ToolInputError(`${parsed}.`)
      const at = await repoPrefix()
      // What .gitignore keeps from read_file, git does not hand over either.
      const named = gitNamedPaths(parsed).find((p) => (p.inRepo ? hiddenIn(p.path, at) : hiddenHere(p.path)))
      if (named) throw new ToolInputError(`${named.path} is outside the workspace or ignored by .gitignore and cannot be read.`)
      const { output, exitCode } = await runGit(view.root, parsed, context?.signal)
      const { text, dropped } = withoutHiddenDiffs(output, (file) => hiddenIn(file, at))
      const shown =
        text.length > MAX_GIT_OUTPUT
          ? `${cutToLine(text, MAX_GIT_OUTPUT)}\n… ${text.length - MAX_GIT_OUTPUT} more characters; narrow it with a path, -n or --stat`
          : text
      const command = line.replace(/^\s*git\s+/, "")
      return {
        output: `$ git ${command}\n(exit code ${exitCode})\n${shown.trim() || "(no output)"}`,
        summary:
          `git \`${command}\`` +
          (exitCode ? ` · exit ${exitCode}` : "") +
          (dropped ? ` · ${plural(dropped, "file")} left out` : ""),
        failed: exitCode !== 0
      }
    }
  }
}

/** The lines of each file a result points into, read once per call. */
const lineReader = (view: WorkspaceView) => {
  const files = new Map<string, Promise<string[]>>()
  return async (file: string, line: number): Promise<string> => {
    let lines = files.get(file)
    if (!lines) {
      lines = view.text(file).then((text) => (text === undefined ? [] : linesOf(text)))
      files.set(file, lines)
    }
    return ((await lines)[line - 1] ?? "").trim()
  }
}

/**
 * Places as `path:line: text`, the workspace's own first. A place outside
 * the workspace or in an ignored file is named, not read.
 */
const locatedLines = async (view: WorkspaceView, locations: EditorLocation[]) => {
  const read = lineReader(view)
  const seen = new Set<string>()
  const unique = locations.filter((l) => {
    const key = `${l.file}:${l.line}`
    return seen.has(key) ? false : (seen.add(key), true)
  })
  const inside = unique.filter((l) => view.visible(l.file))
  const outside = unique.filter((l) => !view.visible(l.file))
  const lines = await Promise.all(
    inside.slice(0, MAX_LOCATIONS).map(async (l) => `${view.relative(l.file)}:${l.line}: ${clip(await read(l.file, l.line))}`)
  )
  if (inside.length > MAX_LOCATIONS) lines.push(`… ${inside.length - MAX_LOCATIONS} more`)
  return { lines, inside, outside }
}

/** A place the tools may not read, named so the model knows why it stops there. */
const outsidePlace = (view: WorkspaceView, location: EditorLocation) => {
  const relative = view.relative(location.file)
  const shown = relative.startsWith("..") || path.isAbsolute(relative) ? location.file : relative
  return `${shown}:${location.line}: (outside the workspace or ignored; it cannot be read)`
}

/** The position of `symbol` in `file`, for asking the language server. */
const symbolAt = async (view: WorkspaceView, file: string | undefined, symbol: string | undefined, line?: string) => {
  if (!file) throw new ToolInputError("A path is needed.")
  const wanted = symbol?.trim()
  if (!wanted) throw new ToolInputError("A symbol name is needed.")
  const absolute = view.resolve(file, "file")
  const text = await view.text(absolute)
  if (text === undefined) throw new ToolInputError(`${view.relative(absolute)} is binary or too large.`)
  const at = locateSymbol(text.replace(/\r\n/g, "\n"), wanted, line ? Number.parseInt(line, 10) || undefined : undefined)
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
  description:
    "The errors and warnings the editor's language servers report for a file. Without a path: for every file the editor has checked, which is usually the open ones.",
  guidance: "After editing, call diagnostics on the files you changed to catch errors before you finish.",
  parameters: [{ name: "path", description: "A file; everything the editor has checked when left out.", optional: true }],
  async run({ path: file }) {
    const absolute = file ? view.resolve(file, "file") : undefined
    const found = (await editor.diagnostics(absolute)).filter(
      (d) => d.severity !== "info" && view.visible(d.file)
    )
    const errors = found.filter((d) => d.severity === "error").length
    const where = absolute ? `\`${view.relative(absolute)}\`` : "the workspace"
    return {
      output: found.length
        ? found
            .slice(0, MAX_LOCATIONS)
            .map((d) => `${view.relative(d.file)}:${d.line}: ${d.severity}: ${clip(d.message)}${d.source ? ` (${d.source})` : ""}`)
            .join("\n") + (found.length > MAX_LOCATIONS ? `\n… ${found.length - MAX_LOCATIONS} more` : "")
        : `No errors or warnings in ${absolute ? view.relative(absolute) : "the files the editor has checked"}.`,
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
    const { lines, inside, outside } = await locatedLines(view, await editor.references(at.absolute, at.line, at.character))
    if (outside.length) lines.push(`… and ${plural(outside.length, "place")} outside the workspace or in ignored files`)
    return {
      output: lines.length ? lines.join("\n") : `The language server found no references to ${at.wanted}.`,
      summary: `references to \`${at.wanted}\` · ${plural(inside.length, "place")}`
    }
  }
})

export const goToDefinition = (view: WorkspaceView, editor: EditorSink): Tool => ({
  name: "go_to_definition",
  description: "Where the symbol used at a place is defined, from the language server; follows imports.",
  parameters: SYMBOL_PARAMETERS,
  async run({ path: file, symbol, line }) {
    const at = await symbolAt(view, file, symbol, line)
    const { lines, inside, outside } = await locatedLines(view, await editor.definition(at.absolute, at.line, at.character))
    // A library's definition is worth knowing about even though it cannot be opened.
    if (!inside.length) lines.push(...outside.slice(0, 3).map((l) => outsidePlace(view, l)))
    return {
      output: lines.length ? lines.join("\n") : `The language server does not know where ${at.wanted} is defined.`,
      summary:
        `definition of \`${at.wanted}\` · ` +
        (inside.length ? view.relative(inside[0].file) : outside.length ? "outside the workspace" : "not found")
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
  description: "What the user is looking at now: the active file, the cursor line, the selected text and the other open files.",
  parameters: [],
  async run() {
    const context = await editor.context()
    const active = context.activeFile && view.visible(context.activeFile) ? view.relative(context.activeFile) : undefined
    const open = context.openFiles.filter((f) => view.visible(f)).map((f) => view.relative(f)).filter((f) => f !== active)
    const lines = [
      active
        ? `Active file: ${active}${context.cursorLine ? `, cursor on line ${context.cursorLine}` : ""}`
        : context.activeFile
          ? "The active file is outside the workspace or ignored by .gitignore; it cannot be read."
          : "No file is active.",
      ...(context.selection && active
        ? [`Selected, lines ${context.selection.startLine}-${context.selection.endLine}:`, context.selection.text]
        : []),
      ...(open.length ? [`Also open: ${open.join(", ")}`] : [])
    ]
    return {
      output: lines.join("\n"),
      summary: `looked at the editor · ${active ? `\`${active}\`` : "nothing readable open"}${context.selection && active ? " with a selection" : ""}`
    }
  }
})

export const deleteFile = (view: WorkspaceView, ops: FileOpsSink): Tool => ({
  name: "delete_file",
  description: "Delete a file in the workspace.",
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
  description:
    "Move or rename a file; missing folders are made. Imports of it elsewhere are not rewritten for you: find them with find_references or grep and fix them.",
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

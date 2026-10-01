/**
 * Read-only tools over one workspace folder, for a chat model to look
 * around before it answers. Plain Node, no VS Code, so the same tools run
 * in the extension and in a headless eval.
 *
 * Everything stays inside the root: paths are resolved and their real
 * location checked, so `..` and symlinks cannot leave it, and whatever
 * `.gitignore` ignores (where `.env` files and build output live) cannot be
 * listed, searched or read. Every result is capped, and says so, because a
 * small model's context fills after a couple of whole files.
 */
import { planReplacement, Replacement } from "./edit"
import {
  deleteFile,
  diagnostics,
  editorContext,
  EditorSink,
  FileOpsSink,
  findFiles,
  findReferences,
  git,
  goToDefinition,
  moveFile,
  renameSymbol
} from "./more"
import { ToolCall, ToolSpec } from "./protocol"
import { clip, plural, ToolInputError, WorkspaceView } from "./view"

export interface ToolResult {
  /** What the model is sent. */
  output: string
  /** One line for the user: what was looked at and what came of it. */
  summary: string
  /** The tool refused or went wrong; the output says why. */
  failed?: boolean
  /**
   * The model should answer now without another tool: an edit is waiting
   * for review, and the open file shows both sides of it until then.
   */
  final?: boolean
}

export interface Tool extends ToolSpec {
  run(args: Record<string, string>): Promise<ToolResult>
}

const MAX_READ_LINES = 150
const MAX_GREP_MATCHES = 40
const MAX_LIST_ENTRIES = 150
const MAX_SYMBOL_MATCHES = 15

/**
 * Where edits go: the editor in the extension, a scratch copy in the eval.
 * `apply` edits land at once and the model can carry on; `review` edits
 * wait as a diff for the user, and the model stops there. `read` gives a
 * file as the editor has it, unsaved changes included, when it is open.
 */
export interface EditSink {
  mode: "apply" | "review"
  read?(file: string): Promise<string | undefined>
  /** Make or show the change; resolves to what the model is told. */
  edit(file: string, replacement: Replacement): Promise<EditOutcome>
  /** Make or show a new file; resolves to what the model is told. */
  create(file: string, content: string): Promise<EditOutcome>
}

export interface EditOutcome {
  ok: boolean
  message: string
  /** Waiting for the user's review rather than made. */
  pending?: boolean
}

/** The text itself as a pattern; lowercase means any case. */
const literalPattern = (pattern: string) =>
  new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), pattern === pattern.toLowerCase() ? "i" : "")

/** A pattern as a regex; one that does not compile is searched for literally. Lowercase means any case. */
const searchPattern = (pattern: string) => {
  try {
    return new RegExp(pattern, pattern === pattern.toLowerCase() ? "i" : "")
  } catch {
    return literalPattern(pattern)
  }
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Lines that declare `name` in the languages people mostly write. */
const definitionPattern = (name: string) => {
  const n = escapeRegex(name)
  return new RegExp(
    [
      `\\b(?:function\\*?|class|interface|type|enum|struct|trait|impl|def|fn|func|module|namespace|record|object)\\s+${n}\\b`,
      `\\b(?:const|let|var|val)\\s+${n}\\s*[=:]`,
      `^\\s*(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\\s+)+\\*?${n}\\s*[(<=:]`,
      `^\\s*${n}\\s*\\([^)]*\\)\\s*(?::[^=]*)?\\{\\s*$`,
      `\\btype\\s+${n}\\s+(?:struct|interface)\\b`
    ].join("|")
  )
}

const listDir = (view: WorkspaceView): Tool => ({
  name: "list_dir",
  description: "The files and folders in a directory.",
  parameters: [{ name: "path", description: "The directory; the workspace root by default.", optional: true }],
  async run({ path: dir }) {
    const absolute = view.resolve(dir, "dir")
    const entries = view.entries(absolute)
    const shown = entries.slice(0, MAX_LIST_ENTRIES)
    const more = entries.length - shown.length
    const where = view.relative(absolute)
    return {
      output:
        shown.map((e) => (e.dir ? `${e.name}/` : e.name)).join("\n") +
        (more > 0 ? `\n… ${more} more` : "") || "(empty)",
      summary: `listed ${where === "." ? "the workspace root" : `\`${where}\``} · ${plural(entries.length, "entry", "entries")}`
    }
  }
})

const readFile = (view: WorkspaceView): Tool => ({
  name: "read_file",
  description: `A file's lines, numbered; at most ${MAX_READ_LINES} at a time, so ask for a range in long files.`,
  parameters: [
    { name: "path", description: "The file." },
    { name: "start_line", description: "First line to read, from 1.", optional: true, type: "integer" },
    { name: "end_line", description: "Last line to read.", optional: true, type: "integer" }
  ],
  async run({ path: file, start_line, end_line }) {
    if (!file) throw new ToolInputError("read_file needs a path.")
    const absolute = view.resolve(file, "file")
    const text = await view.text(absolute)
    if (text === undefined) throw new ToolInputError(`${file} is binary or too large to read.`)
    const lines = text.split("\n")
    const start = Math.max(1, Number.parseInt(start_line ?? "", 10) || 1)
    const asked = Number.parseInt(end_line ?? "", 10) || lines.length
    const end = Math.min(lines.length, asked, start + MAX_READ_LINES - 1)
    const rel = view.relative(absolute)
    if (start > lines.length) {
      throw new ToolInputError(`${rel} has only ${lines.length} lines.`)
    }
    const body = lines
      .slice(start - 1, end)
      .map((line, i) => `${start + i}: ${clip(line)}`)
      .join("\n")
    const cut = end < Math.min(asked, lines.length)
      ? `\n… stopped at line ${end} of ${lines.length}; read on with start_line ${end + 1}`
      : ""
    return {
      output: `${rel} (lines ${start}–${end} of ${lines.length})\n${body}${cut}`,
      summary: `read \`${rel}:${start}–${end}\``
    }
  }
})

const grep = (view: WorkspaceView): Tool => ({
  name: "grep",
  description: "Lines matching a regular expression, across the workspace or under one directory. An all-lowercase pattern ignores case.",
  parameters: [
    { name: "pattern", description: "A JavaScript regular expression." },
    { name: "path", description: "A directory to search under, or one file; the whole workspace by default.", optional: true }
  ],
  async run({ pattern, path: dir }) {
    if (!pattern) throw new ToolInputError("grep needs a pattern.")
    const scope = dir ? view.relative(view.resolve(dir, "any")) : "."
    const search = async (regex: RegExp) => {
      const matches: string[] = []
      let total = 0
      for (const file of await view.files()) {
        const rel = view.relative(file)
        if (scope !== "." && rel !== scope && !rel.startsWith(`${scope}/`)) continue
        const text = await view.text(file)
        if (!text) continue
        text.split("\n").forEach((line, i) => {
          if (!regex.test(line)) return
          total++
          if (matches.length < MAX_GREP_MATCHES) matches.push(`${rel}:${i + 1}: ${clip(line.trim())}`)
        })
      }
      return { matches, total }
    }
    const asRegex = await search(searchPattern(pattern))
    // Models write `ctrl+i` or `foo()` meaning the text, not the regex.
    const asText =
      !asRegex.total && /[.*+?^${}()|[\]\\]/.test(pattern) ? await search(literalPattern(pattern)) : undefined
    const literally = !!asText?.total
    const { matches, total } = literally && asText ? asText : asRegex
    const more = total - matches.length
    return {
      output: matches.length
        ? (literally ? "(Nothing matched as a regular expression; these match the text as written.)\n" : "") +
          matches.join("\n") +
          (more > 0 ? `\n… ${more} more; narrow the pattern or the path` : "")
        : "No matches.",
      summary: `searched for \`${pattern}\`${scope !== "." ? ` in \`${scope}\`` : ""} · ${plural(total, "match", "matches")}`
    }
  }
})

const findSymbol = (view: WorkspaceView): Tool => ({
  name: "find_symbol",
  description: "Where a function, class, method, type or variable is defined.",
  parameters: [{ name: "name", description: "The symbol's name, exactly as written in code." }],
  async run({ name }) {
    const wanted = name?.trim()
    if (!wanted) throw new ToolInputError("find_symbol needs a name.")
    const regex = definitionPattern(wanted)
    const found: string[] = []
    for (const file of await view.files()) {
      const text = await view.text(file)
      if (!text?.includes(wanted)) continue
      text.split("\n").forEach((line, i) => {
        if (found.length < MAX_SYMBOL_MATCHES && regex.test(line)) {
          found.push(`${view.relative(file)}:${i + 1}: ${clip(line.trim())}`)
        }
      })
    }
    return {
      output: found.length
        ? found.join("\n")
        : `No definition of ${wanted} found. Try grep for where it is used.`,
      summary: `looked up \`${wanted}\` · ${found.length ? plural(found.length, "definition") : "not found"}`
    }
  }
})

const EDIT_DESCRIPTION = {
  apply:
    "Change a file by replacing an exact piece of it. The change is applied and saved straight away; the user can undo it.",
  review:
    "Propose changing a file by replacing an exact piece of it. The user reviews the change as a diff in the editor and nothing is saved until they accept it. One edit at a time."
}

const EDIT_GUIDANCE = {
  apply:
    "When the user asks you to change code, read the lines first, then call edit_file, once per change, until the task is done; use create_file for a new file. Then say briefly what you changed.",
  review:
    "When the user asks you to change code, read the lines first, then call edit_file (or create_file for a new file). The user reviews each change before it is applied, so propose one and say briefly what it does."
}

const MAX_NEW_FILE_CHARS = 100_000

const createFile = (view: WorkspaceView, sink: EditSink): Tool => ({
  name: "create_file",
  description:
    (sink.mode === "apply"
      ? "Create a new file with the given content; missing folders are made. It is written straight away."
      : "Propose a new file with the given content. The user reviews it before it is saved.") +
    " The file must not exist yet; use edit_file to change an existing one.",
  parameters: [
    { name: "path", description: "Where the new file goes, relative to the workspace root." },
    { name: "content", description: "The whole file." }
  ],
  async run({ path: file, content }) {
    if (content === undefined) throw new ToolInputError("create_file needs content.")
    if (content.length > MAX_NEW_FILE_CHARS) throw new ToolInputError("That file is too large to create in one go.")
    const absolute = view.resolveNew(file)
    const rel = view.relative(absolute)
    const outcome = await sink.create(absolute, content)
    if (!outcome.ok) {
      return { output: outcome.message, summary: `\`${rel}\` not created · ${outcome.message}`, failed: true }
    }
    view.forgetFiles()
    const lines = content.replace(/\n$/, "").split("\n").length
    return {
      output: outcome.message,
      summary: `${outcome.pending ? "proposed a new file" : "created"} \`${rel}\` · ${plural(lines, "line")}`,
      final: outcome.pending
    }
  }
})

const editFile = (view: WorkspaceView, sink: EditSink): Tool => ({
  name: "edit_file",
  description: `${EDIT_DESCRIPTION[sink.mode]} Copy find from read_file output, without the line numbers, with enough lines that it matches once.`,
  guidance: EDIT_GUIDANCE[sink.mode],
  parameters: [
    { name: "path", description: "The file to change." },
    { name: "find", description: "Text already in the file, copied exactly." },
    { name: "replace", description: "What it becomes." }
  ],
  async run({ path: file, find, replace }) {
    if (!file) throw new ToolInputError("edit_file needs a path.")
    if (find === undefined || replace === undefined) {
      throw new ToolInputError("edit_file needs find and replace.")
    }
    const absolute = view.resolve(file, "file")
    const rel = view.relative(absolute)
    const text = await view.text(absolute)
    if (text === undefined) throw new ToolInputError(`${rel} is binary or too large to edit.`)
    const plan = planReplacement(text, find, replace)
    if (typeof plan === "string") throw new ToolInputError(`${rel}: ${plan}.`)
    const lines =
      plan.startLine === plan.endLine ? `${plan.startLine + 1}` : `${plan.startLine + 1}–${plan.endLine + 1}`
    const outcome = await sink.edit(absolute, plan)
    if (!outcome.ok) {
      return { output: outcome.message, summary: `\`${rel}\` not changed · ${outcome.message}`, failed: true }
    }
    return {
      output: outcome.message,
      summary: `${outcome.pending ? "proposed an edit to" : "edited"} \`${rel}:${lines}\``,
      final: outcome.pending
    }
  }
})

export interface WorkspaceTools {
  tools: Tool[]
  /** A line naming the top-level entries, so the model starts oriented. */
  orientation: string
  run(call: ToolCall): Promise<ToolResult>
}

/**
 * Where commands run: the Twinny terminal in the extension. `ask` puts
 * each one to the user first; `allow` runs it straight away.
 */
export interface CommandSink {
  mode: "ask" | "allow"
  run(command: string): Promise<CommandOutcome>
}

export interface CommandOutcome {
  /** False when the user skipped it. */
  ran: boolean
  /** The tail of what it printed, ANSI stripped. */
  output: string
  exitCode?: number
  /** Still running when the wait ran out; the output is what came so far. */
  timedOut?: boolean
}

/** A hit from the embeddings index. Lines are 0-based, inclusive. */
export interface CodeHit {
  file: string
  startLine: number
  endLine: number
  score: number
  content: string
}

/** Search by meaning over the workspace's embeddings index. */
export interface CodeSearch {
  search(query: string): Promise<CodeHit[]>
}

const MAX_COMMAND_CHARS = 1000
const MAX_SEARCH_OUTPUT_CHARS = 6000

const runCommand = (sink: CommandSink): Tool => ({
  name: "run_command",
  description:
    "Run a shell command in the workspace root and get its exit code and the end of its output: tests, builds, type checks, git." +
    (sink.mode === "ask" ? " The user is asked before it runs and may skip it." : " It runs straight away."),
  guidance:
    "Use run_command to check your work (tests, type checks, builds) or to read git history. Never run commands that delete files, rewrite history or install software unless the user asked for exactly that.",
  parameters: [{ name: "command", description: "One command line for the user's shell." }],
  async run({ command }) {
    const line = command?.trim()
    if (!line) throw new ToolInputError("run_command needs a command.")
    if (line.length > MAX_COMMAND_CHARS) throw new ToolInputError("That command is too long; write a shorter one.")
    const outcome = await sink.run(line)
    if (!outcome.ran) {
      return {
        output: "The user chose not to run this command. Carry on without it, or ask the user.",
        summary: `\`${line}\` skipped`
      }
    }
    const status = outcome.timedOut
      ? "still running when the wait ran out; this is its output so far"
      : outcome.exitCode === undefined
        ? "finished; the shell did not report an exit code"
        : `exit code ${outcome.exitCode}`
    return {
      failed: !outcome.timedOut && outcome.exitCode !== undefined && outcome.exitCode !== 0,
      output: `$ ${line}\n(${status})\n${outcome.output.trim() || "(no output)"}`,
      summary: `ran \`${line}\` · ${outcome.timedOut ? "still running" : outcome.exitCode === undefined ? "done" : `exit ${outcome.exitCode}`}`
    }
  }
})

const searchCode = (view: WorkspaceView, index: CodeSearch): Tool => ({
  name: "search_code",
  description:
    "Find code by what it does, described in plain words (\"where retries are scheduled\", \"how the token is refreshed\"). Searches the workspace's embeddings index; use grep instead for an exact name.",
  guidance:
    "Start with search_code when you do not know where something lives; it finds code by meaning.",
  parameters: [{ name: "query", description: "What the code does, in a few words." }],
  async run({ query }) {
    const wanted = query?.trim()
    if (!wanted) throw new ToolInputError("search_code needs a query.")
    const hits = await index.search(wanted)
    const blocks: string[] = []
    let used = 0
    for (const hit of hits) {
      const header = `${view.relative(hit.file)}:${hit.startLine + 1}-${hit.endLine + 1} (relevance ${hit.score.toFixed(2)})`
      const block = `${header}\n${hit.content.trimEnd()}`
      if (used + block.length > MAX_SEARCH_OUTPUT_CHARS) {
        blocks.push(`${header}\n… (not shown; read_file it)`)
        continue
      }
      blocks.push(block)
      used += block.length
    }
    return {
      output: blocks.length
        ? blocks.join("\n\n")
        : "Nothing in the index matched well. Try other words, or grep for a name.",
      summary: `searched the index for \`${wanted}\` · ${plural(hits.length, "hit")}`
    }
  }
})

/** What the tools can reach beyond reading files, when the host provides it. */
export interface ToolExtras {
  edits?: EditSink & Partial<FileOpsSink>
  commands?: CommandSink
  codeSearch?: CodeSearch
  /** The editor's language servers and open files. */
  editor?: EditorSink
  /** Whether `git` is offered; on by default. */
  git?: boolean
}

/**
 * The read-only tools, plus `search_code`, `edit_file` and `run_command`
 * when there is an index to search, somewhere for edits to go and a
 * terminal to run in.
 */
export const workspaceTools = (
  root: string,
  ignoredGlobs: string[] = [],
  extras: ToolExtras = {}
): WorkspaceTools => {
  const { edits, commands, codeSearch, editor } = extras
  const view = new WorkspaceView(root, ignoredGlobs, edits?.read?.bind(edits))
  const tools = [
    ...(codeSearch ? [searchCode(view, codeSearch)] : []),
    ...(editor ? [editorContext(view, editor)] : []),
    listDir(view),
    findFiles(view),
    readFile(view),
    grep(view),
    findSymbol(view),
    ...(editor ? [goToDefinition(view, editor), findReferences(view, editor), diagnostics(view, editor)] : []),
    ...(extras.git !== false ? [git(view)] : [])
  ]
  if (edits) tools.push(editFile(view, edits), createFile(view, edits))
  if (edits && editor) tools.push(renameSymbol(view, editor))
  if (edits?.remove && edits.move) {
    const ops = { remove: edits.remove.bind(edits), move: edits.move.bind(edits) }
    tools.push(moveFile(view, ops), deleteFile(view, ops))
  }
  if (commands) tools.push(runCommand(commands))
  const top = view.entries(root).map((e) => (e.dir ? `${e.name}/` : e.name))
  return {
    tools,
    orientation: `The workspace root contains: ${top.slice(0, 40).join(", ")}${top.length > 40 ? ", …" : ""}`,
    async run(call) {
      const tool = tools.find((t) => t.name === call.name)
      if (!tool) {
        return {
          output: `There is no tool called ${call.name}. The tools are ${tools.map((t) => t.name).join(", ")}.`,
          summary: `asked for an unknown tool \`${call.name}\``,
          failed: true
        }
      }
      try {
        return await tool.run(call.args)
      } catch (error) {
        if (!(error instanceof ToolInputError)) throw error
        return { output: error.message, summary: `${call.name} failed · ${error.message}`, failed: true }
      }
    }
  }
}

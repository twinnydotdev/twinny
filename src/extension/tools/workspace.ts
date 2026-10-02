/**
 * The tools a chat model works with in one workspace folder: reading and
 * searching, and, where the host gives them somewhere to go, editing files
 * and running commands. Plain Node, no VS Code, so the same tools run in
 * the extension and in a headless eval; what needs the editor (edits,
 * the terminal, language servers) comes in as a sink.
 *
 * Everything stays inside the root and out of what `.gitignore` ignores
 * (see `view.ts`). Every result is capped, and says so, because a small
 * model's context fills after a couple of whole files.
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
  insideGitRepository,
  moveFile,
  renameSymbol
} from "./more"
import { ToolCall, ToolSpec } from "./protocol"
import { clip, linesOf, plural, ToolInputError, WorkspaceView } from "./view"

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

/** What a running tool is told: when the user has stopped the reply. */
export interface ToolContext {
  signal?: AbortSignal
}

export interface Tool extends ToolSpec {
  run(args: Record<string, string>, context?: ToolContext): Promise<ToolResult>
}

const MAX_READ_LINES = 150
const MAX_GREP_MATCHES = 40
/** Matches shown per file, so one noisy file does not hide the others. */
const MAX_GREP_PER_FILE = 10
/** Files named, with their match counts, beyond the ones whose lines are shown. */
const MAX_GREP_OTHER_FILES = 15
/** With this few matches in all, each is shown with the lines around it. */
const GREP_CONTEXT_MATCHES = 6
const GREP_CONTEXT_LINES = 2
const MAX_LIST_ENTRIES = 150
const MAX_SYMBOL_MATCHES = 15
/** A search gives up after this long and says what it did not reach. */
const SEARCH_BUDGET_MS = 8000
/** Longer lines (minified code) are matched on their start only, which bounds a slow pattern. */
const MAX_MATCHED_LINE_CHARS = 2000

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

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The text itself as a pattern; lowercase means any case. */
const literalPattern = (pattern: string) =>
  new RegExp(escapeRegex(pattern), pattern === pattern.toLowerCase() ? "i" : "")

/** A pattern as a regex; one that does not compile is searched for literally. Lowercase means any case. */
const searchPattern = (pattern: string) => {
  try {
    return new RegExp(pattern, pattern === pattern.toLowerCase() ? "i" : "")
  } catch {
    return literalPattern(pattern)
  }
}

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
    const rel = view.relative(absolute)
    const text = await view.text(absolute)
    if (text === undefined) throw new ToolInputError(`${rel} is binary or too large to read.`)
    const lines = linesOf(text)
    if (!lines.length) return { output: `${rel} is empty.`, summary: `read \`${rel}\` · empty` }
    const start = Math.max(1, Number.parseInt(start_line ?? "", 10) || 1)
    if (start > lines.length) {
      throw new ToolInputError(`${rel} has only ${plural(lines.length, "line")}.`)
    }
    const asked = Math.max(start, Number.parseInt(end_line ?? "", 10) || lines.length)
    const end = Math.min(lines.length, asked, start + MAX_READ_LINES - 1)
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
  description:
    "Lines matching a regular expression, across the workspace or under one directory, grouped by file (`12:` is a match, `12-` a line beside one). An all-lowercase pattern ignores case.",
  parameters: [
    { name: "pattern", description: "A JavaScript regular expression." },
    { name: "path", description: "A directory to search under, or one file; the whole workspace by default.", optional: true }
  ],
  async run({ pattern, path: dir }, context) {
    if (!pattern) throw new ToolInputError("grep needs a pattern.")
    const scope = dir ? view.relative(view.resolve(dir, "any")) : "."
    const started = Date.now()
    const search = async (regex: RegExp) => {
      /** Files whose matches are shown: their lines, and which of them matched (0-based). */
      const shownFiles: { file: string; lines: string[]; hits: number[]; count: number }[] = []
      /** Files with matches that got no lines of their own, with how many each has. */
      const others: { file: string; count: number }[] = []
      let shown = 0
      let total = 0
      let unsearched = 0
      const all = await view.files()
      for (const [index, file] of all.entries()) {
        const rel = view.relative(file)
        if (scope !== "." && rel !== scope && !rel.startsWith(`${scope}/`)) continue
        if (context?.signal?.aborted || Date.now() - started > SEARCH_BUDGET_MS) {
          unsearched = all.length - index
          break
        }
        const text = await view.text(file)
        if (!text) continue
        const lines = linesOf(text)
        const hits: number[] = []
        let count = 0
        lines.forEach((line, i) => {
          const probe = line.length > MAX_MATCHED_LINE_CHARS ? line.slice(0, MAX_MATCHED_LINE_CHARS) : line
          if (!regex.test(probe)) return
          count++
          if (hits.length < MAX_GREP_PER_FILE && shown + hits.length < MAX_GREP_MATCHES) hits.push(i)
        })
        if (!count) continue
        total += count
        if (!hits.length) {
          others.push({ file: rel, count })
          continue
        }
        shown += hits.length
        shownFiles.push({ file: rel, lines, hits, count })
      }
      // A handful of matches come with the lines around them, as `rg -C`
      // prints them: what the model wants next is nearly always right there,
      // and a read to fetch it would cost a whole request.
      const around = total <= GREP_CONTEXT_MATCHES ? GREP_CONTEXT_LINES : 0
      const blocks = shownFiles.map(({ file, lines, hits, count }) => {
        const rows: string[] = []
        let printed = -1
        for (const hit of hits) {
          const from = Math.max(printed + 1, hit - around)
          if (around && printed !== -1 && from > printed + 1) rows.push("--")
          for (let i = from; i <= Math.min(lines.length - 1, hit + around); i++) {
            // A later match inside this one's context is printed as a match when its turn comes.
            if (i > hit && hits.includes(i)) break
            // With context the indentation stays, so the lines read as the code they are.
            rows.push(`${i + 1}${i === hit ? ":" : "-"} ${clip(around ? lines[i].trimEnd() : lines[i].trim())}`)
            printed = i
          }
        }
        return [file, ...rows, ...(count > hits.length ? [`… ${count - hits.length} more in this file`] : [])].join("\n")
      })
      return { blocks, others, total, files: blocks.length + others.length, unsearched }
    }

    // A pattern is tried as written, then as the models tend to mean it,
    // until something matches.
    const attempts: { regex: RegExp; note?: string }[] = [
      { regex: searchPattern(pattern) },
      // `ctrl+i` or `foo()`, meaning the text rather than the regex.
      ...(/[.*+?^${}()|[\]\\]/.test(pattern)
        ? [
            {
              regex: literalPattern(pattern),
              note: "(Nothing matched as a regular expression; these match the text as written.)"
            }
          ]
        : []),
      // `ctrl\\+i`: escaped for the regex, then once more for the JSON it came in.
      ...(pattern.includes("\\\\")
        ? [
            {
              regex: searchPattern(pattern.replace(/\\\\/g, "\\")),
              note: "(Nothing matched as written; these match with each doubled backslash read as one.)"
            }
          ]
        : [])
    ]
    let found = await search(attempts[0].regex)
    let note: string | undefined
    for (const attempt of attempts.slice(1)) {
      if (found.total) break
      const again = await search(attempt.regex)
      if (again.total) [found, note] = [again, attempt.note]
    }

    const { blocks, others, total, files, unsearched } = found
    // Where else it matched, busiest first: enough for a narrower search.
    const elsewhere = [...others].sort((a, b) => b.count - a.count)
    const named = elsewhere.slice(0, MAX_GREP_OTHER_FILES).map(({ file, count }) => `${file} (${count})`)
    const notes = [
      ...(elsewhere.length
        ? [
            `… also in ${named.join(", ")}` +
              (elsewhere.length > named.length ? ` and ${plural(elsewhere.length - named.length, "more file")}` : "") +
              "; narrow the pattern or the path"
          ]
        : []),
      ...(unsearched > 0 ? [`… stopped early: ${plural(unsearched, "file")} not searched; narrow the path`] : [])
    ]
    return {
      output: blocks.length ? [...(note ? [note] : []), ...blocks, ...notes].join("\n") : ["No matches.", ...notes].join("\n"),
      summary:
        `searched for \`${pattern}\`${scope !== "." ? ` in \`${scope}\`` : ""} · ` +
        (total ? `${plural(total, "match", "matches")} in ${plural(files, "file")}` : "no matches")
    }
  }
})

const findSymbol = (view: WorkspaceView): Tool => ({
  name: "find_symbol",
  description: "Where a function, class, method, type or variable is defined.",
  parameters: [{ name: "name", description: "The symbol's name, exactly as written in code." }],
  async run({ name }, context) {
    const wanted = name?.trim()
    if (!wanted) throw new ToolInputError("find_symbol needs a name.")
    const regex = definitionPattern(wanted)
    const found: string[] = []
    const started = Date.now()
    for (const file of await view.files()) {
      if (found.length >= MAX_SYMBOL_MATCHES) break
      if (context?.signal?.aborted || Date.now() - started > SEARCH_BUDGET_MS) break
      const text = await view.text(file)
      if (!text?.includes(wanted)) continue
      linesOf(text).forEach((line, i) => {
        if (found.length < MAX_SYMBOL_MATCHES && line.length <= MAX_MATCHED_LINE_CHARS && regex.test(line)) {
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
    return {
      output: outcome.message,
      summary: `${outcome.pending ? "proposed a new file" : "created"} \`${rel}\` · ${plural(linesOf(content).length, "line")}`,
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
  run(call: ToolCall, context?: ToolContext): Promise<ToolResult>
}

/**
 * Where commands run: a terminal in the extension. `ask` puts each one to
 * the user first; `allow` runs it straight away.
 */
export interface CommandSink {
  mode: "ask" | "allow"
  run(command: string, signal?: AbortSignal): Promise<CommandOutcome>
}

export interface CommandOutcome {
  /** False when the user skipped it. */
  ran: boolean
  /** The tail of what it printed, ANSI stripped. */
  output: string
  exitCode?: number
  /**
   * The wait ran out before the command ended: `running` when it was left
   * to carry on (a server in the terminal), `stopped` when it was ended.
   */
  timedOut?: "running" | "stopped"
  /** It was stopped by the user's stop on its step; the reply carries on. */
  stoppedByUser?: boolean
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
    "Run a shell command in the workspace root and get its exit code and the end of its output: tests, builds, type checks." +
    (sink.mode === "ask" ? " The user is asked before it runs and may skip it." : " It runs straight away."),
  guidance:
    "Use run_command to check your work (tests, type checks, builds). Never run commands that delete files, rewrite history or install software unless the user asked for exactly that. Nothing can answer a prompt, and you get the output after two minutes at most: no interactive commands, servers or watch modes.",
  parameters: [{ name: "command", description: "One command line for the user's shell." }],
  async run({ command }, context) {
    const line = command?.trim()
    if (!line) throw new ToolInputError("run_command needs a command.")
    if (line.length > MAX_COMMAND_CHARS) throw new ToolInputError("That command is too long; write a shorter one.")
    const outcome = await sink.run(line, context?.signal)
    if (!outcome.ran) {
      return {
        output: "The user chose not to run this command. Carry on without it, or ask the user.",
        summary: `\`${line}\` skipped`
      }
    }
    if (outcome.stoppedByUser) {
      return {
        output: `$ ${line}\n(stopped by the user before it ended; this is its output so far)\n${outcome.output.trim() || "(no output)"}`,
        summary: `\`${line}\` stopped`
      }
    }
    const status =
      outcome.timedOut === "running"
        ? "still running when the wait ran out; this is its output so far"
        : outcome.timedOut === "stopped"
          ? "stopped: it ran longer than the wait allows; this is its output so far"
          : outcome.exitCode === undefined
            ? "finished; the shell did not report an exit code"
            : `exit code ${outcome.exitCode}`
    const outcomeWord = outcome.timedOut
      ? outcome.timedOut === "running" ? "still running" : "timed out"
      : outcome.exitCode === undefined ? "done" : `exit ${outcome.exitCode}`
    return {
      failed: outcome.timedOut === "stopped" || (!outcome.timedOut && !!outcome.exitCode),
      output: `$ ${line}\n(${status})\n${outcome.output.trim() || "(no output)"}`,
      summary: `ran \`${line}\` · ${outcomeWord}`
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
    // The index is built from the same files, but it is older than the
    // rules: nothing ignored since comes back through it.
    const hits = (await index.search(wanted)).filter((hit) => view.visible(hit.file))
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
  /** Whether `git` is offered when the root is in a repository; on by default. */
  git?: boolean
}

/**
 * The reading tools, plus `search_code`, the editor's tools, `edit_file`
 * and its kin, and `run_command`, when there is an index to search, an
 * editor to ask, somewhere for edits to go and a terminal to run in.
 * `root` is the folder, or a view of it the host already made (so its
 * sinks can share the view's rules).
 */
export const workspaceTools = (
  root: string | WorkspaceView,
  ignoredGlobs: string[] = [],
  extras: ToolExtras = {}
): WorkspaceTools => {
  const { edits, commands, codeSearch, editor } = extras
  const view =
    typeof root === "string" ? new WorkspaceView(root, ignoredGlobs, edits?.read?.bind(edits)) : root
  const tools = [
    ...(codeSearch ? [searchCode(view, codeSearch)] : []),
    ...(editor ? [editorContext(view, editor)] : []),
    listDir(view),
    findFiles(view),
    readFile(view),
    grep(view),
    findSymbol(view),
    ...(editor ? [goToDefinition(view, editor), findReferences(view, editor), diagnostics(view, editor)] : []),
    ...(extras.git !== false && insideGitRepository(view.root) ? [git(view)] : [])
  ]
  if (edits) tools.push(editFile(view, edits), createFile(view, edits))
  if (edits && editor) tools.push(renameSymbol(view, editor))
  if (edits?.remove && edits.move) {
    const ops = { remove: edits.remove.bind(edits), move: edits.move.bind(edits) }
    tools.push(moveFile(view, ops), deleteFile(view, ops))
  }
  if (commands) tools.push(runCommand(commands))
  const top = view.entries(view.root).map((e) => (e.dir ? `${e.name}/` : e.name))
  return {
    tools,
    orientation: `The workspace root contains: ${top.slice(0, 40).join(", ")}${top.length > 40 ? ", …" : ""}`,
    async run(call, context) {
      const tool = tools.find((t) => t.name === call.name)
      if (!tool) {
        return {
          output: `There is no tool called ${call.name}. The tools are ${tools.map((t) => t.name).join(", ")}.`,
          summary: `asked for an unknown tool \`${call.name}\``,
          failed: true
        }
      }
      try {
        return await tool.run(call.args, context)
      } catch (error) {
        // Whatever goes wrong inside a tool is the model's to read and work
        // around; it never ends the reply.
        const message = (error instanceof Error ? error.message : String(error)).split("\n")[0]
        return error instanceof ToolInputError
          ? { output: message, summary: `${call.name} failed · ${message}`, failed: true }
          : { output: `${call.name} could not run: ${message}`, summary: `${call.name} failed · ${message}`, failed: true }
      }
    }
  }
}

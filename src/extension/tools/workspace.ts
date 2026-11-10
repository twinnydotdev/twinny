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
import { EditRequest, planEdits, Replacement } from "./edit"
import { FolderInstructions, folderInstructionsNote, InstructionFile, readRootInstructions } from "./instructions"
import { coerceArguments, JsonSchema, McpToolSpec } from "./mcp"
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
import { outlineOf, outlineText } from "./outline"
import { parseLenientJson, ToolCall, ToolSpec } from "./protocol"
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
  /**
   * What the model reads ahead of the output, and the user does not see in
   * the step: the instructions of a folder the call reached.
   */
  preface?: string
  /**
   * What is kept of the output when it is trimmed out of the model's
   * context to make room: enough to know what was there and where to look
   * again. Its first line, when the tool gives none.
   */
  digest?: string
}

/** What a running tool is told: when the user has stopped the reply, and how much it may send back. */
export interface ToolContext {
  signal?: AbortSignal
  /** Characters the result has room for in the model's context, when that is known. */
  roomChars?: number
}

export interface Tool extends ToolSpec {
  run(args: Record<string, string>, context?: ToolContext): Promise<ToolResult>
}

/** Lines of a file read at once when the model's context is small or unknown; a larger one reads more, up to the most. */
const MAX_READ_LINES = 150
const MOST_READ_LINES = 500
/** What a line of code runs to, for turning a result's room into lines. */
const CHARS_PER_LINE = 45
/** Lines shown after an edit on each side of the change, and of the change itself. */
const EDIT_CONTEXT_LINES = 2
const MAX_EDIT_SHOWN_LINES = 30
/** Lines of a file shown to a model that tried to edit it without reading it. */
const MAX_UNREAD_SHOWN_LINES = 80
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
  /** Errors the editor reports in the file since the change; the message names them. */
  newErrors?: number
}

/** ` · 2 new errors`, for a step's line, when the change left any. */
const errorsNote = (outcome: EditOutcome) =>
  outcome.newErrors ? ` · ${plural(outcome.newErrors, "new error")}` : ""

/** A comma-separated list held to `max` characters, ending on a whole entry. */
const cutToLast = (list: string, max: number): { text: string; cut: boolean } => {
  if (list.length <= max) return { text: list, cut: false }
  const end = list.lastIndexOf(", ", max)
  return { text: end > 0 ? list.slice(0, end) : "", cut: true }
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
  readOnly: true,
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

const readFile = (view: WorkspaceView, seen: Map<string, string>): Tool => ({
  name: "read_file",
  readOnly: true,
  description: "A file's lines, numbered. A long file comes a part at a time, with what is defined further down; ask for a range to read on.",
  parameters: [
    { name: "path", description: "The file." },
    { name: "start_line", description: "First line to read, from 1.", optional: true, type: "integer" },
    { name: "end_line", description: "Last line to read.", optional: true, type: "integer" }
  ],
  async run({ path: file, start_line, end_line }, context) {
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
    // As much as the model's context has room for: a file read whole costs
    // one request, and one read in parts costs a request for each.
    const room = context?.roomChars
    const most = room ? Math.min(MOST_READ_LINES, Math.max(MAX_READ_LINES, Math.floor(room / CHARS_PER_LINE))) : MAX_READ_LINES
    const last = Math.min(lines.length, asked, start + most - 1)
    // Kept back for the header and for what is defined below where the read stops.
    const reserve = room ? Math.min(1200, Math.floor(room / 4)) : 1200
    const rows: string[] = []
    let used = 0
    for (let i = start; i <= last; i++) {
      const row = `${i}: ${clip(lines[i - 1])}`
      // Room for the lines, less the header and the outline that may follow.
      if (room && rows.length >= 40 && used + row.length + 1 > room - reserve) break
      rows.push(row)
      used += row.length + 1
    }
    const end = start + rows.length - 1
    const stopped = end < Math.min(asked, lines.length)
    // What is defined in the part not shown, so the next read can go straight to it.
    const below = stopped ? outlineOf(lines, end, lines.length, 50) : undefined
    const named = below ? cutToLast(outlineText(below.found), reserve - 200) : undefined
    const cut = stopped
      ? `\n… stopped at line ${end} of ${lines.length}; read on with start_line ${end + 1}` +
        (named?.text ? `\nDefined further down (line): ${named.text}${below?.more || named.cut ? ", …" : ""}` : "")
      : ""
    const header = `${rel} (lines ${start}–${end} of ${lines.length})`
    const shown = outlineOf(lines, start - 1, end, 15)
    seen.set(absolute, text)
    return {
      output: `${header}\n${rows.join("\n")}${cut}`,
      summary: `read \`${rel}:${start}–${end}\``,
      digest: shown.found.length ? `${header}; defined there (line): ${outlineText(shown.found)}${shown.more ? ", …" : ""}` : header
    }
  }
})

const grep = (view: WorkspaceView): Tool => ({
  name: "grep",
  readOnly: true,
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
    const where = [...blocks.map((block) => block.split("\n", 1)[0]), ...elsewhere.map(({ file }) => file)]
    return {
      output: blocks.length ? [...(note ? [note] : []), ...blocks, ...notes].join("\n") : ["No matches.", ...notes].join("\n"),
      summary:
        `searched for \`${pattern}\`${scope !== "." ? ` in \`${scope}\`` : ""} · ` +
        (total ? `${plural(total, "match", "matches")} in ${plural(files, "file")}` : "no matches"),
      digest: total
        ? `grep \`${pattern}\`: ${plural(total, "match", "matches")} in ${where.slice(0, 12).join(", ")}${where.length > 12 ? ", …" : ""}`
        : `grep \`${pattern}\`: no matches`
    }
  }
})

const findSymbol = (view: WorkspaceView): Tool => ({
  name: "find_symbol",
  readOnly: true,
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
  acts: true,
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
      summary: `${outcome.pending ? "proposed a new file" : "created"} \`${rel}\` · ${plural(linesOf(content).length, "line")}${errorsNote(outcome)}`,
      final: outcome.pending
    }
  }
})

/** A whole number argument, or undefined when it was left out or is not one. */
const lineNumber = (value: string | undefined) => {
  const number = Number.parseInt(value ?? "", 10)
  return Number.isFinite(number) ? number : undefined
}

const isTrue = (value: string | undefined) => /^(true|yes|1)$/i.test(value?.trim() ?? "")

/** The `edits` argument as a list of changes, or what is wrong with it. */
const editList = (raw: string): EditRequest[] | string => {
  const parsed = parseLenientJson(raw)
  const list = "value" in parsed ? parsed.value : undefined
  if (!Array.isArray(list) || !list.length) return "edits must be a list like [{\"find\": \"…\", \"replace\": \"…\"}]"
  const edits: EditRequest[] = []
  for (const [index, entry] of list.entries()) {
    const { find, replace, replace_all } = (entry ?? {}) as Record<string, unknown>
    if (typeof find !== "string" || typeof replace !== "string") {
      return `edit ${index + 1} of ${list.length} needs find and replace, both text`
    }
    edits.push({ find, replace, all: replace_all === true || isTrue(String(replace_all ?? "")) })
  }
  return edits
}

/** Lines `from`–`to` (from 1) as `read_file` shows them. */
const numbered = (lines: string[], from: number, to: number) =>
  lines
    .slice(from - 1, to)
    .map((line, i) => `${from + i}: ${clip(line)}`)
    .join("\n")

/**
 * The file's lines around a change just made, numbered as they are now:
 * the model sees what it did and has the numbers for its next edit,
 * without a read.
 */
const afterEdit = (text: string, plan: Replacement): { text: string; shown: string } => {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const added = plan.text === "" ? [] : plan.text.split("\n")
  lines.splice(plan.startLine, plan.endLine - plan.startLine + 1, ...added)
  const from = Math.max(1, plan.startLine + 1 - EDIT_CONTEXT_LINES)
  // The empty string after a final line break is not a line anyone numbers.
  const count = lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length
  const to = Math.max(from, Math.min(count, plan.startLine + added.length + EDIT_CONTEXT_LINES))
  const shown =
    to - from + 1 <= MAX_EDIT_SHOWN_LINES
      ? `Lines ${from}–${to} are now:\n${numbered(lines, from, to)}`
      : `Lines ${from}–${to} changed; they begin:\n${numbered(lines, from, from + MAX_EDIT_SHOWN_LINES - 1)}\n…`
  return { text: lines.join("\n"), shown }
}

const editFile = (view: WorkspaceView, sink: EditSink, seen: Map<string, string>): Tool => ({
  name: "edit_file",
  acts: true,
  description:
    `${EDIT_DESCRIPTION[sink.mode]} Copy find from read_file output, without the line numbers, with enough lines that it matches once. ` +
    "Other ways to say what changes: replace_all true changes every place find is; start_line and end_line (from read_file) with replace rewrite those lines, with no find; " +
    "edits is a list of {find, replace} for several changes to one file in one call.",
  guidance: EDIT_GUIDANCE[sink.mode],
  parameters: [
    { name: "path", description: "The file to change." },
    { name: "find", description: "Text already in the file, copied exactly.", optional: true },
    { name: "replace", description: "What it becomes.", optional: true },
    { name: "replace_all", description: "true to change every place find is, not just one.", optional: true, type: "boolean" },
    { name: "start_line", description: "With end_line, in place of find: the first line to rewrite.", optional: true, type: "integer" },
    { name: "end_line", description: "The last line to rewrite.", optional: true, type: "integer" },
    {
      name: "edits",
      description: "In place of find and replace: several changes to this file, made in order.",
      optional: true,
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: { find: { type: "string" }, replace: { type: "string" }, replace_all: { type: "boolean" } },
          required: ["find", "replace"]
        }
      }
    }
  ],
  async run({ path: file, find, replace, replace_all, start_line, end_line, edits }) {
    if (!file) throw new ToolInputError("edit_file needs a path.")
    const start = lineNumber(start_line)
    const byLines = start !== undefined && find === undefined
    let requests: EditRequest[]
    if (edits !== undefined && find === undefined && !byLines) {
      const list = editList(edits)
      if (typeof list === "string") throw new ToolInputError(`edit_file: ${list}.`)
      requests = list
    } else if (byLines) {
      if (replace === undefined) throw new ToolInputError("edit_file needs replace: what lines start_line to end_line become.")
      requests = [{ replace, startLine: start, endLine: lineNumber(end_line) ?? start }]
    } else {
      if (find === undefined || replace === undefined) throw new ToolInputError("edit_file needs find and replace.")
      requests = [{ find, replace, all: isTrue(replace_all) }]
    }
    const absolute = view.resolve(file, "file")
    const rel = view.relative(absolute)
    const text = await view.text(absolute)
    if (text === undefined) throw new ToolInputError(`${rel} is binary or too large to edit.`)
    // Line numbers are only as good as the read they came from: a file
    // that changed since (an earlier edit, the user typing) has moved under
    // them, so the lines are shown as they are now rather than rewritten.
    if (byLines && seen.get(absolute) !== text) {
      seen.set(absolute, text)
      const lines = linesOf(text)
      const end = Math.min(lines.length, requests[0].endLine ?? start)
      const from = Math.max(1, Math.min(start, lines.length) - EDIT_CONTEXT_LINES)
      const to = Math.min(lines.length, Math.max(end, from) + EDIT_CONTEXT_LINES)
      throw new ToolInputError(
        `${rel} has not been read since it last changed, so those line numbers may be off. Nothing was changed. Lines ${from}–${to} are now:\n` +
          `${numbered(lines, from, to)}\nCall edit_file again with the right start_line and end_line.`
      )
    }
    const plan = planEdits(text, requests)
    if (typeof plan === "string") {
      // A small model edits a file it has not read, from what it supposes
      // is in it. Telling it to go and read costs a request and often loses
      // it; the lines themselves, there and then, are what it needs.
      if (/find is not in the file/.test(plan) && !/nearest match/.test(plan) && !seen.has(absolute)) {
        const lines = linesOf(text)
        const to = Math.min(lines.length, MAX_UNREAD_SHOWN_LINES)
        seen.set(absolute, text)
        throw new ToolInputError(
          `${rel}: find is not in the file. You have not read ${rel} yet, so here ${to < lines.length ? `are its first ${to} lines (of ${lines.length}; read_file shows the rest)` : "it is"}:\n` +
            `${numbered(lines, 1, to)}\n` +
            "Call edit_file again with find copied from these lines, without the line numbers; or give start_line and end_line with replace to rewrite those lines."
        )
      }
      throw new ToolInputError(`${rel}: ${plan}${/[.\n]$/.test(plan) ? "" : "."}`)
    }
    const lines =
      plan.startLine === plan.endLine ? `${plan.startLine + 1}` : `${plan.startLine + 1}–${plan.endLine + 1}`
    const outcome = await sink.edit(absolute, plan)
    if (!outcome.ok) {
      return { output: outcome.message, summary: `\`${rel}\` not changed · ${outcome.message}`, failed: true }
    }
    const places = plan.count > 1 ? ` · ${plan.count} places` : ""
    if (outcome.pending) {
      return { output: outcome.message, summary: `proposed an edit to \`${rel}:${lines}\`${places}`, final: true }
    }
    const after = afterEdit(text, plan)
    seen.set(absolute, after.text)
    return {
      output: `${outcome.message}${plan.count > 1 ? ` ${plan.count} places changed.` : ""}\n${after.shown}`,
      summary: `edited \`${rel}:${lines}\`${places}${errorsNote(outcome)}`
    }
  }
})

export interface WorkspaceTools {
  tools: Tool[]
  /** A line naming the top-level entries, so the model starts oriented. */
  orientation: string
  /** The root's instructions for agents (`AGENTS.md`), for the system prompt. */
  instructions?: InstructionFile
  /** The instruction files used so far: the root's, then each folder's as a tool reached it. */
  instructionFiles?(): string[]
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
  acts: true,
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
    const printed = outcome.output.trim()
    return {
      failed: outcome.timedOut === "stopped" || (!outcome.timedOut && !!outcome.exitCode),
      output: `$ ${line}\n(${status})\n${printed || "(no output)"}`,
      summary: `ran \`${line}\` · ${outcomeWord}`,
      // The end of what it printed is where a test run or a build says how it went.
      digest: `$ ${line}\n(${status})${printed ? `\n…\n${printed.split("\n").slice(-4).join("\n").slice(-400)}` : ""}`
    }
  }
})

const searchCode = (view: WorkspaceView, index: CodeSearch): Tool => ({
  name: "search_code",
  readOnly: true,
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
  /** Whether the project's `AGENTS.md` files are read; on by default. */
  instructions?: boolean
  /** Tools from MCP servers the user set up, and how to call one. */
  mcp?: McpSink
}

/**
 * Where MCP tools go: the host has the servers running, puts each call to
 * the user as it says, and turns the answer into a result.
 */
export interface McpSink {
  tools: McpToolSpec[]
  call(tool: McpToolSpec, args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult>
}

const mcpTool = (spec: McpToolSpec, sink: McpSink): Tool => ({
  ...spec,
  run: (args, context) => sink.call(spec, coerceArguments(spec.schema as JsonSchema | undefined, args), context)
})

/** Arguments that name a place in the workspace, whose folders' instructions apply. */
const PLACE_ARGUMENTS = ["path", "from", "to"]

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
  /** Each file as the model last saw it, so an edit by line numbers knows whether they still hold. */
  const seen = new Map<string, string>()
  const tools = [
    ...(codeSearch ? [searchCode(view, codeSearch)] : []),
    ...(editor ? [editorContext(view, editor)] : []),
    listDir(view),
    findFiles(view),
    readFile(view, seen),
    grep(view),
    findSymbol(view),
    ...(editor ? [goToDefinition(view, editor), findReferences(view, editor), diagnostics(view, editor)] : []),
    ...(extras.git !== false && insideGitRepository(view.root) ? [git(view)] : [])
  ]
  if (edits) tools.push(editFile(view, edits, seen), createFile(view, edits))
  if (edits && editor) tools.push(renameSymbol(view, editor))
  if (edits?.remove && edits.move) {
    const ops = { remove: edits.remove.bind(edits), move: edits.move.bind(edits) }
    tools.push(moveFile(view, ops), deleteFile(view, ops))
  }
  if (commands) tools.push(runCommand(commands))
  for (const spec of extras.mcp?.tools ?? []) tools.push(mcpTool(spec, extras.mcp!))
  const top = view.entries(view.root).map((e) => (e.dir ? `${e.name}/` : e.name))
  const reading = extras.instructions !== false
  const instructions = reading ? readRootInstructions(view.root) : undefined
  const folders = reading ? new FolderInstructions(view) : undefined
  /** A finished call with the instructions of the folders it reached, the first time the reply reaches them. */
  const withFolderInstructions = (call: ToolCall, result: ToolResult): ToolResult => {
    if (!folders || result.failed) return result
    const found = PLACE_ARGUMENTS.flatMap((name) => (call.args[name] ? folders.for(call.args[name]) : []))
    return found.length ? { ...result, preface: found.map(folderInstructionsNote).join("\n\n") } : result
  }
  return {
    tools,
    orientation: `The workspace root contains: ${top.slice(0, 40).join(", ")}${top.length > 40 ? ", …" : ""}`,
    instructions,
    instructionFiles: () => [...(instructions ? [instructions.path] : []), ...(folders?.given ?? [])],
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
        return withFolderInstructions(call, await tool.run(call.args, context))
      } catch (error) {
        // Whatever goes wrong inside a tool is the model's to read and work
        // around; it never ends the reply. A refusal of the model's input is
        // given whole (it may show the lines to use instead); anything else,
        // and the step's summary, keeps to the first line.
        const full = error instanceof Error ? error.message : String(error)
        const message = full.split("\n")[0]
        return error instanceof ToolInputError
          ? { output: full, summary: `${call.name} failed · ${message}`, failed: true }
          : { output: `${call.name} could not run: ${message}`, summary: `${call.name} failed · ${message}`, failed: true }
      }
    }
  }
}

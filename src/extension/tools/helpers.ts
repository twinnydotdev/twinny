/**
 * Small pure pieces the workspace tools share: matching a glob, finding a
 * symbol in a file so the language server can be asked about it, checking
 * a git command is one that only reads, and naming the few paths an edit
 * must not touch unreviewed.
 */
import { posix as posixPath } from "path"

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * A glob as a regular expression over `/`-separated relative paths: `**`
 * spans folders, `*` and `?` stay within one, `{a,b}` is either. A pattern
 * without a `/` matches the file name anywhere, as .gitignore does.
 */
export const globToRegExp = (glob: string): RegExp => {
  const pattern = glob.trim().replace(/^\.\//, "")
  let source = ""
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        const slash = pattern[i + 2] === "/"
        source += slash ? "(?:.*/)?" : ".*"
        i += slash ? 2 : 1
      } else {
        source += "[^/]*"
      }
    } else if (char === "?") {
      source += "[^/]"
    } else if (char === "{") {
      const end = pattern.indexOf("}", i)
      if (end === -1) {
        source += "\\{"
        continue
      }
      source += `(?:${pattern.slice(i + 1, end).split(",").map(escapeRegex).join("|")})`
      i = end
    } else {
      source += escapeRegex(char)
    }
  }
  return new RegExp(pattern.includes("/") ? `^${source}$` : `(?:^|/)${source}$`)
}

export interface SymbolPosition {
  /** 0-based. */
  line: number
  character: number
}

/**
 * Where `name` appears as a whole word in `text`: on `line` (1-based) when
 * given, or the nearest line to it that has it, else the first line that
 * declares it, else the first mention.
 */
export const locateSymbol = (text: string, name: string, line?: number): SymbolPosition | undefined => {
  const word = new RegExp(`(?<![\\w$])${escapeRegex(name)}(?![\\w$])`)
  const lines = text.split("\n")
  const on = (index: number): SymbolPosition | undefined => {
    const match = lines[index]?.match(word)
    return match?.index === undefined ? undefined : { line: index, character: match.index }
  }
  if (line !== undefined && line >= 1) {
    const wanted = Math.min(line - 1, lines.length - 1)
    for (let distance = 0; distance < lines.length; distance++) {
      const found = on(wanted - distance) ?? on(wanted + distance)
      if (found) return found
    }
    return undefined
  }
  const declaration = new RegExp(
    `\\b(?:function\\*?|class|interface|type|enum|struct|trait|def|fn|func|const|let|var|val)\\s+${escapeRegex(name)}(?![\\w$])`
  )
  const declared = lines.findIndex((l) => declaration.test(l))
  if (declared !== -1) return on(declared)
  for (let index = 0; index < lines.length; index++) {
    const found = on(index)
    if (found) return found
  }
  return undefined
}

/** A command line split into words, quotes respected; no shell is involved. */
export const splitArgs = (line: string): string[] => {
  const args: string[] = []
  let current = ""
  let quote: string | undefined
  let started = false
  for (const char of line.trim()) {
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
    } else if (char === "'" || char === "\"") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started || current) args.push(current)
      current = ""
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (started || current) args.push(current)
  return args
}

/** Git subcommands that only read the repository. */
export const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "blame", "branch", "shortlog", "ls-files", "rev-parse"])

/**
 * Options that write a file, run a program or read one from outside the
 * repository, whatever the subcommand: `--output` writes the diff to a
 * path, `--ext-diff` and `--textconv` run what the configuration names,
 * `--no-index` compares any two paths on the machine, and `--contents`
 * and `--ignore-revs-file` read any file (the second shows its first
 * line in its complaint). The prefix options and `--relative` change the
 * `a/path b/path` headers the ignored-file filter reads, and `--ignored`
 * names what `.gitignore` hides. Git takes any unambiguous start of a
 * long option (`--conten` for `--contents`), so a start of one of these
 * is refused as well.
 */
const UNSAFE_GIT_OPTIONS = [
  "--output",
  "--ext-diff",
  "--textconv",
  "--no-index",
  "--contents",
  "--ignore-revs-file",
  "--no-prefix",
  "--src-prefix",
  "--dst-prefix",
  "--line-prefix",
  "--relative",
  "--ignored"
]

/** Short options that do the same for one subcommand: blame's revisions file, ls-files's ignored files. */
const UNSAFE_GIT_SHORT: Record<string, RegExp> = {
  blame: /^-S/,
  "ls-files": /^-[^-]*i/
}

/** Options of their own whose names a refused one starts with: `diff --text`, `blame --ignore-rev`. */
const SAFE_GIT_OPTIONS = new Set(["--text", "--ignore-rev"])

const unsafeGitOption = (subcommand: string, arg: string): boolean => {
  if (arg.startsWith("--") && arg.length > 2) {
    const name = arg.split("=")[0]
    if (SAFE_GIT_OPTIONS.has(name)) return false
    return UNSAFE_GIT_OPTIONS.some((option) => option === name || (name.length >= 4 && option.startsWith(name)))
  }
  return !!UNSAFE_GIT_SHORT[subcommand]?.test(arg)
}

/** What `git branch` may be asked here: listing, never creating, moving or deleting. */
const BRANCH_LISTING = /^(-a|-r|-v|-vv|-l|--list|--all|--remotes|--verbose|--show-current|--merged|--no-merged|--contains|--sort=.+|--format=.+)$/

/** What a shell would act on; here every word goes to git as it is. */
const SHELL_OPERATOR = /^(\|\|?|&&?|;|>>?|<|2>&1|2>)$/

/**
 * The arguments for a read-only git command, with the options that keep
 * repository settings from running programs added, or why it is refused.
 */
export const readOnlyGitArgs = (line: string): string[] | string => {
  const args = splitArgs(line.replace(/^\s*git\s+/, ""))
  const [subcommand, ...rest] = args
  if (!subcommand) return "git needs a subcommand, e.g. status or diff"
  if (!READ_ONLY_GIT.has(subcommand)) {
    return `git ${subcommand} is not allowed here; this tool only reads (${[...READ_ONLY_GIT].join(", ")}). Use run_command to change anything.`
  }
  if (rest.some((arg) => SHELL_OPERATOR.test(arg))) {
    return "git here runs one command with no shell: no pipes, redirects or &&. Limit the output with git's own options, e.g. -n 5 or --stat"
  }
  const unsafe = rest.find((arg) => unsafeGitOption(subcommand, arg))
  if (unsafe) return `${unsafe.split("=")[0]} is not allowed in git here`
  if (subcommand === "branch" && rest.some((arg) => !BRANCH_LISTING.test(arg))) {
    return "git branch here only lists branches; use run_command to create, rename or delete one"
  }
  const guard = ["diff", "log", "show"].includes(subcommand)
    ? ["--no-ext-diff", "--no-textconv"]
    : subcommand === "blame"
      ? ["--no-textconv"]
      : []
  // Without a revision shortlog reads a log from standard input, which here is empty.
  const tail = subcommand === "shortlog" && !rest.some((arg) => !arg.startsWith("-")) ? ["HEAD"] : []
  return [subcommand, ...guard, ...rest, ...tail]
}

/** A path a git command names; `inRepo` when git reads it from the repository's top (`REV:path`) rather than from where it runs. */
export interface GitNamedPath {
  path: string
  inRepo: boolean
}

/**
 * The paths a git command names outright, for checking against what the
 * workspace may show: `REV:path` objects (show), blame's file, and
 * whatever follows `--`.
 */
export const gitNamedPaths = (args: string[]): GitNamedPath[] => {
  const [subcommand, ...rest] = args
  const split = rest.indexOf("--")
  const before = split === -1 ? rest : rest.slice(0, split)
  const after = split === -1 ? [] : rest.slice(split + 1)
  const named: GitNamedPath[] = after.map((path) => ({ path: tidyGitPath(path), inRepo: false }))
  for (const arg of before) {
    if (arg.startsWith("-")) continue
    // `:0:path`: the file as staged, named from the repository's top.
    const staged = arg.match(/^:[0-3]:(.+)$/)
    const object = staged ? undefined : arg.match(/^[^:]*:(\.\/)?(.+)$/)
    if (staged) named.push({ path: tidyGitPath(staged[1]), inRepo: true })
    else if (object) named.push({ path: tidyGitPath(object[2]), inRepo: !object[1] })
    else if (subcommand === "blame") named.push({ path: tidyGitPath(arg), inRepo: false })
  }
  return named
}

/**
 * Listed paths with the hidden ones taken out: a path per line, or after
 * the tab in `ls-files -s` output.
 */
export const withoutHiddenLines = (
  output: string,
  hidden: (path: string) => boolean
): { text: string; dropped: number } => {
  let dropped = 0
  const kept = output.split("\n").filter((line) => {
    const listed = line.includes("\t") ? line.slice(line.lastIndexOf("\t") + 1) : line
    if (!listed.trim() || !hidden(tidyGitPath(listed.trim()))) return true
    dropped++
    return false
  })
  return { text: kept.join("\n"), dropped }
}

/** A path as git will read it: `/` separators, `.` and `..` worked out, no leading `./`. Pathspec magic is left as written. */
export const tidyGitPath = (raw: string): string => {
  if (raw.startsWith(":")) return raw
  const tidied = posixPath.normalize(raw.replace(/\\/g, "/")).replace(/^(\.\/)+/, "")
  return tidied === "." ? "" : tidied
}

/**
 * A diff with the sections for hidden files taken out. `hidden` is asked
 * about each file a `diff --git a/… b/…` header names; what it rejects is
 * replaced by one line saying so.
 */
export const withoutHiddenDiffs = (
  output: string,
  hidden: (path: string) => boolean
): { text: string; dropped: number } => {
  if (!/^diff --(?:git|cc|combined) /m.test(output)) return { text: output, dropped: 0 }
  let dropped = 0
  const kept = output.split(/^(?=diff --(?:git|cc|combined) )/m).map((section) => {
    const header = section.slice(0, section.indexOf("\n") === -1 ? undefined : section.indexOf("\n"))
    const plain = header.match(/^diff --git a\/(.+?) b\/(.+)$/)
    const merge = header.match(/^diff --(?:cc|combined) (.+)$/)
    const paths = plain ? [plain[1], plain[2]] : merge ? [merge[1]] : []
    if (!paths.some(hidden)) return section
    dropped++
    return `${header}\n(not shown: the file is outside the workspace or ignored by .gitignore)\n`
  })
  return { text: kept.join(""), dropped }
}

/**
 * Files an edit could use to give itself more than the user allowed, so a
 * change to one is always put to the user as a diff: `.vscode/` and
 * `*.code-workspace` (settings and tasks that run on their own),
 * `.gitignore` (what the tools may
 * read) and the project's instructions for agents (`AGENTS.md` and the
 * files read in its place), which the next reply would obey. `relative`
 * uses `/`.
 */
export const isProtectedPath = (relative: string): boolean =>
  // Any case: on macOS and Windows `.VSCode/` is the same folder.
  /(^|\/)\.vscode\//i.test(relative) ||
  /(^|\/)\.gitignore$/i.test(relative) ||
  /(^|\/)AGENTS\.md$/i.test(relative) ||
  // A workspace file holds settings and tasks too.
  /\.code-workspace$/i.test(relative) ||
  /^(CLAUDE\.md|\.github\/copilot-instructions\.md)$/i.test(relative)

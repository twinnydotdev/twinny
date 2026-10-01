/**
 * Small pure pieces the workspace tools share: matching a glob, finding a
 * symbol in a file so the language server can be asked about it, and
 * checking a git command is one that only reads.
 */

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

/** Options that could write a file or run something, whatever the subcommand. */
const UNSAFE_GIT_OPTION = /^(-c|--config-env|--output|--ext-diff|--textconv|--exec-path|--upload-pack|--receive-pack|-C|--git-dir|--work-tree)(=|$)/

/** What `git branch` may be asked here: listing, never creating, moving or deleting. */
const BRANCH_LISTING = /^(-a|-r|-v|-vv|-l|--list|--all|--remotes|--verbose|--show-current|--merged|--no-merged|--contains|--sort=.+|--format=.+)$/

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
  const unsafe = rest.find((arg) => UNSAFE_GIT_OPTION.test(arg))
  if (unsafe) return `${unsafe} is not allowed in git here.`
  if (subcommand === "branch" && rest.some((arg) => !BRANCH_LISTING.test(arg))) {
    return "git branch here only lists branches; use run_command to create, rename or delete one."
  }
  const guard = ["diff", "log", "show"].includes(subcommand)
    ? ["--no-ext-diff", "--no-textconv"]
    : subcommand === "blame"
      ? ["--no-textconv"]
      : []
  return [subcommand, ...guard, ...rest]
}

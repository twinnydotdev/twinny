/**
 * Reading a tool step's output back into its parts, so the chat can show
 * code as code: `read_file`'s numbered lines as a highlighted file, a
 * command's diff as a diff, `edit_file`'s find and replace as the change
 * it makes. Pure, so the parsing is unit-testable; the output formats are
 * the ones `extension/tools/workspace.ts` writes.
 */

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  py: "python", pyi: "python", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", rb: "ruby", php: "php",
  swift: "swift", lua: "lua", pl: "perl", r: "r", scala: "scala", dart: "dart", ex: "elixir", exs: "elixir",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash", ps1: "powershell",
  json: "json", jsonc: "json", json5: "json5", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini",
  md: "markdown", mdx: "markdown", css: "css", scss: "scss", sass: "sass", less: "less",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup", svelte: "markup",
  sql: "sql", graphql: "graphql", gql: "graphql", proto: "protobuf", dockerfile: "docker",
  diff: "diff", patch: "diff"
}

/** The Prism language for a file, or "text". */
export const languageForPath = (path: string): string => {
  const name = path.split("/").pop()?.toLowerCase() ?? ""
  if (name === "dockerfile") return "docker"
  if (name === "makefile") return "makefile"
  const extension = name.includes(".") ? name.split(".").pop() ?? "" : ""
  return EXTENSION_LANGUAGES[extension] ?? "text"
}

export interface FileSlice {
  path: string
  /** 1-based, as `read_file` numbers them. */
  startLine: number
  code: string
  /** What `read_file` said after the lines, e.g. where to read on. */
  note?: string
}

/** `read_file` output: `path (lines a–b of n)`, then `N: line` for each line. */
export const parseReadFile = (output: string): FileSlice | undefined => {
  const [header, ...rest] = output.split("\n")
  const match = header.match(/^(.+) \(lines (\d+)–(\d+) of \d+\)$/)
  if (!match) return undefined
  const code: string[] = []
  let note: string | undefined
  let expected = Number(match[2])
  for (const line of rest) {
    const numbered = line.match(/^(\d+): ?(.*)$/)
    if (numbered && Number(numbered[1]) === expected) {
      code.push(numbered[2])
      expected++
    } else if (line.startsWith("… ")) {
      note = line.slice(2)
    }
  }
  // A file's final newline reads as an empty last line; it is not code.
  while (code.length > 1 && !code[code.length - 1].trim()) code.pop()
  return { path: match[1], startLine: Number(match[2]), code: code.join("\n"), note }
}

export interface CommandRun {
  command: string
  /** "exit code 0", "still running…". */
  status: string
  output: string
  /** The output is a unified diff (git diff, git show, diff -u). */
  isDiff: boolean
}

/** `run_command` output: `$ command`, `(status)`, then what it printed. */
export const parseCommandRun = (output: string): CommandRun | undefined => {
  const match = output.match(/^\$ (.*)\n\(([^)\n]*)\)\n?([\s\S]*)$/)
  if (!match) return undefined
  const printed = match[3]
  return {
    command: match[1],
    status: match[2],
    output: printed,
    isDiff: /^(diff --git |--- a\/|\+\+\+ b\/|@@ -\d)/m.test(printed)
  }
}

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context"

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

/** Each line of a unified diff with what it is. */
export const classifyDiff = (diff: string): DiffLine[] =>
  diff.replace(/\n$/, "").split("\n").map((text) => {
    if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(text)) {
      return { kind: "meta", text }
    }
    if (text.startsWith("@@")) return { kind: "hunk", text }
    if (text.startsWith("+")) return { kind: "add", text }
    if (text.startsWith("-")) return { kind: "del", text }
    return { kind: "context", text }
  })

/** `edit_file`'s find and replace as the lines it takes out and puts in. */
export const replacementDiff = (find: string, replace: string): DiffLine[] => [
  ...find.replace(/\n$/, "").split("\n").map((text) => ({ kind: "del" as const, text: `-${text}` })),
  ...replace.replace(/\n$/, "").split("\n").map((text) => ({ kind: "add" as const, text: `+${text}` }))
]

export interface CodeHitBlock {
  path: string
  /** 1-based. */
  startLine: number
  endLine: number
  relevance: string
  code?: string
}

/** `search_code` output: blocks of `path:a-b (relevance x)` and the code under it. */
export const parseSearchHits = (output: string): CodeHitBlock[] => {
  const blocks: CodeHitBlock[] = []
  const header = /^(.+):(\d+)-(\d+) \(relevance ([\d.]+)\)$/
  for (const line of output.split("\n")) {
    const match = line.match(header)
    if (match) {
      blocks.push({ path: match[1], startLine: Number(match[2]), endLine: Number(match[3]), relevance: match[4], code: "" })
    } else if (blocks.length) {
      const block = blocks[blocks.length - 1]
      block.code = block.code ? `${block.code}\n${line}` : line
    }
  }
  return blocks.map((block) => {
    const code = block.code?.replace(/\n+$/, "")
    return { ...block, code: !code || code.startsWith("… (not shown") ? undefined : code }
  })
}

export interface LocatedLine {
  path: string
  /** 1-based. */
  line: number
  text: string
}

/** `grep` and `find_symbol` output: `path:line: text` per line. */
export const parseLocatedLines = (output: string): LocatedLine[] | undefined => {
  const lines = output.split("\n").filter((line) => line.trim())
  const parsed = lines.map((line) => line.match(/^([^:\n]+):(\d+): (.*)$/))
  const matched = parsed.filter((match): match is RegExpMatchArray => !!match)
  if (!matched.length) return undefined
  return matched.map((match) => ({ path: match[1], line: Number(match[2]), text: match[3] }))
}

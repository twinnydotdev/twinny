/**
 * Making sense of what a shell printed. Pure: no vscode, no filesystem, so
 * the parsing is unit-testable.
 */

export interface TerminalRun {
  /** What the user typed, as shell integration reported it. */
  commandLine: string
  /** Captured stdout and stderr, ANSI stripped. */
  output: string
  /** Undefined when the shell never reported one. */
  exitCode: number | undefined
  /** Working directory at the time, when known. */
  cwd?: string
  /** Name of the terminal the command ran in. */
  terminal: string
  /** Epoch ms when the command finished. */
  finishedAt: number
}

/** A file location a tool printed: `src/a.ts:12:5`, `at fn (src/a.ts:12:5)`. */
export interface FileLocation {
  path: string
  line: number
  column?: number
}

/** Output beyond this is cut from the front; the failure is at the end. */
export const MAX_OUTPUT_CHARS = 12000
export const MAX_OUTPUT_LINES = 200

// CSI sequences, OSC sequences (terminated by BEL or ST), charset selects,
// and carriage returns from progress bars.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g

export const stripAnsi = (text: string): string => text.replace(ANSI, "")

/**
 * The tail of an output, since that is where the error is. Cut at a line
 * boundary and say how much went missing.
 */
export const tailOutput = (
  output: string,
  { maxChars = MAX_OUTPUT_CHARS, maxLines = MAX_OUTPUT_LINES } = {}
): string => {
  const lines = stripAnsi(output).replace(/\s+$/, "").split("\n")
  let kept = lines.slice(-maxLines)
  let text = kept.join("\n")
  while (text.length > maxChars && kept.length > 1) {
    kept = kept.slice(Math.ceil(kept.length / 4))
    text = kept.join("\n")
  }
  if (text.length > maxChars) text = text.slice(-maxChars)
  const dropped = lines.length - kept.length
  return dropped > 0 ? `[${dropped} earlier lines not shown]\n${text}` : text
}

const LOCATION_PATTERNS = [
  // path:line:col or path:line, optionally in parentheses (stack traces)
  /(?:^|[\s("'`[])((?:[A-Za-z]:)?[^\s:"'`()[\]]+?\.[A-Za-z0-9]{1,10}):(\d+)(?::(\d+))?(?=[\s:)"'`\],]|$)/gm,
  // path(line,col): tsc's style
  /(?:^|[\s("'`])((?:[A-Za-z]:)?[^\s:"'`()]+?\.[A-Za-z0-9]{1,10})\((\d+),(\d+)\)/gm,
  // File "path", line N: Python tracebacks
  /File "([^"]+)", line (\d+)/g
]

const NOT_CODE = /^(https?:|file:|node:|internal\/)/i
const LIBRARY = /(^|[\\/])(node_modules|site-packages|\.venv|venv|dist|out|build)[\\/]/

/**
 * File references in an output, in order of appearance, deduplicated. Paths
 * under dependency and build folders are dropped: the fix is never there.
 */
export const extractFileLocations = (output: string): FileLocation[] => {
  const found: FileLocation[] = []
  const seen = new Set<string>()
  const text = stripAnsi(output)
  for (const pattern of LOCATION_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const path = match[1].replace(/^\.\//, "")
      if (NOT_CODE.test(path) || LIBRARY.test(path) || path.startsWith("<")) {
        continue
      }
      const line = Number(match[2])
      if (!line) continue
      const column = match[3] ? Number(match[3]) : undefined
      const key = `${path}:${line}`
      if (seen.has(key)) continue
      seen.add(key)
      found.push({ path, line, column })
    }
  }
  return found
}

/** Did this run fail, as far as we can tell? */
export const runFailed = (run: TerminalRun): boolean =>
  run.exitCode !== undefined
    ? run.exitCode !== 0
    : /\b(error|exception|traceback|failed|fatal|panic)\b/i.test(run.output)

/** The block an `@terminal` mention puts in the prompt. */
export const formatTerminalRun = (run: TerminalRun): string => {
  const status =
    run.exitCode === undefined
      ? ""
      : run.exitCode === 0
        ? " (exit code 0)"
        : ` (failed with exit code ${run.exitCode})`
  const output = tailOutput(run.output)
  return [
    `Terminal command${status}${run.cwd ? ` in ${run.cwd}` : ""}:`,
    "```",
    run.commandLine.trim() || "(unknown command)",
    "```",
    "Output:",
    "```",
    output.trim() || "(no output)",
    "```"
  ].join("\n")
}

/**
 * A model asked for a shell command still tends to explain itself. Take
 * the first fenced block if there is one, else the first line that looks
 * like a command, and strip a leading prompt marker.
 */
export const extractShellCommand = (reply: string): string => {
  const text = reply.trim()
  const fence = /```[a-zA-Z]*\n([\s\S]*?)\n?```/.exec(text)
  const candidate = (fence ? fence[1] : text)
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line && !line.startsWith("#") && !/^[A-Za-z][^`]*:$/.test(line)
    )[0]
  if (!candidate) return ""
  return candidate
    .replace(/^\$\s+/, "")
    .replace(/^`(.*)`$/, "$1")
    .trim()
}

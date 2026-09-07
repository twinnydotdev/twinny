/**
 * Turns a unified diff into something a model can review in pieces.
 *
 * Pure: no vscode or git here. The service fetches the diff; this module
 * parses it per file, drops noise (lockfiles, minified bundles, binaries),
 * trims oversized files, splits what is left into request-sized parts and
 * writes the summary shown in the chat instead of the raw diff.
 */

export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed"

export interface DiffFile {
  /** Path after the change (the old path for deletions). */
  path: string
  oldPath?: string
  status: DiffFileStatus
  binary: boolean
  additions: number
  deletions: number
  /** This file's section of the diff, header and hunks. */
  text: string
  /** Set when hunks were dropped to fit the per-file budget. */
  truncated?: boolean
}

export interface SkippedFile {
  file: DiffFile
  reason: string
}

export interface ReviewBudget {
  /** Characters of diff per model request. */
  maxCharsPerRequest: number
  /** Characters kept of a single file before its later hunks are dropped. */
  maxFileChars: number
  /** Upper bound on requests for one review. */
  maxParts: number
}

export interface ReviewPlan {
  parts: DiffFile[][]
  skipped: SkippedFile[]
  /** Reviewable files that did not fit within `maxParts`. */
  unreviewed: DiffFile[]
  totalAdditions: number
  totalDeletions: number
}

export const DEFAULT_REVIEW_BUDGET: ReviewBudget = {
  maxCharsPerRequest: 16000,
  maxFileChars: 8000,
  maxParts: 8
}

/* -------------------------------------------------------------------------- */
/*  Parsing                                                                    */
/* -------------------------------------------------------------------------- */

const stripPrefix = (p: string) => p.replace(/^[ab]\//, "")

const pathsFromHeader = (line: string): [string, string] | undefined => {
  // diff --git a/old b/new  (paths with spaces are rare; quoted ones rarer)
  const match = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line)
  return match ? [match[1], match[2]] : undefined
}

export const parseUnifiedDiff = (diff: string): DiffFile[] => {
  const files: DiffFile[] = []
  const lines = diff.split("\n")
  let current: DiffFile | undefined
  let buffer: string[] = []

  const flush = () => {
    if (!current) return
    current.text = buffer.join("\n").trimEnd()
    files.push(current)
    current = undefined
    buffer = []
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush()
      const paths = pathsFromHeader(line)
      current = {
        path: paths ? paths[1] : line.slice("diff --git ".length),
        oldPath: paths && paths[0] !== paths[1] ? paths[0] : undefined,
        status: "modified",
        binary: false,
        additions: 0,
        deletions: 0,
        text: ""
      }
      buffer.push(line)
      continue
    }

    if (!current) continue
    buffer.push(line)

    if (line.startsWith("new file mode")) current.status = "added"
    else if (line.startsWith("deleted file mode")) current.status = "deleted"
    else if (line.startsWith("rename from ")) {
      current.status = "renamed"
      current.oldPath = line.slice("rename from ".length)
    } else if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length)
    } else if (line.startsWith("Binary files") || line === "GIT binary patch") {
      current.binary = true
    } else if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim()
      if (target !== "/dev/null") current.path = stripPrefix(target)
    } else if (line.startsWith("--- ")) {
      const source = line.slice(4).trim()
      if (source !== "/dev/null" && current.status === "deleted") {
        current.path = stripPrefix(source)
      }
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions++
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions++
    }
  }

  flush()
  return files
}

/* -------------------------------------------------------------------------- */
/*  Noise                                                                      */
/* -------------------------------------------------------------------------- */

const NOISE_RULES: [RegExp, string][] = [
  [
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|go\.sum|flake\.lock|packages\.lock\.json)$/i,
    "lockfile"
  ],
  [/\.min\.(js|css|mjs)$/i, "minified"],
  [/\.(js|css)\.map$/i, "source map"],
  [/(^|\/)__snapshots__\/|\.snap$/i, "test snapshot"],
  [/(^|\/)(node_modules|vendor|dist|build|out|\.next|target)\//i, "build output"],
  [
    /\.(png|jpe?g|gif|webp|ico|bmp|svg|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|jar|wasm|mp[34]|mov|dylib|so|dll|exe)$/i,
    "asset"
  ]
]

/** Why a file is not worth the model's attention, or undefined if it is. */
export const noiseReason = (file: DiffFile): string | undefined => {
  if (file.binary) return "binary"
  for (const [pattern, reason] of NOISE_RULES) {
    if (pattern.test(file.path)) return reason
  }
  // A file that only appears in the diff with no hunks (mode change, empty).
  if (!file.text.includes("\n@@")) return "no content changes"
  return undefined
}

/* -------------------------------------------------------------------------- */
/*  Planning                                                                   */
/* -------------------------------------------------------------------------- */

/** Keep whole hunks up to the budget; say how many lines were dropped. */
export const truncateFileDiff = (file: DiffFile, maxChars: number): DiffFile => {
  if (file.text.length <= maxChars) return file
  const firstHunk = file.text.indexOf("\n@@ ")
  if (firstHunk === -1) return file

  let cutAt = file.text.slice(0, maxChars).lastIndexOf("\n@@ ")
  if (cutAt <= firstHunk) {
    // The first hunk alone is over budget: keep it whole anyway.
    cutAt = file.text.indexOf("\n@@ ", firstHunk + 1)
    if (cutAt === -1) return file
  }
  const kept = file.text.slice(0, cutAt).trimEnd()
  const droppedLines = file.text.slice(kept.length).split("\n").length - 1
  return {
    ...file,
    truncated: true,
    text: `${kept}\n[... ${droppedLines} more lines of this file's diff omitted]`
  }
}

export const planReview = (
  files: DiffFile[],
  budget: ReviewBudget = DEFAULT_REVIEW_BUDGET
): ReviewPlan => {
  const skipped: SkippedFile[] = []
  const reviewable: DiffFile[] = []

  for (const file of files) {
    const reason = noiseReason(file)
    if (reason) skipped.push({ file, reason })
    else reviewable.push(truncateFileDiff(file, budget.maxFileChars))
  }

  const parts: DiffFile[][] = []
  const unreviewed: DiffFile[] = []
  let part: DiffFile[] = []
  let partChars = 0

  for (const file of reviewable) {
    const size = file.text.length + 1
    if (part.length && partChars + size > budget.maxCharsPerRequest) {
      parts.push(part)
      part = []
      partChars = 0
    }
    if (parts.length >= budget.maxParts) {
      unreviewed.push(file)
      continue
    }
    part.push(file)
    partChars += size
  }
  if (part.length) {
    if (parts.length >= budget.maxParts) unreviewed.push(...part)
    else parts.push(part)
  }

  return {
    parts,
    skipped,
    unreviewed,
    totalAdditions: files.reduce((sum, f) => sum + f.additions, 0),
    totalDeletions: files.reduce((sum, f) => sum + f.deletions, 0)
  }
}

/** The diff text sent to the model for one part. */
export const formatPartDiff = (part: DiffFile[]): string =>
  part.map((file) => file.text).join("\n")

/* -------------------------------------------------------------------------- */
/*  Summary shown in the chat                                                  */
/* -------------------------------------------------------------------------- */

const MAX_TABLE_ROWS = 40

const code = (text: string) => `\`${text.replace(/`/g, "")}\``

const describeStatus = (file: DiffFile): string => {
  if (file.status === "renamed" && file.oldPath) {
    return `renamed from ${code(file.oldPath)}`
  }
  return file.status
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/**
 * The message that stands in for the diff in the chat: what is being
 * reviewed, how big it is, and which files were left out and why.
 */
export const summarizeReview = (
  title: string,
  files: DiffFile[],
  plan: ReviewPlan
): string => {
  const lines: string[] = [`**Code review: ${title}**`, ""]

  const reviewedCount = plan.parts.reduce((sum, part) => sum + part.length, 0)
  const partsNote =
    plan.parts.length > 1 ? `, reviewed in ${plan.parts.length} parts` : ""
  lines.push(
    `${plural(files.length, "file")} changed, +${plan.totalAdditions} −${
      plan.totalDeletions
    }${partsNote}`,
    ""
  )

  if (reviewedCount) {
    lines.push("| File | Status | Changes |", "|---|---|---|")
    const rows = plan.parts.flat()
    for (const file of rows.slice(0, MAX_TABLE_ROWS)) {
      const note = file.truncated ? " (trimmed)" : ""
      lines.push(
        `| ${code(file.path)} | ${describeStatus(file)} | +${file.additions} −${
          file.deletions
        }${note} |`
      )
    }
    if (rows.length > MAX_TABLE_ROWS) {
      lines.push(`| … | and ${rows.length - MAX_TABLE_ROWS} more | |`)
    }
    lines.push("")
  }

  if (plan.skipped.length) {
    const items = plan.skipped
      .slice(0, 12)
      .map(({ file, reason }) => `${code(file.path)} (${reason})`)
    const more =
      plan.skipped.length > 12 ? `, and ${plan.skipped.length - 12} more` : ""
    lines.push(`_Skipped: ${items.join(", ")}${more}_`, "")
  }

  if (plan.unreviewed.length) {
    const items = plan.unreviewed.slice(0, 12).map((file) => code(file.path))
    const more =
      plan.unreviewed.length > 12
        ? `, and ${plan.unreviewed.length - 12} more`
        : ""
    lines.push(
      `_Not reviewed (too large for one review): ${items.join(", ")}${more}_`,
      ""
    )
  }

  return lines.join("\n").trim()
}

/** Heading placed at the top of each streamed part when there are several. */
export const partHeading = (index: number, total: number, part: DiffFile[]) => {
  if (total <= 1) return ""
  const names = part.map((file) => code(file.path))
  const shown = names.slice(0, 6).join(", ")
  const more = names.length > 6 ? `, +${names.length - 6} more` : ""
  return `**Part ${index + 1} of ${total}** · ${shown}${more}\n\n`
}

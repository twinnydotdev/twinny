import { supportedLanguages } from "../../common/languages"

/**
 * One piece of code the user attached to a chat message: a whole file, or a
 * line range from one. Pure data so the formatting is unit-testable; reading
 * the files happens in the chat service.
 */
export interface ContextEntry {
  /** Workspace-relative path, shown to the model. */
  path: string
  content: string
  /** Zero-based, inclusive; absent for whole files. */
  range?: { startLine: number; endLine: number }
}

export interface ContextBudget {
  /** Characters kept per entry before it is cut with a note. */
  maxEntryChars: number
  /** Characters across all entries; later entries are dropped past this. */
  maxTotalChars: number
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxEntryChars: 60000,
  maxTotalChars: 160000
}

const EXTENSION_TO_LANGUAGE: Record<string, string> = Object.entries(
  supportedLanguages
).reduce<Record<string, string>>((acc, [languageId, details]) => {
  for (const extension of details.fileExtensions) {
    if (!(extension in acc)) acc[extension] = languageId
  }
  return acc
}, {})

/**
 * Paths reach the chat in two shapes: the @mention picker lists files as
 * `/src/a.ts` (workspace-relative with a leading slash) while pinned items use
 * `src/a.ts`. Strip the leading separators so both mean the same file and
 * dedupe against each other. A path that is genuinely absolute (a file
 * outside the workspace) is returned untouched.
 */
export const normalizeWorkspacePath = (filePath: string): string => {
  const trimmed = filePath.trim()
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed
  return trimmed.replace(/^[\\/]+/, "")
}

/** Markdown fence hint for a path, so the model knows what it is reading. */
export const languageForPath = (filePath: string): string => {
  const dot = filePath.lastIndexOf(".")
  if (dot === -1) return ""
  return EXTENSION_TO_LANGUAGE[filePath.slice(dot).toLowerCase()] || ""
}

const entryKey = (entry: ContextEntry) =>
  entry.range
    ? `${entry.path}:${entry.range.startLine}-${entry.range.endLine}`
    : entry.path

/**
 * The same file can arrive twice (an @mention and a pinned item), and a
 * pinned selection is redundant once its whole file is attached.
 */
export const dedupeContextEntries = (
  entries: ContextEntry[]
): ContextEntry[] => {
  const wholeFiles = new Set(
    entries.filter((entry) => !entry.range).map((entry) => entry.path)
  )
  const seen = new Set<string>()
  return entries.filter((entry) => {
    if (entry.range && wholeFiles.has(entry.path)) return false
    const key = entryKey(entry)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const fence = (content: string) => {
  // Pick a fence longer than any run of backticks inside the content.
  const longest = Math.max(
    2,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length)
  )
  return "`".repeat(longest + 1)
}

const formatEntry = (entry: ContextEntry, content: string): string => {
  const language = languageForPath(entry.path)
  const heading = entry.range
    ? `Selection from ${entry.path} (lines ${entry.range.startLine + 1}-${
        entry.range.endLine + 1
      })`
    : `File: ${entry.path}`
  const ticks = fence(content)
  return `${heading}\n${ticks}${language}\n${content}\n${ticks}`
}

/**
 * Render attached code for the prompt. Each entry gets a heading and a fenced
 * block so the model can tell where one file ends and the next begins.
 */
export const formatContextEntries = (
  entries: ContextEntry[],
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET
): string => {
  const blocks: string[] = []
  let remaining = budget.maxTotalChars
  let dropped = 0

  for (const entry of dedupeContextEntries(entries)) {
    if (!entry.content.trim()) continue

    const limit = Math.min(budget.maxEntryChars, remaining)
    if (limit <= 0) {
      dropped++
      continue
    }

    const kept = Math.min(entry.content.length, limit)
    let content = entry.content
    if (kept < content.length) {
      content =
        content.slice(0, kept) +
        `\n[truncated: ${entry.content.length - kept} more characters not shown]`
    }

    blocks.push(formatEntry(entry, content))
    remaining -= kept
  }

  if (dropped > 0) {
    blocks.push(
      `[${dropped} more attached ${
        dropped === 1 ? "file was" : "files were"
      } left out to fit the context window]`
    )
  }

  return blocks.join("\n\n")
}

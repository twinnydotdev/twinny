/**
 * Where a proposed search-and-replace lands in a file. Pure: the chat's
 * `propose_edit` tool plans the change here and hands the result to the
 * editor's diff review, so nothing is written until the user accepts.
 *
 * Models copy `find` from what `read_file` showed them, so the line-number
 * prefixes it adds are dropped, and when the exact text is not there a
 * match that ignores indentation and trailing spaces is tried before
 * giving up. `read_file` also cuts very long lines short with "…", so a
 * line ending that way matches the full line it came from, and in the
 * replacement it stands for that line unchanged. A `find` that matches
 * more than once is refused rather than guessed at.
 */
import { matchIndentation } from "../edit/prompt"

/** Whole lines `start`–`end` (0-based, inclusive) become `text`. */
export interface Replacement {
  startLine: number
  endLine: number
  /** What the lines were, for the diff. */
  original: string
  text: string
}

const NUMBERED = /^\s*\d+: ?/

/** `read_file` output pasted back in: every non-blank line numbered. */
const withoutLineNumbers = (text: string) => {
  const lines = text.split("\n")
  const filled = lines.filter((line) => line.trim())
  if (!filled.length || !filled.every((line) => NUMBERED.test(line))) return text
  return lines.map((line) => line.replace(NUMBERED, "")).join("\n")
}

const trimBlankEdges = (text: string) =>
  text.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "")

const occurrences = (haystack: string, needle: string) => {
  const found: number[] = []
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    found.push(at)
  }
  return found
}

const ELLIPSIS = "…"

/** A line of `find` against a line of the file, whitespace around them aside; a cut-short line matches by its start. */
const sameLine = (fileLine: string, wanted: string) => {
  const have = fileLine.trim()
  const want = wanted.trim()
  if (!want.endsWith(ELLIPSIS)) return have === want
  const start = want.slice(0, -ELLIPSIS.length)
  return have.length > start.length && have.startsWith(start)
}

/** Lines of `lines` where `wanted` starts, comparing each line without its surrounding whitespace. */
const looseMatches = (lines: string[], wanted: string[]) => {
  const found: number[] = []
  for (let start = 0; start + wanted.length <= lines.length; start++) {
    if (wanted.every((line, i) => sameLine(lines[start + i], line))) found.push(start)
  }
  return found
}

/** Cut-short lines in `replace` put back as the original lines they stand for, or undefined if one stands for none. */
const restoreCutLines = (replace: string, original: string[]): string | undefined => {
  const lines = replace.split("\n")
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().endsWith(ELLIPSIS)) continue
    const full = original.find((line) => sameLine(line, lines[i]))
    if (full === undefined) return undefined
    lines[i] = (lines[i].match(/^\s*/)?.[0] ?? "") + full.trim()
  }
  return lines.join("\n")
}

const CUT_LINE_REFUSAL =
  "replace has a line cut short with … that is not in find; leave long lines you do not change out of find and replace"

/**
 * The lines to rewrite for replacing `find` with `replace` in `content`,
 * or why it cannot be done, worded for the model to fix its next call.
 */
export const planReplacement = (
  content: string,
  rawFind: string,
  rawReplace: string
): Replacement | string => {
  const text = content.replace(/\r\n/g, "\n")
  const lines = text.split("\n")
  const find = trimBlankEdges(withoutLineNumbers(rawFind.replace(/\r\n/g, "\n")))
  const replace = withoutLineNumbers(rawReplace.replace(/\r\n/g, "\n")).replace(/\n+$/, "")
  if (!find.trim()) return "find is empty; it must be text already in the file"

  const exact = occurrences(text, find)
  if (exact.length > 1) {
    return `find matches ${exact.length} places; include more of the surrounding lines so it matches once`
  }
  if (exact.length === 1) {
    const start = exact[0]
    const startLine = text.slice(0, start).split("\n").length - 1
    const endLine = startLine + find.split("\n").length - 1
    const originalLines = lines.slice(startLine, endLine + 1)
    const original = originalLines.join("\n")
    const restored = restoreCutLines(replace, originalLines)
    if (restored === undefined) return CUT_LINE_REFUSAL
    const column = start - (text.lastIndexOf("\n", start - 1) + 1)
    const edited = original.slice(0, column) + restored + original.slice(column + find.length)
    if (edited === original) return "replace is the same as find; nothing would change"
    return { startLine, endLine, original, text: edited }
  }

  const wanted = find.split("\n")
  const loose = looseMatches(lines, wanted)
  if (loose.length > 1) {
    return `find matches ${loose.length} places; include more of the surrounding lines so it matches once`
  }
  if (!loose.length) {
    return "find is not in the file; read the lines again and copy them exactly, without the line numbers"
  }
  const startLine = loose[0]
  const endLine = startLine + wanted.length - 1
  const originalLines = lines.slice(startLine, endLine + 1)
  const original = originalLines.join("\n")
  const restored = restoreCutLines(replace, originalLines)
  if (restored === undefined) return CUT_LINE_REFUSAL
  const edited = matchIndentation(restored, original)
  if (edited === original) return "replace is the same as find; nothing would change"
  return { startLine, endLine, original, text: edited }
}

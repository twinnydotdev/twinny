/**
 * Where a search-and-replace lands in a file. Pure: the chat's `edit_file`
 * tool plans the change here and hands the result to the editor, which
 * applies it or shows it for review.
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

/**
 * `read_file` output pasted back in: every non-blank line numbered, the
 * numbers rising as `read_file` writes them (a model sometimes drops one
 * on a blank line). Anything else that starts `404: ` is the code itself
 * (a status map, YAML) and is kept.
 */
const withoutLineNumbers = (text: string) => {
  const lines = text.split("\n")
  const filled = lines.filter((line) => line.trim())
  if (!filled.length || !filled.every((line) => NUMBERED.test(line))) return text
  const numbers = filled.map((line) => Number.parseInt(line.trim(), 10))
  if (numbers.some((number, i) => i > 0 && number <= numbers[i - 1])) return text
  return lines.map((line) => line.replace(NUMBERED, "")).join("\n")
}

/** Whether any line of `text` starts the way `read_file` numbers lines. */
const looksNumbered = (text: string) => text.split("\n").some((line) => NUMBERED.test(line))

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

/** Whether `find` is in the file at all, exactly or line by line with whitespace aside. */
const inText = (text: string, lines: string[], find: string) =>
  !!find.trim() && (text.includes(find) || looseMatches(lines, find.split("\n")).length > 0)

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

const NOT_FOUND = "find is not in the file; read the lines again and copy them exactly, without the line numbers"

/** Small models put new code in find; this is what they need to hear instead. */
const TO_ADD =
  "To add new code rather than change what is there, put the existing lines it goes next to in find, and those same lines with the new code in replace."

/** Lines of `find` scored when looking for the nearest match; a file this long is not searched for one. */
const MAX_HINT_FIND_LINES = 12
const MAX_HINT_FILE_LINES = 20_000
/** How alike, on average, the nearest lines must be to `find` to be worth showing. */
const MIN_LIKENESS = 0.6
const MAX_HINT_LINE_CHARS = 200

/** A line's character pairs, whitespace around it aside, counted: for a cheap measure of likeness. */
const pairsOf = (line: string) => {
  const text = line.trim()
  const pairs = new Map<string, number>()
  for (let i = 0; i < text.length - 1; i++) {
    const pair = text.slice(i, i + 2)
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1)
  }
  return { text, pairs, size: Math.max(0, text.length - 1) }
}

/** How alike two lines are, from 0 to 1: the share of character pairs they have in common. */
const likeness = (a: ReturnType<typeof pairsOf>, b: ReturnType<typeof pairsOf>) => {
  if (a.text === b.text) return 1
  if (!a.size || !b.size) return 0
  const [small, large] = a.pairs.size <= b.pairs.size ? [a, b] : [b, a]
  let shared = 0
  for (const [pair, count] of small.pairs) shared += Math.min(count, large.pairs.get(pair) ?? 0)
  return (2 * shared) / (a.size + b.size)
}

const clipped = (line: string) => (line.length > MAX_HINT_LINE_CHARS ? `${line.slice(0, MAX_HINT_LINE_CHARS)}…` : line)

const hintLine = (number: number, line: string) => `${number}: ${clipped(line)}`

/**
 * Where the file comes closest to `find`, as the refusal tells the model:
 * the lines as they are now, numbered as `read_file` numbers them, and the
 * first one that differs. A model's `find` usually misses by a line it
 * remembered wrong or the file changed under it, and this saves it reading
 * the file again. Undefined when nothing is near enough to help.
 */
const nearestLines = (lines: string[], wanted: string[]): string | undefined => {
  const compared = wanted.slice(0, MAX_HINT_FIND_LINES)
  if (lines.length > MAX_HINT_FILE_LINES || wanted.length > lines.length) return undefined
  const want = compared.map(pairsOf)
  const filled = want.filter((line) => line.text)
  if (!filled.length) return undefined
  const have = lines.map(pairsOf)
  let best = { start: -1, score: 0 }
  for (let start = 0; start + wanted.length <= lines.length; start++) {
    let total = 0
    for (let i = 0; i < compared.length; i++) {
      if (want[i].text) total += likeness(have[start + i], want[i])
    }
    const score = total / filled.length
    if (score > best.score) best = { start, score }
  }
  if (best.start < 0 || best.score < MIN_LIKENESS) return undefined
  const { start } = best
  const end = start + wanted.length - 1
  // A slip is a line or two remembered wrong. Where many lines differ, the
  // block is something else that looks alike (a sibling function, often the
  // new code the model meant to add), and pointing at it invites an edit there.
  const different = wanted.filter((line, i) => line.trim() && !sameLine(lines[start + i], line)).length
  if (different > Math.max(1, Math.floor(filled.length / 3))) return undefined
  const differs = wanted.findIndex((line, i) => !sameLine(lines[start + i], line))
  const where =
    differs === -1
      ? ""
      : `, where line ${start + differs + 1} is \`${clipped(lines[start + differs].trim())}\` but find has \`${clipped(wanted[differs].trim())}\``
  const shown = lines
    .slice(Math.max(0, start - 1), Math.min(lines.length, end + 2))
    .map((line, i) => hintLine(Math.max(0, start - 1) + i + 1, line))
  const span = start === end ? `line ${start + 1}` : `lines ${start + 1}–${end + 1}`
  return `The nearest match is ${span}${where}. As they are now:\n${shown.join("\n")}`
}

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
  // `find` as written comes first: what looks like a line number may be
  // the code (`404: "Missing"`). Numbers are dropped only when the text as
  // written is not there; from `replace`, when they were from `find`, or
  // when `find` has none (pasted output in `replace` alone).
  const asWritten = trimBlankEdges(rawFind.replace(/\r\n/g, "\n"))
  const unnumbered = trimBlankEdges(withoutLineNumbers(rawFind.replace(/\r\n/g, "\n")))
  const numbered = unnumbered !== asWritten && !inText(text, lines, asWritten)
  const find = numbered ? unnumbered : asWritten
  const replaceText = rawReplace.replace(/\r\n/g, "\n")
  const stripReplace = numbered || !looksNumbered(asWritten)
  const replace = (stripReplace ? withoutLineNumbers(replaceText) : replaceText).replace(/\n+$/, "")
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
    const nearest = nearestLines(lines, wanted)
    return nearest
      ? `find is not in the file. ${nearest}\nCopy the lines exactly as they are, without the line numbers. ${TO_ADD}`
      : `${NOT_FOUND}. ${TO_ADD}`
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

/** One change to a file, as `edit_file` takes it: by its text, everywhere that text is, or by its lines. */
export interface EditRequest {
  find?: string
  replace: string
  /** Every place `find` is, rather than the one. */
  all?: boolean
  /** Lines to rewrite, from 1 and inclusive, in place of `find`. */
  startLine?: number
  endLine?: number
}

/** Lines `start`–`end` (from 1, inclusive) rewritten as `rawReplace`; nothing for `rawReplace` removes them. */
export const planLines = (content: string, start: number, end: number, rawReplace: string): Replacement | string => {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return "start_line and end_line must be line numbers from read_file, with end_line not before start_line"
  }
  if (end > lines.length) return `the file has only ${lines.length} lines`
  const original = lines.slice(start - 1, end).join("\n")
  const text = withoutLineNumbers(rawReplace.replace(/\r\n/g, "\n")).replace(/\n+$/, "")
  if (text === original) return "replace is the same as those lines; nothing would change"
  return { startLine: start - 1, endLine: end - 1, original, text }
}

/** `text` with every place `find` is replaced, and how many there were: exact text first, then whole lines with whitespace aside. */
const replaceEvery = (text: string, find: string, replace: string): { text: string; count: number } => {
  const exact = text.split(find)
  if (exact.length > 1) return { text: exact.join(replace), count: exact.length - 1 }
  const lines = text.split("\n")
  const wanted = find.split("\n")
  const out: string[] = []
  let count = 0
  for (let i = 0; i < lines.length; ) {
    if (i + wanted.length <= lines.length && wanted.every((line, j) => sameLine(lines[i + j], line))) {
      out.push(matchIndentation(replace, lines.slice(i, i + wanted.length).join("\n")))
      i += wanted.length
      count++
    } else {
      out.push(lines[i++])
    }
  }
  return { text: out.join("\n"), count }
}

const withLines = (text: string, plan: Replacement) => {
  const lines = text.split("\n")
  lines.splice(plan.startLine, plan.endLine - plan.startLine + 1, ...(plan.text === "" ? [] : plan.text.split("\n")))
  return lines.join("\n")
}

/**
 * Several changes to one file as the single stretch of lines they come
 * to, made in order, each against the file as the ones before left it.
 * All or nothing: one that cannot be made refuses the lot, saying which.
 * `count` is how many places changed.
 */
export const planEdits = (content: string, edits: EditRequest[]): (Replacement & { count: number }) | string => {
  const before = content.replace(/\r\n/g, "\n")
  if (!edits.length) return "there were no edits to make"
  // One change by its text keeps the plan as it always was: the lines `find` covers.
  if (edits.length === 1 && !edits[0].all) {
    const [only] = edits
    const plan =
      only.startLine !== undefined
        ? planLines(before, only.startLine, only.endLine ?? only.startLine, only.replace)
        : planReplacement(before, only.find ?? "", only.replace)
    return typeof plan === "string" ? plan : { ...plan, count: 1 }
  }
  let text = before
  let count = 0
  for (const [index, edit] of edits.entries()) {
    const which = edits.length > 1 ? `edit ${index + 1} of ${edits.length}: ` : ""
    if (edit.startLine !== undefined) {
      return `${which}start_line and end_line cannot be used with replace_all or in a list of edits; use find`
    }
    const find = trimBlankEdges(withoutLineNumbers((edit.find ?? "").replace(/\r\n/g, "\n")))
    if (!find.trim()) return `${which}find is empty; it must be text already in the file`
    if (edit.all) {
      const replace = withoutLineNumbers(edit.replace.replace(/\r\n/g, "\n")).replace(/\n+$/, "")
      if (replace === find) return `${which}replace is the same as find; nothing would change`
      const every = replaceEvery(text, find, replace)
      if (!every.count) return `${which}${NOT_FOUND}`
      text = every.text
      count += every.count
      continue
    }
    const plan = planReplacement(text, edit.find ?? "", edit.replace)
    if (typeof plan === "string") return `${which}${plan}${edits.length > 1 ? "\nNone of the edits were made." : ""}`
    text = withLines(text, plan)
    count++
  }
  if (text === before) return "nothing would change"
  // The stretch of lines that differ, start to end.
  const was = before.split("\n")
  const now = text.split("\n")
  let head = 0
  while (head < was.length && head < now.length && was[head] === now[head]) head++
  let tail = 0
  while (tail < was.length - head && tail < now.length - head && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail++
  // Lines only added: the plan still rewrites a line, the one they follow (or come before).
  if (head + tail === was.length) {
    if (head > 0) head--
    else tail--
  }
  const startLine = head
  const endLine = was.length - 1 - tail
  return {
    startLine,
    endLine,
    original: was.slice(startLine, endLine + 1).join("\n"),
    text: now.slice(startLine, now.length - tail).join("\n"),
    count
  }
}

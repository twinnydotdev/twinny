/**
 * The completion after the one on screen, asked for while the user reads
 * it. Someone who takes a suggestion nearly always presses Enter next, and
 * then waits for the pause and the model all over again. So as soon as a
 * suggestion shows, the model is asked what would follow on the line
 * after it; if the user gets there, by accepting or by typing the
 * suggestion out, the answer is already here.
 *
 * These are the parts with no editor in them: where the user would be,
 * and whether they are still on the way there.
 */
import { PrefixSuffix } from "../../common/types"

import { ANCHOR_LENGTH, endsWithAnchor } from "./cache"

const OPENS_BLOCK = /[{([:]$/

/**
 * What the document gains between a suggestion showing and the cursor
 * standing on the line after it: the suggestion, a line break, and the
 * indentation the editor gives the new line (one level deeper after a
 * line that opens a block). A wrong guess at the indentation costs one
 * unused request; it is never shown, because the answer is only used
 * where the document reads exactly as predicted.
 */
export const textToNextLine = (
  lineBefore: string,
  completion: string,
  indentUnit: string,
  eol = "\n"
): string => {
  const lines = (lineBefore + completion).split(/\r?\n/)
  const last = lines[lines.length - 1]
  const indent = /^[ \t]*/.exec(last)?.[0] ?? ""
  const deeper = OPENS_BLOCK.test(last.trimEnd()) ? indentUnit : ""
  return completion.split(/\r?\n/).join(eol) + eol + indent + deeper
}

/**
 * How far along the way the document is: the number of characters of
 * `added` now before the cursor, `added.length` once the cursor is where
 * the prefetch was made for. Undefined when the user went somewhere else
 * and the answer has no use.
 */
export const prefetchProgress = (
  origin: PrefixSuffix,
  added: string,
  current: PrefixSuffix
): number | undefined => {
  if (!current.suffix.startsWith(origin.suffix.slice(0, ANCHOR_LENGTH))) return undefined
  const anchor = origin.prefix.slice(-ANCHOR_LENGTH)
  for (let typed = Math.min(added.length, current.prefix.length); typed >= 0; typed--) {
    if (!current.prefix.endsWith(added.slice(0, typed))) continue
    if (endsWithAnchor(current.prefix.slice(0, current.prefix.length - typed), anchor)) return typed
  }
  return undefined
}

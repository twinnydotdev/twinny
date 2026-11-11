/**
 * Keeps the context ahead of the code the same from one completion to the
 * next, wherever the content allows.
 *
 * A model server keeps its work on a prompt for as long as the next prompt
 * begins the same way, and reads only what follows the first difference.
 * The context files come first in the prompt, so one of them changing its
 * place, or coming and going between keystrokes, makes the server read the
 * whole prompt again. Nothing here changes what a block says: a block
 * that changed is sent changed.
 */
import { FimContextFile } from "../../common/types"

const same = (a: FimContextFile, b: FimContextFile) => a.name === b.name && a.text === b.text

const chars = (blocks: FimContextFile[]) => blocks.reduce((sum, block) => sum + block.text.length, 0)

/** How far the cursor may move from where definitions were found before they are found afresh. */
export const HOLD_LINES = 30

/**
 * The order of the context blocks: those sent last time keep their places,
 * in front, and new ones follow. One instance per completion provider;
 * `key` names the document and model, and a new key starts over.
 */
export class StableOrder {
  private _key = ""
  private _last: FimContextFile[] = []

  arrange(key: string, offered: FimContextFile[]): FimContextFile[] {
    const previous = this._key === key ? this._last : []
    const kept = previous.filter((block) => offered.some((other) => same(other, block)))
    const added = offered.filter((block) => !kept.some((other) => same(other, block)))
    this._key = key
    this._last = [...kept, ...added]
    return [...this._last]
  }
}

/**
 * The definitions shown with a completion, held while the cursor stays in
 * one part of a file. They are looked up for the names on the last few
 * lines, so the set changes line by line, and a lookup that times out
 * comes back empty; either way the prompt would begin differently. A
 * definition shown a few lines ago is still about the code being written,
 * so it stays until there is no room for it, and new ones go after it.
 */
export class HeldDefinitions {
  private _key = ""
  private _line = 0
  private _held: FimContextFile[] = []

  hold(key: string, line: number, found: FimContextFile[], budget: number): FimContextFile[] {
    const near = this._key === key && Math.abs(line - this._line) <= HOLD_LINES
    // A declaration that was edited is shown as it now reads, once.
    const kept = (near ? this._held : []).filter(
      (block) => !found.some((other) => other.name === block.name && other.text !== block.text)
    )
    const added = found.filter((block) => !kept.some((other) => same(other, block)))
    const held = [...kept, ...added]
    // Out of room: the oldest go first, never one found for this request.
    while (chars(held) > budget && held.length > added.length) held.shift()
    // The place moves only when something new was found there, so a run
    // of lines with nothing to look up does not let go of what is held.
    if (this._key !== key || !near || added.length) this._line = line
    this._key = key
    this._held = held
    return [...held]
  }
}

/** How much of `next` a server that has just read `previous` need not read again, from 0 to 1. */
export const sharedStart = (previous: string, next: string): number => {
  if (!next.length) return 1
  const limit = Math.min(previous.length, next.length)
  let at = 0
  while (at < limit && previous.charCodeAt(at) === next.charCodeAt(at)) at++
  return at / next.length
}

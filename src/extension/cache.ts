import { PrefixSuffix } from "../common/types"

export class LRUCache<T = string> {
  private _capacity: number
  private _cache: Map<string, T | null>

  constructor(capacity: number) {
    this._capacity = capacity
    this._cache = new Map()
  }

  getAll(): Map<string, T | null> {
    return this._cache
  }

  get(key: string): T | null | undefined {
    if (!this._cache.has(key)) return undefined

    const value = this._cache.get(key)
    this._cache.delete(key)
    if (value !== undefined) {
      this._cache.set(key, value)
    }
    return value
  }

  delete(key: string): void {
    this._cache.delete(key)
  }

  set(key: string, value: T | null): void {
    if (this._cache.has(key)) {
      this._cache.delete(key)
    } else if (this._cache.size === this._capacity) {
      const firstKey = this._cache.keys().next().value
      if (!firstKey) return
      this._cache.delete(firstKey)
    }
    this._cache.set(key, value)
  }

  normalize(src: string): string {
    return src.replace(/\s+/g, " ").trim()
  }

  getKey(prefixSuffix: PrefixSuffix): string {
    const { prefix, suffix } = prefixSuffix
    return this.normalize(prefix) + " #### " + this.normalize(suffix)
  }

  getCache(prefixSuffix: PrefixSuffix): T | undefined | null {
    const key = this.getKey(prefixSuffix)
    return this.get(key)
  }

  setCache(prefixSuffix: PrefixSuffix, completion: T): void {
    const key = this.getKey(prefixSuffix)
    this.set(key, completion)
  }
}

export const cache = new LRUCache(50)

/** The most recent suggestion shown, plus the context it was generated for. */
export interface LastSuggestion extends PrefixSuffix {
  completion: string
}

/** How much of the old prefix/suffix must still match to count as the same spot. */
const ANCHOR_LENGTH = 500
/** Below this the anchor is too generic to trust (unless the prefix itself is tiny). */
const MIN_ANCHOR_LENGTH = 30

/**
 * The prefix window slides forward a line at a time as the user types
 * newlines, so drop leading lines from the anchor until it fits.
 */
const endsWithAnchor = (head: string, anchor: string): boolean => {
  const minLength = Math.min(MIN_ANCHOR_LENGTH, anchor.length)
  let candidate = anchor
  while (candidate.length >= minLength) {
    if (head.endsWith(candidate)) return true
    const newline = candidate.indexOf("\n")
    if (newline === -1) return false
    candidate = candidate.slice(newline + 1)
  }
  return false
}

/**
 * When the user types the beginning of the suggestion we just showed, the
 * remainder is still valid, so serve it without another request. Returns the
 * unconsumed part of the previous completion, or undefined if the cursor has
 * moved somewhere the suggestion no longer applies.
 */
export const getSuggestionContinuation = (
  last: LastSuggestion | undefined,
  current: PrefixSuffix
): string | undefined => {
  if (!last?.completion) return undefined

  const suffixAnchor = last.suffix.slice(0, ANCHOR_LENGTH)
  if (!current.suffix.startsWith(suffixAnchor)) return undefined

  const prefixAnchor = last.prefix.slice(-ANCHOR_LENGTH)
  const maxTyped = Math.min(last.completion.length, current.prefix.length)

  for (let typedLength = maxTyped; typedLength >= 0; typedLength--) {
    const typed = last.completion.slice(0, typedLength)
    if (!current.prefix.endsWith(typed)) continue
    const head = current.prefix.slice(0, current.prefix.length - typedLength)
    if (!endsWithAnchor(head, prefixAnchor)) continue
    const remainder = last.completion.slice(typedLength)
    return remainder.trim() ? remainder : undefined
  }

  return undefined
}

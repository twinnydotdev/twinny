import { PrefixSuffix } from '../common/types'

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
      this._cache.delete(firstKey)
    }
    this._cache.set(key, value)
  }

  normalize(src: string): string {
    return src.split('\n').join('').replace(/\s+/g, '').replace(/\s/g, '')
  }

  getKey(prefixSuffix: PrefixSuffix): string {
    const { prefix, suffix } = prefixSuffix
    if (suffix) {
      return this.normalize(prefix + ' #### ' + suffix)
    }
    return this.normalize(prefix)
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

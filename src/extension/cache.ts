import { PrefixSuffix } from '../common/types'

export class LRUCache<T = string> {
  private capacity: number
  private cache: Map<string, T | null>

  constructor(capacity: number) {
    this.capacity = capacity
    this.cache = new Map()
  }

  getAll(): Map<string, T | null> {
    return this.cache
  }

  get(key: string): T | null | undefined {
    if (!this.cache.has(key)) return undefined

    const value = this.cache.get(key)
    this.cache.delete(key)
    if (value !== undefined) {
      this.cache.set(key, value)
    }
    return value
  }

  delete(key: string): void {
    this.cache.delete(key)
  }

  set(key: string, value: T | null): void {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size === this.capacity) {
      const firstKey = this.cache.keys().next().value
      this.cache.delete(firstKey)
    }
    this.cache.set(key, value)
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

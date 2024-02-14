import { PrefixSuffix } from './types'

class LRUCache {
  private capacity: number
  private cache: Map<string, string | null>

  constructor(capacity: number) {
    this.capacity = capacity
    this.cache = new Map()
  }

  get(key: string): string | null | undefined {
    if (!this.cache.has(key)) return undefined

    const value = this.cache.get(key)
    this.cache.delete(key)
    this.cache.set(key, value || '')
    return value
  }

  set(key: string, value: string | null): void {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size === this.capacity) {
      const firstKey = this.cache.keys().next().value
      this.cache.delete(firstKey)
    }
    this.cache.set(key, value)
  }

  normalize(src: string) {
    return src.split('\n').join('').replace(/\s+/gm, '').replace(' ', '')
  }

  getKey(prefixSuffix: PrefixSuffix) {
    const { prefix, suffix } = prefixSuffix
    if (suffix) {
      return this.normalize(prefix + ' #### ' + suffix)
    }
    return this.normalize(prefix)
  }

  getCache(prefixSuffix: PrefixSuffix): string | undefined | null {
    const key = this.getKey(prefixSuffix)
    return this.get(key)
  }

  setCache(prefixSuffix: PrefixSuffix, completion: string) {
    const key = this.getKey(prefixSuffix)
    this.set(key, completion)
  }
}

export const cache = new LRUCache(50)

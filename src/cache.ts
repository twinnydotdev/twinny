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
}

const cache = new LRUCache(50)

function normalize(src: string) {
  return src.split('\n').join('').replace(/\s+/gm, '').replace(' ', '')
}

function getKey(args: { prefix: string; suffix: string | null }) {
  if (args.suffix) {
    return normalize(args.prefix + ' #### ' + args.suffix)
  }
  return normalize(args.prefix)
}

export function getCache(args: {
  prefix: string
  suffix: string | null
}): string | undefined | null {
  const key = getKey(args)
  return cache.get(key)
}

export function setCache(args: {
  prefix: string
  suffix: string | null
  completion: string
}) {
  const key = getKey(args)
  cache.set(key, args.completion)
}

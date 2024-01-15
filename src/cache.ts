const cache: { [key: string]: string | null } = {}

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
  return cache[key]
}

export function setCache(args: {
  prefix: string
  suffix: string | null
  completion: string | null
}) {
  const key = getKey(args)
  cache[key] = args.completion
}

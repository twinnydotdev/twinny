/**
 * How an `@symbol` mention names what it points at. The composer only keeps
 * a string id per mention, so the file, line and name travel in one.
 * Pure so encoding round-trips are unit-testable.
 */
export interface SymbolRef {
  /** Workspace-relative path. */
  path: string
  /** Zero-based line the symbol starts on when it was picked. */
  line: number
  name: string
}

const PREFIX = "symbol:"

export const encodeSymbolRef = (ref: SymbolRef): string =>
  `${PREFIX}${ref.line}:${encodeURIComponent(ref.name)}:${ref.path}`

export const isSymbolRef = (id: string): boolean => id.startsWith(PREFIX)

export const decodeSymbolRef = (id: string): SymbolRef | undefined => {
  if (!isSymbolRef(id)) return undefined
  const match = /^symbol:(\d+):([^:]*):(.+)$/.exec(id)
  if (!match) return undefined
  return {
    line: Number(match[1]),
    name: decodeURIComponent(match[2]),
    path: match[3]
  }
}

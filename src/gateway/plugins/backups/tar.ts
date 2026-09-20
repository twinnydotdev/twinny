/**
 * A tar writer and reader with no dependencies: POSIX ustar, files and
 * directories only, names up to 255 bytes via the prefix field. Enough
 * for a gateway's data directory, and readable by any `tar` for a
 * restore done by hand.
 */

export interface TarEntry {
  name: string
  data: Buffer
  mode?: number
  mtimeMs?: number
}

const BLOCK = 512

const octal = (value: number, length: number): string =>
  `${value.toString(8).padStart(length - 1, "0")}\0`

const write = (block: Buffer, offset: number, length: number, text: string) => {
  block.write(text, offset, length, "utf8")
}

/** Splits a name into ustar name/prefix, or throws when it cannot fit. */
const splitName = (name: string): { name: string; prefix: string } => {
  const bytes = Buffer.byteLength(name, "utf8")
  if (bytes <= 100) return { name, prefix: "" }
  const parts = name.split("/")
  for (let i = parts.length - 1; i > 0; i--) {
    const tail = parts.slice(i).join("/")
    const head = parts.slice(0, i).join("/")
    if (Buffer.byteLength(tail) <= 100 && Buffer.byteLength(head) <= 155)
      return { name: tail, prefix: head }
  }
  throw new Error(`"${name}" is too long for a tar entry.`)
}

const header = (entry: TarEntry): Buffer => {
  const block = Buffer.alloc(BLOCK)
  const { name, prefix } = splitName(entry.name)
  write(block, 0, 100, name)
  write(block, 100, 8, octal(entry.mode ?? 0o600, 8))
  write(block, 108, 8, octal(0, 8))
  write(block, 116, 8, octal(0, 8))
  write(block, 124, 12, octal(entry.data.length, 12))
  write(block, 136, 12, octal(Math.floor((entry.mtimeMs ?? Date.now()) / 1000), 12))
  write(block, 148, 8, "        ")
  write(block, 156, 1, "0")
  write(block, 257, 6, "ustar\0")
  write(block, 263, 2, "00")
  write(block, 345, 155, prefix)
  let sum = 0
  for (const byte of block) sum += byte
  write(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `)
  return block
}

/** The archive as one buffer: headers, data padded to blocks, two zero blocks. */
export const packTar = (entries: TarEntry[]): Buffer => {
  const parts: Buffer[] = []
  for (const entry of entries) {
    parts.push(header(entry), entry.data)
    const pad = (BLOCK - (entry.data.length % BLOCK)) % BLOCK
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(parts)
}

const text = (block: Buffer, offset: number, length: number): string => {
  const raw = block.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8")
}

const number = (block: Buffer, offset: number, length: number): number => {
  const value = text(block, offset, length).trim()
  return value ? parseInt(value, 8) : 0
}

/** Reads a tar made here or by `tar`; entries that are not plain files are skipped. */
export const unpackTar = (archive: Buffer): TarEntry[] => {
  const entries: TarEntry[] = []
  let at = 0
  while (at + BLOCK <= archive.length) {
    const block = archive.subarray(at, at + BLOCK)
    at += BLOCK
    if (block.every((byte) => byte === 0)) break
    const size = number(block, 124, 12)
    const type = text(block, 156, 1) || "0"
    const prefix = text(block, 345, 155)
    const name = `${prefix ? `${prefix}/` : ""}${text(block, 0, 100)}`
    const data = archive.subarray(at, at + size)
    at += size + ((BLOCK - (size % BLOCK)) % BLOCK)
    if (type === "0" || type === "") {
      entries.push({
        name,
        data: Buffer.from(data),
        mode: number(block, 100, 8),
        mtimeMs: number(block, 136, 12) * 1000
      })
    }
  }
  return entries
}

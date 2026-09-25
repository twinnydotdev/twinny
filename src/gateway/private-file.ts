/**
 * Files the gateway keeps to itself: keys, invites, licences, plugin
 * settings. Written whole, under a private directory, through a
 * temporary name and a rename, so a reader never sees half a file and a
 * crash mid-write leaves the old one in place.
 */
import fs from "node:fs"
import path from "node:path"

/** Owner-only file in an owner-only directory, written atomically. */
export const writePrivateFile = (
  file: string,
  data: string | Uint8Array
): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** The same, for a JSON document: two-space indent and a final newline. */
export const writePrivateJson = (file: string, value: unknown): void =>
  writePrivateFile(file, `${JSON.stringify(value, null, 2)}\n`)

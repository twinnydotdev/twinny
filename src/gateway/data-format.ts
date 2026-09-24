/**
 * The data directory's format: one small file, `format.json`, that says
 * which layout the files beside it follow, so a future server can migrate
 * an old directory in order and an old server never writes into a newer
 * one. The number changes only when the layout does; the server version
 * beside it is a note for support, not a check.
 */
import * as fs from "node:fs"
import * as path from "node:path"

import { writePrivateJson } from "./private-file"

/** The layout this server reads and writes. Bump with a migration below. */
export const DATA_FORMAT = 1

export const DATA_FORMAT_FILE = "format.json"

/** Files a directory written before the marker existed may hold. */
const LEGACY_ENTRIES = ["keys.json", "license", "usage", "recordings", "invites.json", "plugins.json", "audit", "plugins"]

export interface DataFormatRecord {
  format: number
  /** The server version that last opened the directory. */
  server: string
  writtenAt: string
}

export interface DataMigration {
  /** The format this migration produces; run in order from the format found. */
  to: number
  /** One line for the log. */
  describe: string
  /** Rewrites the directory in place. Must tolerate files that are absent. */
  run: (dataDir: string) => void
}

/**
 * Every migration, oldest first. A directory at format N runs every entry
 * with `to > N`, and the marker is rewritten after each, so a crash midway
 * resumes from the last one that finished.
 */
export const DATA_MIGRATIONS: DataMigration[] = []

export class DataFormatError extends Error {
  constructor(
    message: string,
    public readonly code: "newer" | "unreadable"
  ) {
    super(message)
    this.name = "DataFormatError"
  }
}

export interface OpenedDataDir {
  format: number
  /** What the marker said before this open; absent for a directory that had none. */
  previous?: number
  /** True when the directory held files but no marker (written before 4.2). */
  legacy: boolean
  /** Formats migrated to, in order. */
  migrated: number[]
}

export interface OpenDataDirOptions {
  server: string
  migrations?: DataMigration[]
  /** The format to reach; the current one unless a test says otherwise. */
  target?: number
  log?: (event: string, fields: Record<string, string | number>) => void
  now?: () => Date
}

const readMarker = (file: string): DataFormatRecord | undefined => {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new DataFormatError(`${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`, "unreadable")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const record = parsed as Partial<DataFormatRecord> | undefined
  if (!record || typeof record !== "object" || !Number.isInteger(record.format) || (record.format as number) < 1) {
    throw new DataFormatError(
      `${file} is not a data format marker. If the directory was written by this version of twinny-server, delete the file and start again; otherwise restore a backup.`,
      "unreadable"
    )
  }
  return {
    format: record.format as number,
    server: typeof record.server === "string" ? record.server : "",
    writtenAt: typeof record.writtenAt === "string" ? record.writtenAt : ""
  }
}

const writeMarker = (file: string, record: DataFormatRecord) =>
  writePrivateJson(file, record)

const hasLegacyFiles = (dataDir: string): boolean =>
  LEGACY_ENTRIES.some((entry) => fs.existsSync(path.join(dataDir, entry)))

/**
 * Makes sure the directory exists and is at this server's format, running
 * migrations when it is older. Refuses a directory written by a newer
 * server rather than reading files it does not understand.
 */
export const openDataDir = (dataDir: string, options: OpenDataDirOptions): OpenedDataDir => {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const file = path.join(dataDir, DATA_FORMAT_FILE)
  const target = options.target ?? DATA_FORMAT
  const marker = readMarker(file)
  const legacy = !marker && hasLegacyFiles(dataDir)
  // A directory from before the marker is at format 1; an empty one starts current.
  let format = marker ? marker.format : legacy ? 1 : target
  if (format > target) {
    throw new DataFormatError(
      `${dataDir} was written by a newer twinny-server (data format ${format}` +
        (marker?.server ? `, version ${marker.server}` : "") +
        `; this version reads format ${target}). Upgrade twinny-server, or restore a backup taken by this version.`,
      "newer"
    )
  }
  const migrations = (options.migrations ?? DATA_MIGRATIONS).filter((m) => m.to > format).sort((a, b) => a.to - b.to)
  const migrated: number[] = []
  const stamp = (): DataFormatRecord => ({
    format,
    server: options.server,
    writtenAt: (options.now?.() ?? new Date()).toISOString()
  })
  for (const migration of migrations) {
    options.log?.("data.migrate", { from: format, to: migration.to, message: migration.describe })
    migration.run(dataDir)
    format = migration.to
    migrated.push(format)
    writeMarker(file, stamp())
  }
  if (format !== target) {
    throw new DataFormatError(
      `${dataDir} is at data format ${format} and no migration reaches format ${target}.`,
      "unreadable"
    )
  }
  if (!marker || marker.format !== format || marker.server !== options.server) writeMarker(file, stamp())
  return {
    format,
    ...(marker ? { previous: marker.format } : {}),
    legacy,
    migrated
  }
}

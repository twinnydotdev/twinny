/**
 * What a backup holds and how it is put back. One gzipped tar, optionally
 * encrypted, laid out so a restore knows where each file goes even when
 * the configuration moved usage or recordings elsewhere:
 *
 *   manifest.json            what is inside, with sizes and hashes
 *   config/<file>            the configuration file
 *   data/…                   the data directory: keys, licence, invites, plugins
 *   usage/…                  the usage files
 *   recordings/…             recorded content, only when asked for
 */
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"

import { SERVER_VERSION } from "../../version"
import type { GatewayPaths } from "../host"

import { decryptArchive, encryptArchive, isEncryptedArchive } from "./crypto"
import { packTar, TarEntry, unpackTar } from "./tar"

export interface ManifestFile {
  path: string
  size: number
  sha256: string
}

export interface BackupManifest {
  version: 1
  createdAt: string
  server: string
  host: string
  files: ManifestFile[]
}

export interface BackupOptions {
  includeRecordings: boolean
  /** Encrypts the archive when given. */
  passphrase?: string
  now?: () => number
}

/** `twinny-backup-20260920-031500.tar.gz`, `.enc` when encrypted. */
export const archiveName = (nowMs: number, encrypted: boolean): string => {
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-")
  return `twinny-backup-${stamp}.tar.gz${encrypted ? ".enc" : ""}`
}

export const ARCHIVE_PATTERN = /^twinny-backup-\d{8}-\d{6}\.tar\.gz(\.enc)?$/

const sha256 = (data: Buffer): string =>
  createHash("sha256").update(data as Uint8Array).digest("hex")

/** Every plain file under `dir`, relative with forward slashes, sorted. */
const walk = (dir: string, skip: (relative: string) => boolean = () => false): string[] => {
  const out: string[] = []
  const visit = (current: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      const relative = path.relative(dir, absolute).split(path.sep).join("/")
      if (skip(relative)) continue
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) out.push(relative)
    }
  }
  visit(dir)
  return out.sort()
}

const isInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child)
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative)
}

/** Reads what a backup should carry, as tar entries with archive-relative names. */
export const collectFiles = (paths: GatewayPaths, includeRecordings: boolean): TarEntry[] => {
  const entries: TarEntry[] = []
  const add = (name: string, file: string) => {
    let data: Buffer
    let stat: fs.Stats
    try {
      data = fs.readFileSync(file)
      stat = fs.statSync(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    entries.push({ name, data, mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs })
  }
  if (paths.configFile) add(`config/${path.basename(paths.configFile)}`, paths.configFile)
  const { dataDir } = paths
  // Usage and recordings have their own place in the archive; the backups
  // plugin's own archives, if kept under the data directory, are not backed up again.
  const usageInside = isInside(dataDir, paths.usageDir) ? path.relative(dataDir, paths.usageDir).split(path.sep).join("/") : undefined
  const recordingsInside = isInside(dataDir, paths.recordingsDir) ? path.relative(dataDir, paths.recordingsDir).split(path.sep).join("/") : undefined
  for (const relative of walk(dataDir, (rel) =>
    (usageInside !== undefined && (rel === usageInside || rel.startsWith(`${usageInside}/`))) ||
    (recordingsInside !== undefined && (rel === recordingsInside || rel.startsWith(`${recordingsInside}/`))) ||
    (rel.startsWith("plugins/backups/") && rel !== "plugins/backups/settings.json") ||
    rel.endsWith(".tmp")
  ))
    add(`data/${relative}`, path.join(dataDir, relative))
  for (const relative of walk(paths.usageDir)) add(`usage/${relative}`, path.join(paths.usageDir, relative))
  if (includeRecordings)
    for (const relative of walk(paths.recordingsDir)) add(`recordings/${relative}`, path.join(paths.recordingsDir, relative))
  return entries
}

export interface BuiltArchive {
  name: string
  data: Buffer
  manifest: BackupManifest
  encrypted: boolean
}

/** Gathers, packs, compresses and (when a passphrase is set) encrypts. */
export const buildArchive = (paths: GatewayPaths, options: BackupOptions): BuiltArchive => {
  const now = options.now?.() ?? Date.now()
  const files = collectFiles(paths, options.includeRecordings)
  const manifest: BackupManifest = {
    version: 1,
    createdAt: new Date(now).toISOString(),
    server: SERVER_VERSION,
    host: os.hostname(),
    files: files.map((entry) => ({ path: entry.name, size: entry.data.length, sha256: sha256(entry.data) }))
  }
  const tar = packTar([
    { name: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"), mode: 0o600, mtimeMs: now },
    ...files
  ])
  const compressed = gzipSync(tar as Uint8Array)
  const encrypted = options.passphrase !== undefined && options.passphrase !== ""
  return {
    name: archiveName(now, encrypted),
    data: encrypted ? encryptArchive(compressed, options.passphrase as string) : compressed,
    manifest,
    encrypted
  }
}

export interface OpenedArchive {
  manifest: BackupManifest
  entries: TarEntry[]
}

/** Reads an archive back; needs the passphrase for an encrypted one. */
export const openArchive = (data: Buffer, passphrase?: string): OpenedArchive => {
  let compressed = data
  if (isEncryptedArchive(data)) {
    if (!passphrase) throw new Error("This backup is encrypted; the passphrase is needed to open it.")
    compressed = decryptArchive(data, passphrase)
  }
  let tar: Buffer
  try {
    tar = gunzipSync(compressed as Uint8Array)
  } catch {
    throw new Error("This is not a twinny backup (not gzip).")
  }
  const entries = unpackTar(tar)
  const manifestEntry = entries.find((entry) => entry.name === "manifest.json")
  if (!manifestEntry) throw new Error("This is not a twinny backup (no manifest).")
  const manifest = JSON.parse(manifestEntry.data.toString("utf8")) as BackupManifest
  if (manifest.version !== 1) throw new Error(`Backup version ${String(manifest.version)} is newer than this server understands.`)
  for (const entry of entries) {
    if (entry.name === "manifest.json") continue
    const listed = manifest.files.find((file) => file.path === entry.name)
    if (!listed || listed.sha256 !== sha256(entry.data))
      throw new Error(`${entry.name} in the backup does not match its manifest; the archive is damaged.`)
  }
  return { manifest, entries: entries.filter((entry) => entry.name !== "manifest.json") }
}

/** Where an archive entry goes on this machine, or nothing when it has no place. */
export const targetFor = (name: string, paths: GatewayPaths): string | undefined => {
  const [kind, ...rest] = name.split("/")
  const relative = rest.join("/")
  if (!relative || rest.some((part) => part === "..")) return undefined
  switch (kind) {
    case "config":
      return paths.configFile
    case "data":
      return path.join(paths.dataDir, ...rest)
    case "usage":
      return path.join(paths.usageDir, ...rest)
    case "recordings":
      return path.join(paths.recordingsDir, ...rest)
    default:
      return undefined
  }
}

export interface RestorePlan {
  /** Files that will be written, archive name → destination path. */
  writes: Array<{ from: string; to: string; size: number; exists: boolean }>
  /** Entries with nowhere to go on this machine (e.g. config when no --config was given). */
  skipped: string[]
}

export const planRestore = (opened: OpenedArchive, paths: GatewayPaths): RestorePlan => {
  const plan: RestorePlan = { writes: [], skipped: [] }
  for (const entry of opened.entries) {
    const to = targetFor(entry.name, paths)
    if (!to) {
      plan.skipped.push(entry.name)
      continue
    }
    plan.writes.push({ from: entry.name, to, size: entry.data.length, exists: fs.existsSync(to) })
  }
  return plan
}

/** Writes every entry to its place, each file atomically, owner-only. Files not in the backup are left alone. */
export const restoreArchive = (opened: OpenedArchive, paths: GatewayPaths): string[] => {
  const written: string[] = []
  for (const entry of opened.entries) {
    const to = targetFor(entry.name, paths)
    if (!to) continue
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 })
    const tmp = `${to}.${process.pid}.restore`
    fs.writeFileSync(tmp, entry.data as Uint8Array, { mode: entry.mode ? entry.mode & 0o600 || 0o600 : 0o600 })
    fs.renameSync(tmp, to)
    written.push(to)
  }
  return written
}

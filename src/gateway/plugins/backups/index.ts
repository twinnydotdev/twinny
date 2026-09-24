/**
 * The Backups plugin: a nightly copy of everything the gateway would
 * miss (configuration, keys, licence, invites, plugins and their files,
 * usage; recordings if asked) to a directory or an S3-compatible bucket,
 * optionally encrypted, with the last N kept. Restoring is a CLI job
 * done with the server stopped: `twinny-server backup restore <archive>`.
 *
 *   GET    api/                  → settings (no secrets), last run, next run, archives at the destination
 *   PUT    api/settings          → destination, time, retention, encryption
 *   POST   api/check             → writes and deletes a probe at the destination
 *   POST   api/run               → back up now
 *   GET    api/archives          → a fresh listing
 *   DELETE api/archives/<name>
 */
import fs from "node:fs"
import path from "node:path"

import { isRecord } from "../../../common/guards"
import { writePrivateFile, writePrivateJson } from "../../private-file"
import {
  GatewayPlugin,
  json,
  notFound,
  PluginContext,
  PluginError,
  PluginInstance,
  PluginRequest,
  PluginResponse
} from "../host"

import { ARCHIVE_PATTERN, buildArchive } from "./archive"
import { S3Client, S3Settings } from "./s3"

export interface BackupSettings {
  destination: "path" | "s3"
  path?: string
  s3?: S3Settings
  /** Local time of the nightly run. */
  hour: number
  minute: number
  /** Archives kept at the destination; older ones are deleted after a successful run. */
  keep: number
  includeRecordings: boolean
  /** Encrypts every archive; also what a restore needs. */
  passphrase?: string
  /** The nightly run; off leaves only "back up now". */
  schedule: boolean
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  destination: "path",
  hour: 3,
  minute: 0,
  keep: 14,
  includeRecordings: false,
  schedule: true
}

/** What the page sees: secrets replaced by whether they are set. */
export interface BackupSettingsView extends Omit<BackupSettings, "passphrase" | "s3"> {
  passphraseSet: boolean
  s3?: Omit<S3Settings, "secretAccessKey"> & { secretAccessKeySet: boolean }
}

export interface ArchiveInfo {
  name: string
  size: number
  /** When the archive was made, from its name. */
  createdAt: string
  encrypted: boolean
}

export interface BackupRun {
  startedAt: string
  finishedAt?: string
  ok?: boolean
  name?: string
  size?: number
  files?: number
  error?: string
  /** `schedule`, or the admin key that pressed the button. */
  requestedBy: string
}

/** Where archives go. */
export interface Destination {
  describe(): string
  put(name: string, data: Buffer): Promise<void>
  get(name: string): Promise<Buffer>
  list(): Promise<ArchiveInfo[]>
  delete(name: string): Promise<void>
}

const createdAtOf = (name: string): string => {
  const match = /^twinny-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name)
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : ""
}

const toInfo = (name: string, size: number): ArchiveInfo => ({
  name,
  size,
  createdAt: createdAtOf(name),
  encrypted: name.endsWith(".enc")
})

export const pathDestination = (dir: string): Destination => ({
  describe: () => dir,
  async put(name, data) {
    writePrivateFile(path.join(dir, name), data as Uint8Array)
  },
  async get(name) {
    return fs.readFileSync(path.join(dir, name))
  },
  async list() {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    return names
      .filter((name) => ARCHIVE_PATTERN.test(name))
      .sort()
      .map((name) => toInfo(name, fs.statSync(path.join(dir, name)).size))
  },
  async delete(name) {
    try {
      fs.unlinkSync(path.join(dir, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
})

export const s3Destination = (settings: S3Settings, fetchImpl?: typeof fetch): Destination => {
  const client = new S3Client(settings, fetchImpl)
  return {
    describe: () => `s3 ${settings.bucket}/${settings.prefix} at ${settings.endpoint}`,
    put: (name, data) => client.put(name, data),
    get: (name) => client.get(name),
    async list() {
      return (await client.list())
        .filter((object) => ARCHIVE_PATTERN.test(object.key))
        .map((object) => toInfo(object.key, object.size))
    },
    delete: (name) => client.delete(name)
  }
}

/** Reads the plugin's settings file; what the CLI and the plugin share. */
export const readBackupSettings = (file: string): BackupSettings => {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_BACKUP_SETTINGS }
    throw error
  }
  if (!isRecord(parsed)) return { ...DEFAULT_BACKUP_SETTINGS }
  const s3 = isRecord(parsed.s3) ? parsed.s3 : undefined
  return {
    destination: parsed.destination === "s3" ? "s3" : "path",
    ...(typeof parsed.path === "string" ? { path: parsed.path } : {}),
    ...(s3
      ? {
          s3: {
            endpoint: String(s3.endpoint ?? ""),
            region: String(s3.region ?? "auto"),
            bucket: String(s3.bucket ?? ""),
            prefix: String(s3.prefix ?? ""),
            accessKeyId: String(s3.accessKeyId ?? ""),
            secretAccessKey: String(s3.secretAccessKey ?? ""),
            forcePathStyle: s3.forcePathStyle === true
          }
        }
      : {}),
    hour: typeof parsed.hour === "number" ? parsed.hour : DEFAULT_BACKUP_SETTINGS.hour,
    minute: typeof parsed.minute === "number" ? parsed.minute : DEFAULT_BACKUP_SETTINGS.minute,
    keep: typeof parsed.keep === "number" ? parsed.keep : DEFAULT_BACKUP_SETTINGS.keep,
    includeRecordings: parsed.includeRecordings === true,
    ...(typeof parsed.passphrase === "string" && parsed.passphrase ? { passphrase: parsed.passphrase } : {}),
    schedule: parsed.schedule !== false
  }
}

export const writeBackupSettings = (file: string, settings: BackupSettings): void => {
  writePrivateJson(file, settings)
}

export const backupSettingsFile = (pluginDir: string): string => path.join(pluginDir, "settings.json")

/** The destination the settings describe, or why there is none yet. */
export const destinationFor = (settings: BackupSettings, fetchImpl?: typeof fetch): Destination => {
  if (settings.destination === "s3") {
    const s3 = settings.s3
    if (!s3 || !s3.endpoint || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey)
      throw new PluginError("The S3 destination needs an endpoint, a bucket, an access key id and a secret.", 400)
    return s3Destination(s3, fetchImpl)
  }
  if (!settings.path) throw new PluginError("Give the backups a directory to go to.", 400)
  return pathDestination(settings.path)
}

export const viewSettings = (settings: BackupSettings): BackupSettingsView => {
  const { passphrase, s3, ...rest } = settings
  return {
    ...rest,
    passphraseSet: !!passphrase,
    ...(s3
      ? {
          s3: {
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            prefix: s3.prefix,
            accessKeyId: s3.accessKeyId,
            forcePathStyle: s3.forcePathStyle,
            secretAccessKeySet: !!s3.secretAccessKey
          }
        }
      : {})
  }
}

const TICK_MS = 30_000

export class BackupsPlugin implements PluginInstance {
  private _settings: BackupSettings
  private _lastRun: BackupRun | undefined
  private _running: Promise<BackupRun> | undefined
  private _archives: ArchiveInfo[] = []
  private _archivesAt: string | undefined
  private _archivesError: string | undefined
  private _timer: NodeJS.Timeout | undefined
  /** The local date (YYYY-MM-DD) of the last scheduled run, so a day gets one. */
  private _scheduledOn: string | undefined
  private readonly _file: string

  constructor(
    private readonly _context: PluginContext,
    private readonly _tickMs = TICK_MS
  ) {
    this._file = backupSettingsFile(_context.dataDir)
    this._settings = readBackupSettings(this._file)
  }

  public get settings(): BackupSettings {
    return { ...this._settings }
  }

  public start(): void {
    void this.refreshArchives().catch(() => undefined)
    if (this._tickMs > 0) {
      this._timer = setInterval(() => void this.tick(), this._tickMs)
      this._timer.unref()
    }
  }

  public async stop(): Promise<void> {
    if (this._timer) clearInterval(this._timer)
    await this._running?.catch(() => undefined)
  }

  private localDate(nowMs: number): { date: string; hour: number; minute: number } {
    const now = new Date(nowMs)
    return {
      date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
      hour: now.getHours(),
      minute: now.getMinutes()
    }
  }

  /** When the schedule next fires, for the page. */
  public nextRunAt(): string | undefined {
    if (!this._settings.schedule) return undefined
    const now = new Date(this._context.now())
    const next = new Date(now)
    next.setHours(this._settings.hour, this._settings.minute, 0, 0)
    const { date } = this.localDate(now.getTime())
    if (next.getTime() <= now.getTime() || this._scheduledOn === date) next.setDate(next.getDate() + 1)
    return next.toISOString()
  }

  /** Runs the nightly backup once the clock passes the set time, once per day. */
  public async tick(): Promise<void> {
    if (!this._settings.schedule || this._running) return
    const { date, hour, minute } = this.localDate(this._context.now())
    if (this._scheduledOn === date) return
    if (hour < this._settings.hour || (hour === this._settings.hour && minute < this._settings.minute)) return
    this._scheduledOn = date
    await this.run("schedule")
  }

  public run(requestedBy: string): Promise<BackupRun> {
    if (this._running) return this._running
    const run: BackupRun = { startedAt: new Date(this._context.now()).toISOString(), requestedBy }
    this._lastRun = run
    this._running = (async () => {
      try {
        const paths = this._context.paths
        if (!paths) throw new PluginError("This gateway did not tell the plugin where its files are.", 503)
        const destination = destinationFor(this._settings, this._context.fetch)
        const built = buildArchive(paths, {
          includeRecordings: this._settings.includeRecordings,
          passphrase: this._settings.passphrase,
          now: this._context.now
        })
        await destination.put(built.name, built.data)
        run.name = built.name
        run.size = built.data.length
        run.files = built.manifest.files.length
        run.ok = true
        this._context.log.info({
          event: "plugin.backup",
          key: requestedBy,
          reason: built.name,
          ms: this._context.now() - Date.parse(run.startedAt)
        })
        await this.prune(destination)
        this._context.events?.emit({
          type: "backup.ok",
          source: "backups",
          level: "info",
          title: `Backup made: ${built.name}`,
          text: `${built.manifest.files.length} files, ${Math.round(built.data.length / 1024)} KiB${built.encrypted ? ", encrypted" : ""}, to ${destination.describe()}.`
        })
      } catch (error) {
        run.ok = false
        run.error = error instanceof Error ? error.message : String(error)
        this._context.log.warn({ event: "plugin.backup-failed", key: requestedBy, message: run.error })
        this._context.events?.emit({
          type: "backup.failed",
          source: "backups",
          level: "error",
          title: "Backup failed",
          text: run.error
        })
      } finally {
        run.finishedAt = new Date(this._context.now()).toISOString()
      }
      return run
    })().finally(() => {
      this._running = undefined
    })
    return this._running
  }

  /** Lists the destination and deletes the archives beyond `keep`, oldest first. */
  private async prune(destination: Destination): Promise<void> {
    const archives = await destination.list()
    const excess = Math.max(0, archives.length - Math.max(1, this._settings.keep))
    for (const archive of archives.slice(0, excess)) {
      await destination.delete(archive.name)
      this._context.log.info({ event: "plugin.backup-pruned", reason: archive.name })
    }
    this._archives = archives.slice(excess)
    this._archivesAt = new Date(this._context.now()).toISOString()
    this._archivesError = undefined
  }

  public async refreshArchives(): Promise<ArchiveInfo[]> {
    try {
      const destination = destinationFor(this._settings, this._context.fetch)
      this._archives = await destination.list()
      this._archivesError = undefined
    } catch (error) {
      this._archives = []
      this._archivesError = error instanceof Error ? error.message : String(error)
    }
    this._archivesAt = new Date(this._context.now()).toISOString()
    return this._archives
  }

  private overview() {
    return {
      settings: viewSettings(this._settings),
      configured: (() => {
        try {
          destinationFor(this._settings)
          return true
        } catch {
          return false
        }
      })(),
      destination: (() => {
        try {
          return destinationFor(this._settings).describe()
        } catch {
          return undefined
        }
      })(),
      running: this._running !== undefined,
      lastRun: this._lastRun,
      nextRunAt: this.nextRunAt(),
      archives: this._archives,
      archivesAt: this._archivesAt,
      archivesError: this._archivesError,
      paths: this._context.paths
        ? { configFile: this._context.paths.configFile, dataDir: this._context.paths.dataDir }
        : undefined
    }
  }

  public async handle(request: PluginRequest): Promise<PluginResponse> {
    const { method, path: route } = request
    if (route === "" && method === "GET") return json(this.overview())
    if (route === "settings" && method === "PUT") {
      this.updateSettings(await request.body())
      this._context.log.info({ event: "plugin.backup-settings", key: request.principal })
      await this.refreshArchives()
      return json(this.overview())
    }
    if (route === "check" && method === "POST") {
      const destination = destinationFor(this._settings, this._context.fetch)
      const probe = `twinny-backup-probe-${this._context.now()}.txt`
      await destination.put(probe, Buffer.from("twinny-server can write here.\n"))
      await destination.delete(probe)
      await this.refreshArchives()
      return json({ ok: true, destination: destination.describe(), archives: this._archives })
    }
    if (route === "run" && method === "POST") {
      const run = await this.run(request.principal)
      return json({ run, ...this.overview() }, run.ok ? 200 : 502)
    }
    if (route === "archives" && method === "GET") return json({ archives: await this.refreshArchives(), error: this._archivesError })
    const one = /^archives\/(twinny-backup-[0-9-]+\.tar\.gz(?:\.enc)?)$/.exec(route)
    if (one && method === "DELETE") {
      const destination = destinationFor(this._settings, this._context.fetch)
      await destination.delete(one[1])
      this._context.log.info({ event: "plugin.backup-deleted", key: request.principal, reason: one[1] })
      return json({ name: one[1], status: "deleted", archives: await this.refreshArchives() })
    }
    return notFound()
  }

  private updateSettings(body: Record<string, unknown>): void {
    const next: BackupSettings = { ...this._settings }
    if (body.destination !== undefined) {
      if (body.destination !== "path" && body.destination !== "s3")
        throw new PluginError("destination is \"path\" or \"s3\".", 400)
      next.destination = body.destination
    }
    if (body.path !== undefined) {
      const dir = typeof body.path === "string" ? body.path.trim() : ""
      if (dir && !path.isAbsolute(dir)) throw new PluginError("The backup directory must be an absolute path.", 400)
      if (dir) next.path = dir
      else delete next.path
    }
    if (body.s3 !== undefined) {
      const s3 = isRecord(body.s3) ? body.s3 : {}
      const current = next.s3
      const endpoint = String(s3.endpoint ?? current?.endpoint ?? "").trim()
      if (endpoint && !/^https?:\/\//.test(endpoint)) throw new PluginError("The S3 endpoint must start with https:// or http://.", 400)
      const secret = typeof s3.secretAccessKey === "string" && s3.secretAccessKey ? s3.secretAccessKey : (current?.secretAccessKey ?? "")
      next.s3 = {
        endpoint,
        region: String(s3.region ?? current?.region ?? "auto").trim() || "auto",
        bucket: String(s3.bucket ?? current?.bucket ?? "").trim(),
        prefix: String(s3.prefix ?? current?.prefix ?? "").replace(/^\/+/, ""),
        accessKeyId: String(s3.accessKeyId ?? current?.accessKeyId ?? "").trim(),
        secretAccessKey: secret,
        forcePathStyle: s3.forcePathStyle === undefined ? (current?.forcePathStyle ?? false) : s3.forcePathStyle === true
      }
      if (next.s3.prefix && !next.s3.prefix.endsWith("/")) next.s3.prefix += "/"
    }
    if (body.hour !== undefined || body.minute !== undefined) {
      const hour = body.hour === undefined ? next.hour : Number(body.hour)
      const minute = body.minute === undefined ? next.minute : Number(body.minute)
      if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59)
        throw new PluginError("The time is an hour 0–23 and a minute 0–59.", 400)
      next.hour = hour
      next.minute = minute
      this._scheduledOn = undefined
    }
    if (body.keep !== undefined) {
      const keep = Number(body.keep)
      if (!Number.isInteger(keep) || keep < 1 || keep > 1000) throw new PluginError("Keep between 1 and 1000 archives.", 400)
      next.keep = keep
    }
    if (body.includeRecordings !== undefined) next.includeRecordings = body.includeRecordings === true
    if (body.schedule !== undefined) next.schedule = body.schedule !== false
    if (body.passphrase !== undefined) {
      const passphrase = typeof body.passphrase === "string" ? body.passphrase : ""
      if (passphrase && passphrase.length < 12) throw new PluginError("Use a passphrase of at least 12 characters.", 400)
      if (passphrase) next.passphrase = passphrase
      else delete next.passphrase
    }
    writeBackupSettings(this._file, next)
    this._settings = next
  }
}

export const backupsPlugin: GatewayPlugin = {
  id: "backups",
  name: "Backups",
  description:
    "A nightly copy of the configuration, keys, licence, invites, plugins and usage to a directory or an S3-compatible bucket, encrypted if you like, with the last N kept. Restore from the CLI.",
  create: (context) => new BackupsPlugin(context)
}

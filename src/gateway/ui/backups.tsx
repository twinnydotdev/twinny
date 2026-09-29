/**
 * The Backups plugin's page: where archives go, when, how many are kept,
 * whether they are encrypted; the last run and the next; the archives at
 * the destination. Restoring is a CLI job and the page says so.
 */
import React, { FormEvent, useCallback, useEffect, useState } from "react"

import { messageOf } from "../../common/errors"
import type { ArchiveInfo, BackupRun, BackupSettingsView } from "../plugins/backups"

import { api } from "./api"
import { fmt, timeAgo, timeUntil } from "./format"
import { PageSkeleton, PluginIcon } from "./plugins"

interface Overview {
  settings: BackupSettingsView
  configured: boolean
  destination?: string
  running: boolean
  lastRun?: BackupRun
  nextRunAt?: string
  archives: ArchiveInfo[]
  archivesAt?: string
  archivesError?: string
  paths?: { configFile?: string; dataDir: string }
}

const size = (bytes: number): string =>
  bytes < 1024 ? `${fmt(bytes)} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`

const pad = (n: number) => String(n).padStart(2, "0")

export const BackupsPanel = ({ apiKey }: { apiKey: string }) => {
  const base = "/twinny/v1/admin/plugins/backups/api"
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)

  // The form: filled from the settings, edited locally, saved as one.
  const [destination, setDestination] = useState<"path" | "s3">("path")
  const [dir, setDir] = useState("")
  const [s3, setS3] = useState({ endpoint: "", region: "auto", bucket: "", prefix: "", accessKeyId: "", secretAccessKey: "", forcePathStyle: false })
  const [time, setTime] = useState("03:00")
  const [keep, setKeep] = useState("14")
  const [schedule, setSchedule] = useState(true)
  const [includeRecordings, setIncludeRecordings] = useState(false)
  const [passphrase, setPassphrase] = useState("")
  const [clearPassphrase, setClearPassphrase] = useState(false)

  const fill = useCallback((settings: BackupSettingsView) => {
    setDestination(settings.destination)
    setDir(settings.path ?? "")
    setS3({
      endpoint: settings.s3?.endpoint ?? "",
      region: settings.s3?.region ?? "auto",
      bucket: settings.s3?.bucket ?? "",
      prefix: settings.s3?.prefix ?? "",
      accessKeyId: settings.s3?.accessKeyId ?? "",
      secretAccessKey: "",
      forcePathStyle: settings.s3?.forcePathStyle ?? false
    })
    setTime(`${pad(settings.hour)}:${pad(settings.minute)}`)
    setKeep(String(settings.keep))
    setSchedule(settings.schedule)
    setIncludeRecordings(settings.includeRecordings)
    setPassphrase("")
    setClearPassphrase(false)
  }, [])

  const load = useCallback(async () => {
    try {
      const answer = await api<Overview>(`${base}/`, apiKey)
      setOverview(answer)
      setError(undefined)
      return answer
    } catch (e) {
      setError(messageOf(e))
      return null
    }
  }, [apiKey])

  useEffect(() => {
    void load().then((answer) => answer && fill(answer.settings))
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load()
    }, 60_000)
    return () => clearInterval(timer)
  }, [load, fill])

  const run = async (what: string, action: () => Promise<unknown>, done?: string) => {
    setBusy(what)
    setError(undefined)
    setNotice(undefined)
    try {
      await action()
      await load()
      if (done) setNotice(done)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(null)
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault()
    const [hour, minute] = time.split(":").map(Number)
    void run(
      "save",
      async () => {
        const answer = await api<Overview>(`${base}/settings`, apiKey, {
          method: "PUT",
          body: {
            destination,
            path: dir,
            s3: { ...s3, ...(s3.secretAccessKey ? {} : { secretAccessKey: undefined }) },
            hour,
            minute,
            keep: Number(keep),
            schedule,
            includeRecordings,
            ...(clearPassphrase ? { passphrase: "" } : passphrase ? { passphrase } : {})
          }
        })
        fill(answer.settings)
      },
      "Settings saved."
    )
  }

  if (!overview)
    return error ? (
      <div className="error-bar">{error}</div>
    ) : (
      <PageSkeleton
        tiles={4}
        rows={3}
        title={
          <h2 className="plugin-name">
            <PluginIcon id="backups" size={22} />
            Backups
          </h2>
        }
      />
    )
  const { settings, lastRun } = overview

  return (
    <>
      <div className="page-title">
        <h2 className="plugin-name">
          <PluginIcon id="backups" size={22} />
          Backups
        </h2>
        <p>
          A nightly copy of the configuration, keys, licence, invites, plugins and usage.{" "}
          <button type="button" className="link" disabled={busy !== null || overview.running || !overview.configured} onClick={() => void run("run", () => api(`${base}/run`, apiKey, { method: "POST" }))}>
            {overview.running || busy === "run" ? "backing up…" : "back up now"}
          </button>
        </p>
      </div>
      {notice && <div className="success-bar">{notice}</div>}
      {error && <div className="error-bar">{error}</div>}

      <div className="tiles">
        <div className={`tile ${lastRun && lastRun.ok === false ? "bad" : ""}`}>
          <div className="label">last backup</div>
          <div className="value">
            {!lastRun ? "none yet" : lastRun.finishedAt === undefined ? "running" : lastRun.ok ? timeAgo(lastRun.finishedAt) : "failed"}
            {lastRun?.ok && lastRun.size !== undefined && <small>{size(lastRun.size)}</small>}
          </div>
        </div>
        <div className="tile">
          <div className="label">next backup</div>
          <div className="value">{overview.nextRunAt ? timeUntil(overview.nextRunAt) : settings.schedule ? "–" : "off"}</div>
        </div>
        <div className="tile">
          <div className="label">archives kept</div>
          <div className="value">
            {fmt(overview.archives.length)}
            <small>of {fmt(settings.keep)}</small>
          </div>
        </div>
        <div className="tile">
          <div className="label">encryption</div>
          <div className="value">{settings.passphraseSet ? "on" : "off"}</div>
        </div>
      </div>

      {lastRun && lastRun.ok === false && (
        <div className="error-bar">
          The backup at {lastRun.startedAt.replace("T", " ").slice(0, 16)} failed: {lastRun.error}
        </div>
      )}

      <section className="panel">
        <div className="section-heading">
          <h2>
            Archives
            <span className="count">{fmt(overview.archives.length)}</span>
          </h2>
          <span className="links">
            {overview.destination && <span className="muted">{overview.destination}</span>}
            <button type="button" className="ghost mini" disabled={busy !== null || !overview.configured} onClick={() => void run("list", () => api(`${base}/archives`, apiKey))}>
              {busy === "list" ? "…" : "refresh"}
            </button>
          </span>
        </div>
        {overview.archivesError && <div className="error">{overview.archivesError}</div>}
        {overview.archives.length === 0 ? (
          <div className="empty">{overview.configured ? "No archives at the destination yet." : "Set a destination below."}</div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>archive</th>
                  <th>made</th>
                  <th>size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...overview.archives].reverse().map((archive) => (
                  <tr key={archive.name}>
                    <td className="mono">
                      {archive.name}
                      {archive.encrypted && <span className="tag reviewed">encrypted</span>}
                    </td>
                    <td className="muted" title={archive.createdAt}>
                      {archive.createdAt ? timeAgo(archive.createdAt) : "–"}
                    </td>
                    <td>{size(archive.size)}</td>
                    <td className="actions">
                      {confirm === archive.name ? (
                        <>
                          <button type="button" className="danger mini" disabled={busy !== null} onClick={() => void run(`delete:${archive.name}`, () => api(`${base}/archives/${archive.name}`, apiKey, { method: "DELETE" }).then(() => setConfirm(null)))}>
                            delete
                          </button>{" "}
                          <button type="button" className="ghost mini" onClick={() => setConfirm(null)}>
                            keep
                          </button>
                        </>
                      ) : (
                        <button type="button" className="ghost mini" disabled={busy !== null} onClick={() => setConfirm(archive.name)}>
                          delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="hint">
          Restore with the gateway stopped: <code>twinny-server backup restore &lt;archive&gt; --config &lt;file&gt; --yes</code>. An encrypted archive needs the passphrase in <code>TWINNY_BACKUP_PASSPHRASE</code> on another machine.
        </div>
      </section>

      <form className="panel" onSubmit={save}>
        <div className="section-heading">
          <h2>Destination and schedule</h2>
          <span className="chips" role="group" aria-label="Destination">
            <button type="button" className={destination === "path" ? "on" : ""} onClick={() => setDestination("path")}>
              directory
            </button>
            <button type="button" className={destination === "s3" ? "on" : ""} onClick={() => setDestination("s3")}>
              S3 bucket
            </button>
          </span>
        </div>
        {destination === "path" ? (
          <div className="config-fields">
            <label className="config-field">
              <span>directory on this server (absolute)</span>
              <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/var/backups/twinny" spellCheck={false} />
            </label>
          </div>
        ) : (
          <div className="config-fields">
            <label className="config-field">
              <span>endpoint</span>
              <input value={s3.endpoint} onChange={(e) => setS3({ ...s3, endpoint: e.target.value })} placeholder="https://s3.eu-west-1.amazonaws.com" spellCheck={false} />
            </label>
            <label className="config-field">
              <span>region</span>
              <input value={s3.region} onChange={(e) => setS3({ ...s3, region: e.target.value })} placeholder="auto" spellCheck={false} />
            </label>
            <label className="config-field">
              <span>bucket</span>
              <input value={s3.bucket} onChange={(e) => setS3({ ...s3, bucket: e.target.value })} spellCheck={false} />
            </label>
            <label className="config-field">
              <span>prefix (folder in the bucket)</span>
              <input value={s3.prefix} onChange={(e) => setS3({ ...s3, prefix: e.target.value })} placeholder="twinny/" spellCheck={false} />
            </label>
            <label className="config-field">
              <span>access key id</span>
              <input value={s3.accessKeyId} onChange={(e) => setS3({ ...s3, accessKeyId: e.target.value })} spellCheck={false} autoComplete="off" />
            </label>
            <label className="config-field">
              <span>secret access key {settings.s3?.secretAccessKeySet && <em className="muted">(set; leave blank to keep)</em>}</span>
              <input type="password" value={s3.secretAccessKey} onChange={(e) => setS3({ ...s3, secretAccessKey: e.target.value })} autoComplete="new-password" />
            </label>
          </div>
        )}
        {destination === "s3" && (
          <div className="backup-options">
            <label className="policy-option">
              <input type="checkbox" checked={s3.forcePathStyle} onChange={(e) => setS3({ ...s3, forcePathStyle: e.target.checked })} />
              <span>
                <b>path-style addresses</b>
                <small>bucket in the path, not the host name; what MinIO and some others want</small>
              </span>
            </label>
          </div>
        )}

        <div className="config-fields" style={{ marginTop: 16 }}>
          <label className="config-field">
            <span>nightly at (server local time)</span>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <label className="config-field">
            <span>archives to keep</span>
            <input inputMode="numeric" value={keep} onChange={(e) => setKeep(e.target.value)} />
          </label>
          <label className="config-field">
            <span>
              passphrase {settings.passphraseSet && <em className="muted">(set; leave blank to keep)</em>}
            </span>
            <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder={settings.passphraseSet ? "••••••••••••" : "at least 12 characters; encrypts every archive"} autoComplete="new-password" disabled={clearPassphrase} />
          </label>
        </div>
        <div className="backup-options">
            <label className="policy-option">
              <input type="checkbox" checked={schedule} onChange={(e) => setSchedule(e.target.checked)} />
              <span>
                <b>run nightly</b>
                <small>off leaves only "back up now" and the CLI</small>
              </span>
            </label>
            <label className="policy-option">
              <input type="checkbox" checked={includeRecordings} onChange={(e) => setIncludeRecordings(e.target.checked)} />
              <span>
                <b>include recordings</b>
                <small>recorded content can be large; keep it encrypted</small>
              </span>
            </label>
            {settings.passphraseSet && (
              <label className="policy-option">
                <input type="checkbox" checked={clearPassphrase} onChange={(e) => setClearPassphrase(e.target.checked)} />
                <span>
                  <b>remove the passphrase</b>
                  <small>new archives will not be encrypted; old ones still need it</small>
                </span>
              </label>
            )}
        </div>
        <div className="row-actions" style={{ marginTop: 16 }}>
          <button type="submit" className="primary" disabled={busy !== null}>
            {busy === "save" ? "…" : "save"}
          </button>
          <button type="button" className="ghost" disabled={busy !== null || !overview.configured} onClick={() => void run("check", () => api(`${base}/check`, apiKey, { method: "POST" }), "The destination is writable.")}>
            {busy === "check" ? "…" : "test destination"}
          </button>
          <span className="muted">
            Backed up: {overview.paths?.configFile ? "the configuration, " : ""}everything under {overview.paths?.dataDir ?? "the data directory"} except recordings unless included. Archives are readable by <code>tar</code> when not encrypted.
          </span>
        </div>
      </form>
    </>
  )
}

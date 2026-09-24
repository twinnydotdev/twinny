/**
 * The gateway's licence: one token in one file, read like the key file.
 *
 * The file holds the token text and nothing else. It is reread when it
 * changes on disk, so `twinny-server license set` and the admin page take
 * effect without a restart. An unreadable or unverifiable token is not a
 * startup error: the gateway runs on the free plan and says why.
 *
 * What the licence allows is decided in `src/licensing` (pure); this file
 * only does the I/O and joins the answer to the key store.
 */
import fs from "node:fs"

import { messageOf } from "../common/errors"
import {
  Entitlements,
  entitlementsFor,
  LicenseClaims,
  LicenseError,
  LicenseInput,
  seatedKeyIds,
  seatRefusal,
  TRUSTED_LICENSE_KEYS,
  unseatedRefusal,
  verifyLicenseToken
} from "../licensing"

import type { KeyRecord } from "./keys"
import { writePrivateFile } from "./private-file"

/** What the admin API, the CLI and the banner all show. */
export interface LicenseSummary extends Entitlements {
  /** Active keys right now. */
  used: number
  /** Names of active keys that hold no seat, oldest first. Empty when all fit. */
  unseated: string[]
}

export class LicenseStore {
  private _license: LicenseInput | undefined
  private _mtimeMs = -1
  private _checkedAt = 0

  constructor(
    public readonly file: string,
    private readonly _trustedKeys: readonly string[] = TRUSTED_LICENSE_KEYS,
    private readonly _minRefreshMs = 1_000
  ) {}

  /** Loads the file; a missing file is the free plan. */
  public static open(file: string, trustedKeys?: readonly string[], minRefreshMs?: number): LicenseStore {
    const store = new LicenseStore(file, trustedKeys, minRefreshMs)
    store.reload()
    return store
  }

  /** Whether a licence file exists at all, valid or not. */
  public get installed(): boolean {
    return this._license !== undefined
  }

  public claims(): LicenseClaims | undefined {
    return this._license?.claims
  }

  public current(now = new Date()): Entitlements {
    return entitlementsFor(this._license, now)
  }

  /** Verifies a token against the trusted keys and, if it passes, keeps it. */
  public install(token: string): Entitlements {
    const verified = verifyLicenseToken(token, this._trustedKeys)
    writePrivateFile(this.file, `${verified.token}\n`)
    this.reload()
    return this.current()
  }

  /** Deletes the licence file. Returns whether there was one. */
  public remove(): boolean {
    try {
      fs.unlinkSync(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.reload()
        return false
      }
      throw error
    }
    this.reload()
    return true
  }

  /** Rereads the file when it changed on disk, at most every `minRefreshMs`. */
  public refresh(now = Date.now()): void {
    if (now - this._checkedAt < this._minRefreshMs) return
    this._checkedAt = now
    let mtimeMs = -1
    try {
      mtimeMs = fs.statSync(this.file).mtimeMs
    } catch {
      // Gone: free plan.
    }
    if (mtimeMs !== this._mtimeMs) this.reload()
  }

  public reload(): void {
    let text: string
    try {
      text = fs.readFileSync(this.file, "utf8")
      this._mtimeMs = fs.statSync(this.file).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this._license = undefined
        this._mtimeMs = -1
        return
      }
      this._license = { invalid: `cannot read ${this.file}: ${messageOf(error)}` }
      return
    }
    try {
      const verified = verifyLicenseToken(text.trim(), this._trustedKeys)
      this._license = { claims: verified.claims }
    } catch (error) {
      this._license = {
        invalid: error instanceof LicenseError ? `${error.message} [${error.code}]` : messageOf(error)
      }
    }
  }

  /* ---- joining the licence to the keys ---------------------------------- */

  /** Why one more key may not be made now, or nothing. */
  public refuseNewKey(active: KeyRecord[], now = new Date()): string | undefined {
    return seatRefusal(this.current(now), active.length)
  }

  /** Whether a key holds a seat; the message to refuse it with when not. */
  public seat(record: KeyRecord, active: KeyRecord[], now = new Date()): string | undefined {
    const entitlements = this.current(now)
    if (active.length <= entitlements.seats) return undefined
    return seatedKeyIds(active, entitlements.seats).has(record.id) ? undefined : unseatedRefusal(entitlements)
  }

  public summary(active: KeyRecord[], now = new Date()): LicenseSummary {
    const entitlements = this.current(now)
    const seated = seatedKeyIds(active, entitlements.seats)
    const unseated = [...active]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .filter((key) => !seated.has(key.id))
      .map((key) => key.name)
    return { ...entitlements, used: active.length, unseated }
  }
}

/** One line for the startup banner and the CLI. */
export const describePlan = (summary: LicenseSummary): string => {
  const seats = `${summary.used} of ${summary.seats} seat${summary.seats === 1 ? "" : "s"} used`
  switch (summary.status) {
    case "free":
      return `Free plan, ${seats}`
    case "licensed":
      return `${summary.org}, ${seats}, licence until ${summary.expiresAt?.slice(0, 10)}`
    case "expiring":
      return `${summary.org}, ${seats}, licence expires ${summary.expiresAt?.slice(0, 10)}: renew soon`
    case "grace":
      return `${summary.org}, ${seats}, licence EXPIRED ${summary.expiresAt?.slice(0, 10)} (grace period)`
    case "expired":
      return `Free plan, ${seats}; the ${summary.org} licence expired ${summary.expiresAt?.slice(0, 10)}`
    case "invalid":
      return `Free plan, ${seats}; the installed licence is not usable`
  }
}

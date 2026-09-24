/**
 * Named access keys for the gateway.
 *
 * A key is `tsk_<id>_<secret>` (8 and 64 hex characters). The file keeps the id, a name, the SHA-256
 * of the secret, and when it was made and revoked; the secret itself is
 * shown once, at creation, and never stored. Verification finds the record
 * by id and compares hashes in constant time.
 *
 * The file is rewritten atomically with owner-only permissions. A server
 * that holds a store calls `refresh()` before authenticating so a key made
 * or revoked by the CLI while it runs takes effect without a restart.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import fs from "node:fs"

import { isRecord } from "../common/guards"

import { writePrivateJson } from "./private-file"

export const KEY_PREFIX = "tsk"
const ID_BYTES = 4
const SECRET_BYTES = 32
const KEY_PATTERN = /^tsk_([0-9a-f]{8})_([0-9a-f]{64})$/

export const KEY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/

export interface KeyRecord {
  id: string
  name: string
  /** SHA-256 of the secret, hex. */
  hash: string
  createdAt: string
  revokedAt?: string
  /** May read the admin routes: usage for everyone, the key list, status. */
  admin?: boolean
  /** An admin that may look but not change anything: the audit log, usage, people, without the buttons. */
  readOnly?: boolean
}

interface KeysFile {
  version: 1
  keys: KeyRecord[]
}

export const hashSecret = (secret: string): string =>
  createHash("sha256").update(secret, "utf8").digest("hex")

const parseKeysFile = (text: string, file: string): KeysFile => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.keys)) {
    throw new Error(`${file} is not a twinny-server keys file.`)
  }
  const keys: KeyRecord[] = []
  for (const entry of parsed.keys) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.hash !== "string" ||
      typeof entry.createdAt !== "string"
    ) {
      throw new Error(`${file} has a malformed key entry.`)
    }
    keys.push({
      id: entry.id,
      name: entry.name,
      hash: entry.hash,
      createdAt: entry.createdAt,
      ...(typeof entry.revokedAt === "string" ? { revokedAt: entry.revokedAt } : {}),
      ...(entry.admin === true ? { admin: true } : {}),
      ...(entry.readOnly === true ? { readOnly: true } : {})
    })
  }
  return { version: 1, keys }
}

export class KeyStore {
  private _keys: KeyRecord[] = []
  private _mtimeMs = -1
  private _checkedAt = 0

  constructor(
    public readonly file: string,
    /** How often `refresh()` bothers to stat the file. */
    private readonly _minRefreshMs = 1_000
  ) {}

  /** Loads the file; a missing file is an empty store. */
  public static open(file: string, minRefreshMs?: number): KeyStore {
    const store = new KeyStore(file, minRefreshMs)
    store.reload()
    return store
  }

  public list(): KeyRecord[] {
    return this._keys.map((key) => ({ ...key }))
  }

  public active(): KeyRecord[] {
    return this.list().filter((key) => !key.revokedAt)
  }

  /**
   * Makes a key. The returned `key` is the only copy of the secret. Names
   * are unique among active keys, so a revoked name can be reused.
   */
  public create(name: string, options: { admin?: boolean; readOnly?: boolean } = {}): { key: string; record: KeyRecord } {
    if (!KEY_NAME_PATTERN.test(name)) {
      throw new Error(
        `"${name}" is not a valid key name: letters, digits, . _ @ - and up to 64 characters.`
      )
    }
    if (this.active().some((key) => key.name === name)) {
      throw new Error(`An active key named "${name}" already exists. Revoke it first, or pick another name.`)
    }
    let id = randomBytes(ID_BYTES).toString("hex")
    while (this._keys.some((key) => key.id === id)) id = randomBytes(ID_BYTES).toString("hex")
    const secret = randomBytes(SECRET_BYTES).toString("hex")
    const record: KeyRecord = {
      id,
      name,
      hash: hashSecret(secret),
      createdAt: new Date().toISOString(),
      ...(options.admin ? { admin: true } : {}),
      ...(options.admin && options.readOnly ? { readOnly: true } : {})
    }
    this._keys.push(record)
    this.save()
    return { key: `${KEY_PREFIX}_${id}_${secret}`, record: { ...record } }
  }

  /** Revokes by id or by active name. Returns the record, or undefined when nothing matched. */
  public revoke(idOrName: string): KeyRecord | undefined {
    const record =
      this._keys.find((key) => key.id === idOrName && !key.revokedAt) ??
      this._keys.find((key) => key.name === idOrName && !key.revokedAt)
    if (!record) return undefined
    record.revokedAt = new Date().toISOString()
    this.save()
    return { ...record }
  }

  /** Drops revoked records for good; active keys are never dropped. Returns how many went. */
  public forget(ids: string[]): number {
    const before = this._keys.length
    this._keys = this._keys.filter((key) => !key.revokedAt || !ids.includes(key.id))
    if (this._keys.length !== before) this.save()
    return before - this._keys.length
  }

  /** The active record a presented key belongs to, or undefined. */
  public verify(presented: string | undefined): KeyRecord | undefined {
    const match = presented ? KEY_PATTERN.exec(presented) : null
    if (!match) return undefined
    const [, id, secret] = match
    const record = this._keys.find((key) => key.id === id)
    if (!record || record.revokedAt) return undefined
    const expected = Buffer.from(record.hash, "hex")
    const actual = Buffer.from(hashSecret(secret), "hex")
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined
    return { ...record }
  }

  /**
   * Why a presented key is refused, in words the caller can act on. The
   * key id is not secret, so saying "revoked" rather than "invalid" costs
   * nothing and saves a developer a confused hour.
   */
  public explain(presented: string): string {
    const match = KEY_PATTERN.exec(presented)
    if (!match) return "This gateway key is not in the expected form."
    const record = this._keys.find((key) => key.id === match[1])
    if (!record) return "This gateway key is not known to the gateway."
    if (record.revokedAt) {
      return `This gateway key was revoked on ${record.revokedAt.slice(0, 10)}. Ask the gateway operator for a new one.`
    }
    return "This gateway key is not valid."
  }

  /** Whether a string is shaped like one of these keys at all. */
  public static looksLikeKey(presented: string | undefined): boolean {
    return !!presented && presented.startsWith(`${KEY_PREFIX}_`)
  }

  /** Rereads the file when it changed on disk, at most every `minRefreshMs`. */
  public refresh(now = Date.now()): void {
    if (now - this._checkedAt < this._minRefreshMs) return
    this._checkedAt = now
    let mtimeMs = -1
    try {
      mtimeMs = fs.statSync(this.file).mtimeMs
    } catch {
      // Gone: every key is gone with it.
    }
    if (mtimeMs !== this._mtimeMs) this.reload()
  }

  public reload(): void {
    try {
      const text = fs.readFileSync(this.file, "utf8")
      this._keys = parseKeysFile(text, this.file).keys
      this._mtimeMs = fs.statSync(this.file).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this._keys = []
        this._mtimeMs = -1
        return
      }
      throw error
    }
  }

  private save(): void {
    const content: KeysFile = { version: 1, keys: this._keys }
    writePrivateJson(this.file, content)
    this._mtimeMs = fs.statSync(this.file).mtimeMs
  }
}

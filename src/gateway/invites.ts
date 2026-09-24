/**
 * Invites: a link the admin sends that connects a developer without a
 * code being read out or a key pasted.
 *
 *   admin    POST /twinny/v1/admin/invites { name }      → { code, expiresAt }   (code shown once)
 *   admin    sends  vscode://rjmacarthy.twinny/join?url=<gateway>&code=<code>
 *   VS Code  POST /twinny/v1/join { code, machine }      → { key, name }         (once, no credential)
 *
 * A code is `twi_<id>_<secret>` like a key; only the SHA-256 of the secret
 * is kept, in invites.json next to the keys file, so an invite survives a
 * gateway restart and a copy of the file redeems nothing. One use, seven
 * days. The key is minted at redemption, under the name the admin chose,
 * so an invite nobody opens never holds a seat.
 */
import { randomBytes, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { isRecord } from "../common/guards"

import { hashSecret, KEY_NAME_PATTERN } from "./keys"
import { writePrivateJson } from "./private-file"

export const INVITE_PREFIX = "twi"
const ID_BYTES = 4
const SECRET_BYTES = 32
const CODE_PATTERN = /^twi_([0-9a-f]{8})_([0-9a-f]{64})$/

export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000
/** Redeemed and expired invites are kept this long for the record, then dropped. */
const KEEP_DONE_MS = 30 * 24 * 60 * 60_000
/** Open invites at once; an admin page cannot fill the disk by accident. */
export const MAX_PENDING_INVITES = 500
const MACHINE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@ -]{0,63}$/

export interface InviteRecord {
  id: string
  /** The key name minted at redemption. */
  name: string
  admin?: boolean
  /** Redeeming revokes the active key of the same name, for a lost-key replacement. */
  replace?: boolean
  /** SHA-256 of the secret, hex. */
  hash: string
  createdAt: string
  expiresAt: string
  /** The admin key that made it. */
  createdBy: string
  redeemedAt?: string
  /** The redeemer's machine, as VS Code reported it. */
  machine?: string
  keyId?: string
  revokedAt?: string
}

/** What the admin page lists: never the hash. */
export interface PendingInvite {
  id: string
  name: string
  admin?: boolean
  replace?: boolean
  createdAt: string
  expiresAt: string
  createdBy: string
}

export interface InviteInput {
  name: string
  admin?: boolean
  replace?: boolean
  createdBy: string
  /** How long the invite stays open; seven days unless given. */
  ttlMs?: number
}

interface InvitesFile {
  version: 1
  invites: InviteRecord[]
}

export class InviteError extends Error {
  constructor(
    message: string,
    /** The HTTP status a route should answer with. */
    public readonly status: number
  ) {
    super(message)
    this.name = "InviteError"
  }
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

const parseInvitesFile = (text: string, file: string): InvitesFile => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.invites)
  ) {
    throw new Error(`${file} is not a twinny-server invites file.`)
  }
  const invites: InviteRecord[] = []
  for (const entry of parsed.invites) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.hash !== "string" ||
      typeof entry.createdAt !== "string" ||
      typeof entry.expiresAt !== "string"
    ) {
      throw new Error(`${file} has a malformed invite entry.`)
    }
    invites.push({
      id: entry.id,
      name: entry.name,
      hash: entry.hash,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      createdBy: str(entry.createdBy) ?? "",
      ...(entry.admin === true ? { admin: true } : {}),
      ...(entry.replace === true ? { replace: true } : {}),
      ...(str(entry.redeemedAt)
        ? { redeemedAt: entry.redeemedAt as string }
        : {}),
      ...(str(entry.machine) ? { machine: entry.machine as string } : {}),
      ...(str(entry.keyId) ? { keyId: entry.keyId as string } : {}),
      ...(str(entry.revokedAt) ? { revokedAt: entry.revokedAt as string } : {})
    })
  }
  return { version: 1, invites }
}

export const isInviteCode = (value: unknown): value is string =>
  typeof value === "string" && CODE_PATTERN.test(value)

export const cleanMachine = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const text = value.trim()
  return MACHINE_PATTERN.test(text) ? text : undefined
}

/** The file that goes with a keys file. */
export const invitesFileFor = (keysFile: string): string =>
  path.join(path.dirname(keysFile), "invites.json")

const toPending = (invite: InviteRecord): PendingInvite => ({
  id: invite.id,
  name: invite.name,
  ...(invite.admin ? { admin: true } : {}),
  ...(invite.replace ? { replace: true } : {}),
  createdAt: invite.createdAt,
  expiresAt: invite.expiresAt,
  createdBy: invite.createdBy
})

export class InviteStore {
  private _invites: InviteRecord[] = []

  constructor(
    public readonly file: string,
    private readonly _now: () => number = Date.now
  ) {}

  /** Loads the file; a missing file is an empty store. */
  public static open(file: string, now?: () => number): InviteStore {
    const store = new InviteStore(file, now)
    store.reload()
    return store
  }

  private isOpen(invite: InviteRecord, now = this._now()): boolean {
    return (
      !invite.redeemedAt &&
      !invite.revokedAt &&
      Date.parse(invite.expiresAt) > now
    )
  }

  /** Invites still waiting to be opened, newest first. */
  public pending(): PendingInvite[] {
    this.reload()
    const now = this._now()
    return this._invites
      .filter((invite) => this.isOpen(invite, now))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(toPending)
  }

  /**
   * Makes an invite. The returned `code` is the only copy of the secret.
   * `hasActiveKey` says whether the name is taken already, so the admin
   * chooses between another name and a replacement before anything is sent.
   */
  public create(
    input: InviteInput,
    hasActiveKey: (name: string) => boolean
  ): { code: string; record: PendingInvite } {
    this.reload()
    const name = input.name.trim()
    if (!KEY_NAME_PATTERN.test(name)) {
      throw new InviteError(
        `"${name}" is not a valid key name: letters, digits, . _ @ - and up to 64 characters.`,
        400
      )
    }
    if (hasActiveKey(name) && !input.replace) {
      throw new InviteError(
        `An active key named "${name}" already exists. Invite with "replace" to revoke it when the invite is opened, or pick another name.`,
        409
      )
    }
    const now = this._now()
    if (
      this._invites.filter((invite) => this.isOpen(invite, now)).length >=
      MAX_PENDING_INVITES
    ) {
      throw new InviteError(
        `There are already ${MAX_PENDING_INVITES} open invites. Revoke some or let them expire.`,
        429
      )
    }
    let id = randomBytes(ID_BYTES).toString("hex")
    while (this._invites.some((invite) => invite.id === id))
      id = randomBytes(ID_BYTES).toString("hex")
    const secret = randomBytes(SECRET_BYTES).toString("hex")
    const record: InviteRecord = {
      id,
      name,
      hash: hashSecret(secret),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (input.ttlMs ?? INVITE_TTL_MS)).toISOString(),
      createdBy: input.createdBy,
      ...(input.admin ? { admin: true } : {}),
      ...(input.replace ? { replace: true } : {})
    }
    this._invites.push(record)
    this.save()
    return {
      code: `${INVITE_PREFIX}_${id}_${secret}`,
      record: toPending(record)
    }
  }

  /** Withdraws an open invite. False when there was nothing open with that id. */
  public revoke(id: string): boolean {
    this.reload()
    const invite = this._invites.find((entry) => entry.id === id)
    if (!invite || !this.isOpen(invite)) return false
    invite.revokedAt = new Date(this._now()).toISOString()
    this.save()
    return true
  }

  /** The open invite a code names, or the reason it cannot be used. */
  public lookup(code: unknown): InviteRecord {
    this.reload()
    const match = typeof code === "string" ? CODE_PATTERN.exec(code) : null
    if (!match) throw new InviteError("That is not an invite code.", 400)
    const [, id, secret] = match
    const invite = this._invites.find((entry) => entry.id === id)
    const presented = Buffer.from(hashSecret(secret), "hex")
    const stored = Buffer.from(invite?.hash ?? hashSecret(""), "hex")
    if (
      !invite ||
      presented.length !== stored.length ||
      !timingSafeEqual(presented as Uint8Array, stored as Uint8Array)
    ) {
      throw new InviteError(
        "This invite is not known to this gateway. Ask your admin for a new one.",
        404
      )
    }
    if (invite.redeemedAt)
      throw new InviteError(
        "This invite has already been used. Ask your admin for a new one.",
        410
      )
    if (invite.revokedAt)
      throw new InviteError(
        "This invite was withdrawn. Ask your admin for a new one.",
        410
      )
    if (Date.parse(invite.expiresAt) <= this._now()) {
      throw new InviteError(
        "This invite has expired. Ask your admin for a new one.",
        410
      )
    }
    return { ...invite }
  }

  /**
   * Opens an invite: `mint` makes the key (and may refuse: no seat) and
   * only a key that was made marks the invite used.
   */
  public redeem(
    code: unknown,
    machine: unknown,
    mint: (invite: InviteRecord) => { key: string; keyId: string }
  ): { key: string; name: string; admin: boolean } {
    const invite = this.lookup(code)
    const made = mint(invite)
    const stored = this._invites.find(
      (entry) => entry.id === invite.id
    ) as InviteRecord
    stored.redeemedAt = new Date(this._now()).toISOString()
    stored.keyId = made.keyId
    const cleaned = cleanMachine(machine)
    if (cleaned) stored.machine = cleaned
    this.save()
    return { key: made.key, name: invite.name, admin: invite.admin === true }
  }

  public reload(): void {
    try {
      const text = fs.readFileSync(this.file, "utf8")
      this._invites = parseInvitesFile(text, this.file).invites
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this._invites = []
        return
      }
      throw error
    }
  }

  private save(): void {
    const now = this._now()
    // Finished invites are kept a while for the record, not forever.
    this._invites = this._invites.filter((invite) => {
      if (this.isOpen(invite, now)) return true
      const done = Date.parse(
        invite.redeemedAt ?? invite.revokedAt ?? invite.expiresAt
      )
      return now - done < KEEP_DONE_MS
    })
    const content: InvitesFile = { version: 1, invites: this._invites }
    writePrivateJson(this.file, content)
  }
}

/**
 * Sign-in requests: how a developer gets a key without anyone pasting one
 * into a chat.
 *
 *   VS Code  → POST /twinny/v1/signin        → { deviceCode, userCode }   (no credential)
 *   VS Code  shows "give your admin the code WXYZ-2345" and polls
 *   admin    approves the code on the admin page, with the developer's name
 *   gateway  mints a key for that name
 *   VS Code  → POST /twinny/v1/signin/poll    → { status: "approved", key } (once)
 *
 * Everything lives in memory: a request that is not approved within ten
 * minutes is gone. The device code (32 random bytes) is the only thing that
 * can collect the key; the user code is short enough to read out loud and
 * only lets an admin approve or deny. Bounded per client address and in
 * total, so an open port cannot fill memory.
 */
import { randomBytes, randomInt } from "node:crypto"

/** No 0/O, 1/I/L, or vowels that spell things. */
const CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789"
const CODE_PATTERN = /^[BCDFGHJKMNPQRSTVWXYZ23456789]{4}-[BCDFGHJKMNPQRSTVWXYZ23456789]{4}$/
const DEVICE_CODE_BYTES = 32
const DEVICE_CODE_PATTERN = /^[0-9a-f]{64}$/

export const SIGNIN_TTL_MS = 10 * 60_000
/** How often a client should poll, in seconds; also the minimum the gateway answers at. */
export const SIGNIN_POLL_INTERVAL_S = 3
export const MAX_PENDING_SIGNINS = 100
export const MAX_PENDING_PER_ADDRESS = 5
/** What a requester may suggest; the admin decides the actual key name. */
const SUGGESTION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@ -]{0,63}$/

export interface SignInRequestInput {
  /** The requester's suggested key name, e.g. their username. Untrusted; cleaned here. */
  name?: unknown
  /** The requester's machine, to help the admin recognise the request. Untrusted; cleaned here. */
  machine?: unknown
  /** Where the request came from, for the per-address cap. */
  address: string
}

export interface SignInStarted {
  deviceCode: string
  userCode: string
  expiresAt: string
  /** Seconds between polls. */
  interval: number
}

/** What the admin sees. Never the device code. */
export interface PendingSignIn {
  userCode: string
  name?: string
  machine?: string
  createdAt: string
  expiresAt: string
}

export type SignInPoll =
  | { status: "pending" }
  | { status: "slow-down" }
  | { status: "approved"; key: string; name: string }
  | { status: "denied" }
  | { status: "expired" }

interface Record_ {
  deviceCode: string
  userCode: string
  name?: string
  machine?: string
  address: string
  createdAt: number
  expiresAt: number
  lastPollAt: number
  state: "pending" | "approved" | "denied"
  /** Set once approved; handed over exactly once. */
  key?: string
  keyName?: string
}

const clean = (value: unknown, pattern: RegExp): string | undefined => {
  if (typeof value !== "string") return undefined
  const text = value.trim()
  return pattern.test(text) ? text : undefined
}

export const isUserCode = (value: unknown): value is string =>
  typeof value === "string" && CODE_PATTERN.test(value.trim().toUpperCase())

export const normalizeUserCode = (value: string): string => value.trim().toUpperCase()

const newUserCode = (): string => {
  const pick = () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  const half = () => pick() + pick() + pick() + pick()
  return `${half()}-${half()}`
}

export class SignInRequests {
  private readonly _records = new Map<string, Record_>()

  constructor(private readonly _now: () => number = Date.now) {}

  public get size(): number {
    this.prune()
    return this._records.size
  }

  /** Starts a request, or throws with a reason the client can show. */
  public start(input: SignInRequestInput): SignInStarted {
    this.prune()
    const now = this._now()
    const pending = [...this._records.values()].filter((r) => r.state === "pending")
    if (pending.filter((r) => r.address === input.address).length >= MAX_PENDING_PER_ADDRESS) {
      throw new Error(
        `Too many sign-in requests are waiting from this address (${MAX_PENDING_PER_ADDRESS}). ` +
          "Ask the admin to approve or deny them, or wait for them to expire."
      )
    }
    if (pending.length >= MAX_PENDING_SIGNINS) {
      // Make room by dropping the oldest pending request rather than refusing everyone.
      const oldest = pending.sort((a, b) => a.createdAt - b.createdAt)[0]
      this._records.delete(oldest.deviceCode)
    }
    let userCode = newUserCode()
    while (this.byUserCode(userCode)) userCode = newUserCode()
    const deviceCode = randomBytes(DEVICE_CODE_BYTES).toString("hex")
    const record: Record_ = {
      deviceCode,
      userCode,
      address: input.address,
      createdAt: now,
      expiresAt: now + SIGNIN_TTL_MS,
      lastPollAt: 0,
      state: "pending"
    }
    const name = clean(input.name, SUGGESTION_PATTERN)
    const machine = clean(input.machine, SUGGESTION_PATTERN)
    if (name) record.name = name
    if (machine) record.machine = machine
    this._records.set(deviceCode, record)
    return {
      deviceCode,
      userCode,
      expiresAt: new Date(record.expiresAt).toISOString(),
      interval: SIGNIN_POLL_INTERVAL_S
    }
  }

  /** Pending requests, oldest first, for the admin. */
  public pending(): PendingSignIn[] {
    this.prune()
    return [...this._records.values()]
      .filter((r) => r.state === "pending")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({
        userCode: r.userCode,
        ...(r.name ? { name: r.name } : {}),
        ...(r.machine ? { machine: r.machine } : {}),
        createdAt: new Date(r.createdAt).toISOString(),
        expiresAt: new Date(r.expiresAt).toISOString()
      }))
  }

  /**
   * Approves a code. `mint` makes the key (and may refuse: no seat, bad
   * name); nothing changes here unless it succeeds. Returns the key name.
   */
  public approve(userCode: string, mint: () => { key: string; name: string }): string {
    const record = this.pendingByUserCode(userCode)
    const made = mint()
    record.state = "approved"
    record.key = made.key
    record.keyName = made.name
    // The key waits for the client; if it never comes, the key still exists
    // and the admin sees it in the list, so this cannot leak a key silently.
    return made.name
  }

  public deny(userCode: string): void {
    const record = this.pendingByUserCode(userCode)
    record.state = "denied"
  }

  /** The client's poll. An approved key is returned once and then forgotten here. */
  public poll(deviceCode: unknown): SignInPoll {
    this.prune()
    if (typeof deviceCode !== "string" || !DEVICE_CODE_PATTERN.test(deviceCode)) return { status: "expired" }
    const record = this._records.get(deviceCode)
    if (!record) return { status: "expired" }
    const now = this._now()
    if (record.state === "pending") {
      if (now - record.lastPollAt < SIGNIN_POLL_INTERVAL_S * 1000) return { status: "slow-down" }
      record.lastPollAt = now
      return { status: "pending" }
    }
    this._records.delete(deviceCode)
    if (record.state === "denied") return { status: "denied" }
    return { status: "approved", key: record.key as string, name: record.keyName as string }
  }

  private prune() {
    const now = this._now()
    for (const [code, record] of this._records) {
      if (record.expiresAt <= now) this._records.delete(code)
    }
  }

  private byUserCode(userCode: string): Record_ | undefined {
    for (const record of this._records.values()) if (record.userCode === userCode) return record
    return undefined
  }

  private pendingByUserCode(userCode: string): Record_ {
    this.prune()
    if (!isUserCode(userCode)) throw new Error("That is not a sign-in code. Codes look like WXYZ-2345.")
    const record = this.byUserCode(normalizeUserCode(userCode))
    if (!record || record.state !== "pending") {
      throw new Error("No sign-in request is waiting with that code. It may have expired (10 minutes) or already been handled.")
    }
    return record
  }
}

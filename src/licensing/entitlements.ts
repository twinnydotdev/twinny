/**
 * What a gateway may do, given the licence it holds (or does not).
 *
 * Pure: takes a verified licence and a clock, returns numbers and words.
 * The free tier is real and permanent; a licence raises the seat count
 * for as long as it is valid, then a grace period, then the gateway is
 * back on the free tier with the same rules everyone else has.
 *
 * Seats are active access keys. The oldest keys keep their seats when
 * there are more keys than seats, so a lapse never locks the operator
 * out: the admin key made on day one is the first one seated.
 */
import { LicenseClaims } from "./format"

/** Active keys a gateway may have without a licence. */
export const FREE_SEATS = 5
/** Days after expiry during which the licensed seat count still applies. */
export const GRACE_DAYS = 14
/** Days before expiry at which the admin page and log start saying so. */
export const RENEWAL_NOTICE_DAYS = 30

const DAY_MS = 86_400_000

export type PlanStatus =
  /** No licence installed; the free tier. */
  | "free"
  /** A licence, valid, not close to expiry. */
  | "licensed"
  /** Valid, but expiring within `RENEWAL_NOTICE_DAYS`. */
  | "expiring"
  /** Expired within the last `GRACE_DAYS`; licensed seats still apply. */
  | "grace"
  /** Expired past the grace; back to the free tier. */
  | "expired"
  /** A licence file exists but its token is not acceptable. Free tier applies. */
  | "invalid"

export interface Entitlements {
  status: PlanStatus
  /** Active keys the gateway may have right now. */
  seats: number
  org?: string
  licenseId?: string
  expiresAt?: string
  email?: string
  /** For `invalid`: why. For the others, a one-line account for a banner. */
  message: string
  features: string[]
}

export interface LicenseInput {
  claims?: LicenseClaims
  /** When the installed token could not be verified: the reason. */
  invalid?: string
}

const days = (from: number, to: number) => Math.ceil((to - from) / DAY_MS)

export const entitlementsFor = (license: LicenseInput | undefined, now = new Date()): Entitlements => {
  const free = (status: PlanStatus, message: string, extra: Partial<Entitlements> = {}): Entitlements => ({
    status,
    seats: FREE_SEATS,
    message,
    ...extra,
    features: []
  })
  if (!license) return free("free", `Free plan: up to ${FREE_SEATS} active keys. Add a licence to raise the limit.`)
  if (license.invalid !== undefined || !license.claims) {
    return free("invalid", `The installed licence is not usable (${license.invalid ?? "unknown reason"}); the free plan applies.`)
  }
  const { claims } = license
  const t = now.getTime()
  const expires = Date.parse(claims.expiresAt)
  const issued = Date.parse(claims.issuedAt)
  const base = {
    org: claims.org,
    licenseId: claims.id,
    expiresAt: claims.expiresAt,
    ...(claims.email ? { email: claims.email } : {}),
    features: claims.features ?? []
  }
  // The first five seats are free for everyone, so a licence can only add
  // to them: a token for fewer never takes a team below the free plan.
  const seats = Math.max(FREE_SEATS, claims.seats)
  const seatWord = `${seats} seat${seats === 1 ? "" : "s"}`
  if (t < issued) {
    return free("invalid", `The licence for ${claims.org} is not valid until ${claims.issuedAt.slice(0, 10)}; the free plan applies until then.`, base)
  }
  if (t < expires) {
    const left = days(t, expires)
    if (left <= RENEWAL_NOTICE_DAYS) {
      return {
        status: "expiring",
        seats,
        message: `Licensed to ${claims.org}: ${seatWord}. Expires in ${left} day${left === 1 ? "" : "s"} (${claims.expiresAt.slice(0, 10)}); renew to keep them.`,
        ...base
      }
    }
    return {
      status: "licensed",
      seats,
      message: `Licensed to ${claims.org}: ${seatWord} until ${claims.expiresAt.slice(0, 10)}.`,
      ...base
    }
  }
  const graceEnds = expires + GRACE_DAYS * DAY_MS
  if (t < graceEnds) {
    const left = days(t, graceEnds)
    return {
      status: "grace",
      seats,
      message: `The licence for ${claims.org} expired on ${claims.expiresAt.slice(0, 10)}. Its ${seatWord} apply for ${left} more day${left === 1 ? "" : "s"}, then the free plan (${FREE_SEATS}) does.`,
      ...base
    }
  }
  return free(
    "expired",
    `The licence for ${claims.org} expired on ${claims.expiresAt.slice(0, 10)} and its grace period has ended; the free plan (${FREE_SEATS} active keys) applies.`,
    base
  )
}

export interface SeatHolder {
  id: string
  createdAt: string
}

/**
 * Which active keys hold a seat: the oldest first, up to the seat count.
 * Keys made in the same millisecond keep the order they were given in,
 * which for the key store is the order they were made.
 */
export const seatedKeyIds = (active: SeatHolder[], seats: number): Set<string> => {
  const ordered = [...active].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return new Set(ordered.slice(0, Math.max(0, seats)).map((key) => key.id))
}

/** Why one more key may not be made now, or nothing. */
export const seatRefusal = (entitlements: Entitlements, activeKeys: number): string | undefined => {
  if (activeKeys < entitlements.seats) return undefined
  const plan =
    entitlements.status === "free" || entitlements.status === "invalid" || entitlements.status === "expired"
      ? `the free plan allows ${FREE_SEATS}`
      : `the licence for ${entitlements.org} allows ${entitlements.seats}`
  return (
    `No seat for a new key: ${activeKeys} active key${activeKeys === 1 ? "" : "s"} and ${plan}. ` +
    "Revoke a key you no longer need, or add seats with a Twinny licence (twinny-server license --help)."
  )
}

/** The message a developer sees when their key exists but has no seat. */
export const unseatedRefusal = (entitlements: Entitlements): string =>
  `This gateway key has no seat: the gateway has more active keys than its plan allows (${entitlements.seats}). ` +
  "Ask the gateway operator to add seats or revoke unused keys."

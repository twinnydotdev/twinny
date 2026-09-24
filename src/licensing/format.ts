/**
 * The Twinny licence token: what a paying team pastes into its gateway.
 *
 *   twl1.<base64url(claims JSON)>.<base64url(ed25519 signature)>
 *
 * The claims are public (org, seats, dates); the signature is what makes
 * them a licence. Verification needs only a trusted public key and
 * `node:crypto`, so this file ships inside the MIT gateway. Nothing here
 * can issue a token; the issuer lives in the private twinny-licence
 * repository.
 *
 * This module is deliberately free of imports from the rest of the
 * repository so the licensing package can be extracted as a unit.
 */
import { createPublicKey, KeyObject, verify as verifySignature } from "node:crypto"

import { isRecord } from "../common/guards"

export const LICENSE_TOKEN_PREFIX = "twl1"
export const LICENSE_CLAIMS_VERSION = 1

/**
 * Feature flags a licence may switch on. The list is the contract: a
 * gateway ignores names it does not know.
 *
 *   policy     the team policy block is sent to connected developers
 *   recording  the gateway may keep the content of requests the admin chooses
 */
export const LICENSE_FEATURES = ["policy", "recording", "plugins"] as const
export type LicenseFeature = (typeof LICENSE_FEATURES)[number]

export interface LicenseClaims {
  v: typeof LICENSE_CLAIMS_VERSION
  /** Stable identifier of this licence, for support and revocation lists. */
  id: string
  /** Who the licence was issued to, shown on the admin page. */
  org: string
  /** How many active access keys the gateway may have. */
  seats: number
  /** ISO 8601 instants. The licence is valid from `issuedAt` until `expiresAt`. */
  issuedAt: string
  expiresAt: string
  /** Optional contact for renewals; shown only to admins. */
  email?: string
  features?: LicenseFeature[]
}

export type LicenseProblem =
  | "malformed"
  | "bad-signature"
  | "bad-claims"
  | "untrusted-key"

export class LicenseError extends Error {
  constructor(
    public readonly code: LicenseProblem,
    message: string
  ) {
    super(message)
    this.name = "LicenseError"
  }
}

export const ORG_PATTERN = /^[^\p{C}]{1,120}$/u
export const LICENSE_ID_PATTERN = /^lic_[0-9a-f]{16}$/
export const MAX_SEATS = 1_000_000

const isInstant = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) && !Number.isNaN(Date.parse(value))

export const base64url = {
  encode: (bytes: Buffer): string => bytes.toString("base64url"),
  decode: (text: string): Buffer => {
    if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new LicenseError("malformed", "The licence token contains characters that do not belong in one.")
    return Buffer.from(text, "base64url")
  }
}

/** Checks a decoded claims object field by field. Throws `bad-claims` with a reason. */
export const parseLicenseClaims = (input: unknown): LicenseClaims => {
  if (!isRecord(input)) throw new LicenseError("bad-claims", "The licence claims are not an object.")
  const allowed = ["v", "id", "org", "seats", "issuedAt", "expiresAt", "email", "features"]
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new LicenseError("bad-claims", `The licence has an unknown field "${key}".`)
  }
  if (input.v !== LICENSE_CLAIMS_VERSION) {
    throw new LicenseError("bad-claims", `The licence is version ${String(input.v)}; this gateway understands version ${LICENSE_CLAIMS_VERSION}.`)
  }
  if (typeof input.id !== "string" || !LICENSE_ID_PATTERN.test(input.id)) {
    throw new LicenseError("bad-claims", "The licence has no valid id.")
  }
  if (typeof input.org !== "string" || !ORG_PATTERN.test(input.org.trim()) || input.org.trim() !== input.org) {
    throw new LicenseError("bad-claims", "The licence has no valid organisation name.")
  }
  if (typeof input.seats !== "number" || !Number.isInteger(input.seats) || input.seats < 1 || input.seats > MAX_SEATS) {
    throw new LicenseError("bad-claims", `The licence seat count must be a whole number between 1 and ${MAX_SEATS}.`)
  }
  if (!isInstant(input.issuedAt)) throw new LicenseError("bad-claims", "The licence has no valid issue date.")
  if (!isInstant(input.expiresAt)) throw new LicenseError("bad-claims", "The licence has no valid expiry date.")
  if (Date.parse(input.expiresAt) <= Date.parse(input.issuedAt)) {
    throw new LicenseError("bad-claims", "The licence expires before it was issued.")
  }
  const claims: LicenseClaims = {
    v: LICENSE_CLAIMS_VERSION,
    id: input.id,
    org: input.org,
    seats: input.seats,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt
  }
  if (input.email !== undefined) {
    if (typeof input.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || input.email.length > 254) {
      throw new LicenseError("bad-claims", "The licence contact email is not valid.")
    }
    claims.email = input.email
  }
  if (input.features !== undefined) {
    if (!Array.isArray(input.features) || input.features.some((f) => typeof f !== "string")) {
      throw new LicenseError("bad-claims", "The licence feature list is not a list of names.")
    }
    // Unknown features are kept out rather than refused, so an older
    // gateway still accepts a newer licence and simply ignores what it
    // cannot do.
    const known = new Set<string>(LICENSE_FEATURES)
    claims.features = (input.features as string[]).filter((f): f is LicenseFeature => known.has(f))
  }
  return claims
}

export interface DecodedLicense {
  claims: LicenseClaims
  /** The exact bytes the signature covers. */
  payload: Buffer
  signature: Buffer
}

/** Splits and decodes a token without checking the signature. */
export const decodeLicenseToken = (token: string): DecodedLicense => {
  const parts = token.trim().split(".")
  if (parts.length !== 3 || parts[0] !== LICENSE_TOKEN_PREFIX) {
    throw new LicenseError("malformed", `A licence token looks like ${LICENSE_TOKEN_PREFIX}.<claims>.<signature>.`)
  }
  const payload = base64url.decode(parts[1])
  const signature = base64url.decode(parts[2])
  if (signature.length !== 64) throw new LicenseError("malformed", "The licence signature has the wrong length.")
  let parsed: unknown
  try {
    parsed = JSON.parse(payload.toString("utf8"))
  } catch {
    throw new LicenseError("malformed", "The licence claims are not JSON.")
  }
  return { claims: parseLicenseClaims(parsed), payload, signature }
}

/** Accepts a PEM (SPKI), a raw 32-byte key in base64, or an already-built key. */
export const toPublicKey = (key: string | KeyObject): KeyObject => {
  if (typeof key !== "string") return key
  const text = key.trim()
  if (text.startsWith("-----BEGIN")) return createPublicKey(text)
  // Raw Ed25519 public key: wrap in the SPKI prefix (12 bytes) DER.
  const raw = Buffer.from(text, "base64")
  if (raw.length !== 32) throw new LicenseError("untrusted-key", "A trusted key must be an Ed25519 public key.")
  const prefix = Buffer.from("302a300506032b6570032100", "hex")
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "spki" })
}

export interface VerifiedLicense {
  claims: LicenseClaims
  token: string
}

/**
 * Decodes a token and checks its signature against each trusted key in
 * turn. Trusting more than one key is how a signing key is rotated: the
 * new key is added, licences are reissued over time, the old key is removed.
 * Expiry is not judged here; the caller decides what an expired licence
 * means (see `entitlements.ts`).
 */
export const verifyLicenseToken = (token: string, trustedKeys: ReadonlyArray<string | KeyObject>): VerifiedLicense => {
  if (!trustedKeys.length) throw new LicenseError("untrusted-key", "This gateway trusts no licence signing key.")
  const decoded = decodeLicenseToken(token)
  for (const trusted of trustedKeys) {
    const key = toPublicKey(trusted)
    if (verifySignature(null, decoded.payload, key, decoded.signature)) {
      return { claims: decoded.claims, token: token.trim() }
    }
  }
  throw new LicenseError("bad-signature", "The licence signature does not match; the token was altered or was not issued by Twinny.")
}

/** A token as it should be shown in logs: the id and org only, never the signature. */
export const describeLicense = (claims: LicenseClaims): string =>
  `${claims.org} (${claims.id}, ${claims.seats} seat${claims.seats === 1 ? "" : "s"}, until ${claims.expiresAt.slice(0, 10)})`

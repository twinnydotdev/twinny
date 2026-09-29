/**
 * Signing licence tokens for tests, with a key made on the spot. The
 * real issuer lives in the private twinny-licence repository; this is
 * only what a test needs to produce a token the gateway will accept.
 */
import { generateKeyPairSync, sign } from "crypto"

import { base64url, LICENSE_CLAIMS_VERSION, LICENSE_TOKEN_PREFIX, LicenseClaims, parseLicenseClaims } from "../../../licensing/format"

export interface SigningKeys {
  privateKeyPem: string
  publicKeyPem: string
  /** The 32 raw public key bytes in base64: the form `trusted-keys.ts` uses. */
  publicKeyRaw: string
}

export const generateSigningKeys = (): SigningKeys => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }) as string,
    publicKeyRaw: spki.subarray(spki.length - 32).toString("base64")
  }
}

export interface IssueRequest {
  org: string
  seats: number
  issuedAt?: Date
  expiresAt?: Date
  validDays?: number
  email?: string
  features?: string[]
  id?: string
}

let counter = 0
const newId = () => `lic_${(++counter).toString(16).padStart(16, "0")}`

export const buildClaims = (request: IssueRequest): LicenseClaims => {
  const issuedAt = request.issuedAt ?? new Date()
  const expiresAt = request.expiresAt ?? new Date(issuedAt.getTime() + (request.validDays ?? 365) * 86_400_000)
  return parseLicenseClaims({
    v: LICENSE_CLAIMS_VERSION,
    id: request.id ?? newId(),
    org: request.org,
    seats: request.seats,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ...(request.email ? { email: request.email } : {}),
    ...(request.features?.length ? { features: request.features } : {})
  })
}

export const signLicense = (claims: LicenseClaims, privateKeyPem: string): string => {
  const payload = Buffer.from(JSON.stringify(claims), "utf8")
  const signature = sign(null, payload as NodeJS.ArrayBufferView, privateKeyPem)
  return `${LICENSE_TOKEN_PREFIX}.${base64url.encode(payload)}.${base64url.encode(signature)}`
}

export const issueLicense = (request: IssueRequest, privateKeyPem: string): { token: string; claims: LicenseClaims } => {
  const claims = buildClaims(request)
  return { token: signLicense(claims, privateKeyPem), claims }
}

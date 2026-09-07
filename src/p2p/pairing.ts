/**
 * Pairing codes: how a device earns the right to use a node.
 *
 * A code is the node's public key followed by a short random secret, as one
 * base64url string. The key half tells the client *who* to connect to (and
 * the Noise handshake then proves it really is them); the secret half proves
 * to the node that the client was shown the code. A code lives for a few
 * minutes, works once, and is thrown away by a wrong guess.
 */

import { randomBytes, timingSafeEqual } from "node:crypto"

import { PUBLIC_KEY_BYTES } from "./identity"

export const PAIRING_SECRET_BYTES = 8
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000

const CODE_BYTES = PUBLIC_KEY_BYTES + PAIRING_SECRET_BYTES

export interface PairingCode {
  publicKey: Buffer
  secret: Buffer
}

export const createPairingSecret = (): Buffer => randomBytes(PAIRING_SECRET_BYTES)

export const encodePairingCode = (publicKey: Buffer, secret: Buffer): string => {
  if (publicKey.length !== PUBLIC_KEY_BYTES) {
    throw new Error(`A public key is ${PUBLIC_KEY_BYTES} bytes`)
  }
  if (secret.length !== PAIRING_SECRET_BYTES) {
    throw new Error(`A pairing secret is ${PAIRING_SECRET_BYTES} bytes`)
  }
  return Buffer.concat([publicKey, secret]).toString("base64url")
}

/**
 * Accepts what a person is likely to paste: surrounding whitespace, line
 * breaks from a terminal wrap, and standard base64 padding or alphabet.
 */
export const decodePairingCode = (code: string): PairingCode => {
  const cleaned = code.replace(/\s+/g, "").replace(/=+$/, "")
  if (!cleaned) throw new Error("Enter the pairing code shown by the node.")
  if (!/^[A-Za-z0-9_+/-]+$/.test(cleaned)) {
    throw new Error("That does not look like a Twinny pairing code.")
  }
  const bytes = Buffer.from(cleaned, "base64url")
  if (bytes.length !== CODE_BYTES) {
    throw new Error(
      "That pairing code is the wrong length. Copy the whole code from the node."
    )
  }
  return {
    publicKey: bytes.subarray(0, PUBLIC_KEY_BYTES),
    secret: bytes.subarray(PUBLIC_KEY_BYTES)
  }
}

/**
 * One open pairing opportunity on the node. The secret is compared in
 * constant time and only once: a right guess pairs, a wrong guess closes the
 * window so the next attempt needs a freshly shown code.
 */
export class PairingWindow {
  public readonly secret: Buffer
  public readonly expiresAt: number
  private _used = false

  constructor(ttlMs = PAIRING_CODE_TTL_MS, now = Date.now()) {
    this.secret = createPairingSecret()
    this.expiresAt = now + ttlMs
  }

  public isOpen(now = Date.now()): boolean {
    return !this._used && now < this.expiresAt
  }

  /** Spends the window whatever the outcome. */
  public verify(secretHex: string, now = Date.now()): boolean {
    if (!this.isOpen(now)) return false
    this._used = true
    const offered = Buffer.from(secretHex, "hex")
    if (offered.length !== this.secret.length) return false
    return timingSafeEqual(offered, this.secret)
  }

  public close() {
    this._used = true
  }
}

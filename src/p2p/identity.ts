/**
 * Who a peer is.
 *
 * Both sides keep a random 32-byte seed; hyperdht derives an Ed25519 key
 * pair from it and the public key is the peer's identity on the network.
 * The node's public key doubles as its peer ID, and a client's public key
 * is what the node writes down when it trusts that client.
 */

import DHT from "hyperdht"
import { randomBytes } from "node:crypto"

export const SEED_BYTES = 32
export const PUBLIC_KEY_BYTES = 32

export interface KeyPair {
  publicKey: Buffer
  secretKey: Buffer
}

export const createSeed = (): Buffer => randomBytes(SEED_BYTES)

export const keyPairFromSeed = (seed: Buffer): KeyPair => {
  if (seed.length !== SEED_BYTES) {
    throw new Error(`An identity seed is ${SEED_BYTES} bytes`)
  }
  return DHT.keyPair(seed) as KeyPair
}

export const toHex = (bytes: Buffer): string => bytes.toString("hex")

export const publicKeyFromHex = (hex: string): Buffer => {
  const key = Buffer.from(hex.trim(), "hex")
  if (key.length !== PUBLIC_KEY_BYTES) {
    throw new Error("Not a valid peer ID")
  }
  return key
}

export const isPublicKeyHex = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)

/** The first few characters, for logs and labels: `8b23f1a0…`. */
export const shortKey = (hex: string): string => `${hex.slice(0, 8)}…`

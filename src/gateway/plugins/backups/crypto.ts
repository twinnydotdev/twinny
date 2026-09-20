/**
 * Archive encryption for a backup that leaves the machine: AES-256-GCM
 * with a key derived from a passphrase by scrypt. The format is small
 * and self-describing so a restore years later needs only the passphrase:
 *
 *   "TWBK1" | salt (16) | iv (12) | tag (16) | ciphertext
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync
} from "node:crypto"

const MAGIC = Buffer.from("TWBK1", "ascii")
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

const key = (passphrase: string, salt: Buffer): Buffer =>
  scryptSync(passphrase, salt as Uint8Array, 32, SCRYPT)

export const isEncryptedArchive = (data: Buffer): boolean =>
  data.length > MAGIC.length &&
  data.subarray(0, MAGIC.length).equals(MAGIC as Uint8Array)

export const encryptArchive = (plain: Buffer, passphrase: string): Buffer => {
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key(passphrase, salt) as Uint8Array, iv as Uint8Array)
  const body = Buffer.concat([cipher.update(plain as Uint8Array), cipher.final()])
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body])
}

/** Throws when the passphrase is wrong or the archive was altered. */
export const decryptArchive = (data: Buffer, passphrase: string): Buffer => {
  if (!isEncryptedArchive(data)) throw new Error("This is not an encrypted twinny backup.")
  let at = MAGIC.length
  const salt = data.subarray(at, (at += SALT_BYTES))
  const iv = data.subarray(at, (at += IV_BYTES))
  const tag = data.subarray(at, (at += TAG_BYTES))
  const body = data.subarray(at)
  const decipher = createDecipheriv("aes-256-gcm", key(passphrase, Buffer.from(salt)) as Uint8Array, iv as Uint8Array)
  decipher.setAuthTag(tag as Uint8Array)
  try {
    return Buffer.concat([decipher.update(body as Uint8Array), decipher.final()])
  } catch {
    throw new Error("The passphrase is wrong, or the backup is damaged.")
  }
}

/**
 * The devices a node trusts, kept in a small JSON file.
 *
 * Keyed by the device's public key; the name is only for the person reading
 * the list. Writes are synchronous and whole-file: the list is tiny and a
 * half-written trust file would be worse than a slow one.
 */

import fs from "node:fs"
import path from "node:path"

export interface TrustedPeer {
  name: string
  pairedAt: number
  lastSeenAt?: number
}

export type TrustedPeers = Record<string, TrustedPeer>

/** Where the list lives: a file for the CLI, extension storage in VS Code. */
export interface TrustStorage {
  read: () => unknown
  write: (peers: TrustedPeers) => void
}

export const fileTrustStorage = (filePath: string): TrustStorage => ({
  read: () => {
    if (!fs.existsSync(filePath)) return undefined
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  },
  write: (peers) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(peers, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, filePath)
  }
})

export class TrustStore {
  private _peers: TrustedPeers = {}
  private readonly _storage?: TrustStorage

  constructor(storage?: TrustStorage | string) {
    this._storage =
      typeof storage === "string" ? fileTrustStorage(storage) : storage
    this.load()
  }

  public has(publicKeyHex: string): boolean {
    return Object.prototype.hasOwnProperty.call(this._peers, publicKeyHex)
  }

  public get(publicKeyHex: string): TrustedPeer | undefined {
    return this._peers[publicKeyHex]
  }

  public list(): Array<TrustedPeer & { publicKey: string }> {
    return Object.entries(this._peers).map(([publicKey, peer]) => ({
      publicKey,
      ...peer
    }))
  }

  public add(publicKeyHex: string, name: string) {
    this._peers[publicKeyHex] = {
      name: name.trim() || "Twinny device",
      pairedAt: Date.now(),
      lastSeenAt: Date.now()
    }
    this.save()
  }

  public touch(publicKeyHex: string) {
    const peer = this._peers[publicKeyHex]
    if (!peer) return
    peer.lastSeenAt = Date.now()
    this.save()
  }

  public remove(publicKeyHex: string): boolean {
    if (!this.has(publicKeyHex)) return false
    delete this._peers[publicKeyHex]
    this.save()
    return true
  }

  private load() {
    if (!this._storage) return
    try {
      const parsed = this._storage.read()
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this._peers = {}
        for (const [key, value] of Object.entries(parsed as TrustedPeers)) {
          if (/^[0-9a-f]{64}$/i.test(key) && value && typeof value === "object") {
            this._peers[key.toLowerCase()] = {
              name: String(value.name || "Twinny device"),
              pairedAt: Number(value.pairedAt) || Date.now(),
              lastSeenAt: value.lastSeenAt ? Number(value.lastSeenAt) : undefined
            }
          }
        }
      }
    } catch {
      // A corrupt file trusts nobody, which is the safe reading of it.
      this._peers = {}
    }
  }

  private save() {
    this._storage?.write({ ...this._peers })
  }
}

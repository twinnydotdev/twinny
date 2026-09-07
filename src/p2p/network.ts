/**
 * The extension's one DHT node and the clients that share it.
 *
 * A network never listens for inbound connections, so the only streams it
 * ever sees are the ones its clients dialled. Each client owns the dialling
 * for its device; the network only hands out clients and tears everything
 * down together.
 */

import DHT from "hyperdht"

import { P2pClient, P2pClientOptions } from "./client"
import { toHex } from "./identity"
import { NetworkOptions, PeerDht } from "./types"

export class PeerNetwork {
  private readonly _dht: PeerDht
  private readonly _clients = new Map<string, P2pClient>()
  private _destroyed = false

  constructor(
    options: NetworkOptions,
    private readonly _clientOptions: P2pClientOptions = {}
  ) {
    this._dht = new DHT({
      seed: options.seed,
      bootstrap: options.bootstrap
    }) as PeerDht
  }

  public get publicKey(): Buffer {
    return this._dht.defaultKeyPair.publicKey
  }

  public get publicKeyHex(): string {
    return toHex(this.publicKey)
  }

  /** The client for a device, created on first use. */
  public client(remotePublicKey: Buffer): P2pClient {
    const hex = toHex(remotePublicKey)
    let client = this._clients.get(hex)
    if (!client) {
      client = new P2pClient(
        () => this._dht.connect(remotePublicKey),
        remotePublicKey,
        this._clientOptions
      )
      this._clients.set(hex, client)
    }
    return client
  }

  public has(remotePublicKeyHex: string): boolean {
    return this._clients.has(remotePublicKeyHex)
  }

  /** Drop a device: close its session and stop dialling it. */
  public forget(remotePublicKeyHex: string) {
    const client = this._clients.get(remotePublicKeyHex)
    if (!client) return
    this._clients.delete(remotePublicKeyHex)
    client.destroy()
  }

  public async destroy() {
    if (this._destroyed) return
    this._destroyed = true
    for (const hex of [...this._clients.keys()]) this.forget(hex)
    await this._dht.destroy()
  }
}

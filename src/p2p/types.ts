/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The surface of a hyperdht connection that this package relies on. The
 * real object is a Noise-encrypted duplex stream; only these members are
 * touched, so tests can hand in something much simpler.
 */
export interface PeerStream {
  destroyed: boolean
  remotePublicKey: Buffer
  publicKey?: Buffer
  on: (event: string, cb: (...args: any[]) => void) => unknown
  once: (event: string, cb: (...args: any[]) => void) => unknown
  removeListener: (event: string, cb: (...args: any[]) => void) => unknown
  write: (data: string | Buffer) => boolean
  end: () => void
  destroy: (error?: Error) => void
}

export interface PeerKeyPair {
  publicKey: Buffer
  secretKey: Buffer
}

/** A listening node on the DHT: what `createServer` gives back. */
export interface PeerServer {
  listen: (keyPair?: PeerKeyPair) => Promise<void>
  close: () => Promise<void>
}

/**
 * The parts of a hyperdht instance this package drives. Plain hyperdht
 * rather than hyperswarm on purpose: hyperswarm keeps one connection per
 * remote key and kills the older one, which breaks two VS Code windows that
 * share an identity. hyperdht lets each of them hold its own session.
 */
export interface PeerDht {
  defaultKeyPair: PeerKeyPair
  /** The UDP socket other peers reach this node on. */
  io: { serverSocket: { address: () => { port: number } } }
  connect: (remotePublicKey: Buffer) => PeerStream
  createServer: (
    options: {
      /** Return true to *reject* a peer; runs during the handshake. */
      firewall?: (remotePublicKey: Buffer) => boolean
    },
    onConnection: (stream: PeerStream) => void
  ) => PeerServer
  destroy: () => Promise<void>
}

export interface NetworkOptions {
  seed: Buffer
  /**
   * UDP port (or [from, to] range) to bind. hyperdht defaults to 49737 and
   * the five ports above it; `[0, 0]` asks for any free port.
   */
  port?: number | [number, number]
  /** Local DHT bootstrap nodes; only tests set this. */
  bootstrap?: unknown[]
}

/** Opens a fresh connection to one peer. */
export type Dialer = () => PeerStream

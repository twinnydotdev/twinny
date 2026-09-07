/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * A single duplex connection to another peer, as handed to us by hyperswarm.
 * Only the surface the connection manager actually uses is described here.
 */
export interface P2pPeer {
  destroy: (error?: Error) => void
  end: () => void
  on: (event: string, cb: (...args: any[]) => void) => void
  once: (event: string, cb: (...args: any[]) => void) => void
  remotePublicKey: Buffer
  removeAllListeners: () => void
  write: (data: string | Buffer) => boolean
  writable: boolean
}

/**
 * The envelope every message travels in. `key` names the message so peers can
 * route it; `data` is whatever payload that message carries.
 */
export interface P2pMessage<T = unknown> {
  key: string
  data?: T
}

export interface P2pJoinOptions {
  /** Look for peers announcing this topic. Defaults to true. */
  client?: boolean
  /** Announce this topic so other peers can find us. Defaults to true. */
  server?: boolean
}

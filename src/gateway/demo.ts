/**
 * Demo mode (`twinny-server serve --demo`): a gateway anyone may look at.
 *
 *   visitor  GET  /admin                     the page opens with no key, read-only
 *   visitor  POST /twinny/v1/demo/invite     → { code, name, expiresAt }   (no credential)
 *   VS Code  POST /twinny/v1/join            the ordinary invite route; the key is a guest key
 *
 * The page signs in as the visitor: an admin that may read and change
 * nothing, and that may not run inference. Trying the gateway from VS Code
 * goes through a guest: a short-lived invite whose key holds no seat, is
 * revoked after an hour and is forgotten a day later. Real admin keys work
 * as they always do.
 */
import type http from "node:http"

import type { InferenceClient } from "../extension/inference/types"
import type { RemoteRouteTarget } from "../protocol/handler"

/** The bearer the demo page presents. Public by design; it can only read. */
export const DEMO_VISITOR_TOKEN = "demo"
/** Who the visitor is in the log and on the page. */
export const DEMO_VISITOR = "demo-visitor"
export const DEMO_INVITE_PATH = "/demo/invite"
const GUEST_PREFIX = "guest-"

export interface DemoOptions {
  /** How long a guest key works after the invite is opened. */
  guestTtlMs: number
  /** How long a guest invite waits to be opened. */
  inviteTtlMs: number
  /** Guest keys and open guest invites at once; more are asked to come back later. */
  maxGuests: number
  /** Guest invites one address may ask for within an hour. */
  invitesPerHour: number
  /** Revoked guest keys are dropped from the key file after this long. */
  forgetGuestsAfterMs: number
}

export const DEFAULT_DEMO: DemoOptions = {
  guestTtlMs: 60 * 60_000,
  inviteTtlMs: 15 * 60_000,
  maxGuests: 25,
  invitesPerHour: 5,
  forgetGuestsAfterMs: 24 * 60 * 60_000
}

export const isGuestName = (name: string): boolean =>
  name.startsWith(GUEST_PREFIX)

export const guestName = (suffix: string): string => `${GUEST_PREFIX}${suffix}`

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

/**
 * The visitor's address. Behind a reverse proxy on the same machine the
 * socket is loopback and the proxy's `X-Forwarded-For` names the visitor;
 * from anywhere else the header is the caller's own claim and is ignored.
 */
export const clientAddress = (req: http.IncomingMessage): string => {
  const remote = req.socket.remoteAddress ?? "unknown"
  if (!LOOPBACK.has(remote)) return remote
  const header = req.headers["x-forwarded-for"]
  const forwarded = (Array.isArray(header) ? header[0] : header)
    ?.split(",")
    .pop()
    ?.trim()
  return forwarded || remote
}

const HOUR_MS = 60 * 60_000

/** Guest invites per address in the last hour. */
export class InviteThrottle {
  private readonly _asked = new Map<string, number[]>()

  constructor(private readonly _perHour: number) {}

  /** Whether the address may have another now; counts it when it may. */
  public admit(address: string, now = Date.now()): boolean {
    for (const [known, times] of this._asked) {
      const recent = times.filter((at) => now - at < HOUR_MS)
      if (recent.length) this._asked.set(known, recent)
      else this._asked.delete(known)
    }
    const times = this._asked.get(address) ?? []
    if (times.length >= this._perHour) return false
    this._asked.set(address, [...times, now])
    return true
  }
}

/** A route target whose generation requests never ask for more than `max` tokens. */
export const capOutputTokens = (
  target: RemoteRouteTarget,
  max: number
): RemoteRouteTarget => {
  const cap = <T extends { maxTokens?: number }>(request: T): T => ({
    ...request,
    maxTokens: Math.min(request.maxTokens ?? max, max)
  })
  const client: InferenceClient = Object.create(target.client)
  client.fim = (request, options) => target.client.fim(cap(request), options)
  client.chat = (request, options) => target.client.chat(cap(request), options)
  return { ...target, client }
}

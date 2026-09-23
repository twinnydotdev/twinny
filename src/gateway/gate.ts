/**
 * The one way in to the gateway's models. A developer's request and a
 * plugin's job both ask the gate for a ticket; the ticket routes aliases
 * with the team's routing rules and output cap applied, and carries the
 * request's deadline. Caps, the queue, per-key limits and shutdown are all
 * the gate's business, so nothing reaches a backend without them.
 */
import { isHostedProvider } from "../common/provider-validation"
import { InferenceError } from "../extension/inference/errors"

import type { GatewayConfig, GatewayLimits, PerKeyLimits } from "./config"
import { capOutputTokens } from "./demo"
import type { GatewayMetrics } from "./metrics"
import type { RouteTable } from "./routes"
import { refuseByRouting } from "./routing"

export type GateRoute = "fim" | "chat" | "embeddings"

export interface GateOptions {
  /** Caps and queue sizes, as the process started; an admin save keeps them. */
  limits: GatewayLimits
  /** The configuration in force: routing rules, providers, the output cap. */
  config: () => GatewayConfig
  /** Whether the licence carries the `policy` feature right now. */
  policyLicensed: () => boolean
  metrics?: GatewayMetrics
}

export interface AdmitRequest {
  principal: string
  route: GateRoute
  /** The routing table the request keeps, even across an admin save. */
  routes: RouteTable
  /** What the routing rules match: a workspace folder, a repository's name. */
  workspace?: string
  /** A plugin's job: counted apart, so plugins can tell whether developers are busy. */
  background?: boolean
  /** Aborted when the caller stops waiting, e.g. the client closed the connection. */
  signal?: AbortSignal
}

export interface Ticket {
  /** Routes an alias; throws an `InferenceError` when the routing rules refuse it. */
  route: RouteTable["route"]
  /** Aborted at the deadline or when the gateway stops. */
  signal: AbortSignal
  /** How long the request waited for a slot, in ms. */
  waited: number
  /** The request is over. Safe to call more than once. */
  finish(): void
}

export type Refusal = {
  kind: "refused"
  reason: "gateway" | "queue" | "key"
  message: string
  waited: number
  /** Generation requests running and waiting when it was refused. */
  generating: number
  waiting: number
}

export type Admission =
  | { kind: "admitted"; ticket: Ticket }
  | Refusal
  | { kind: "gone"; waited: number }

/** A refusal as the error a plugin's caller sees. */
export const refusalError = (refusal: Refusal) =>
  new InferenceError("rate-limited", refusal.message)

const MINUTE_MS = 60_000

/**
 * The per-key counters: requests running now, and the start times of the
 * last minute's requests, kept only while a limit needs them.
 */
class KeyMeter {
  private readonly _active = new Map<string, number>()
  private readonly _starts = new Map<string, number[]>()

  constructor(private readonly _limits: PerKeyLimits | undefined) {}

  /** Why a key may not start another request now, or nothing. */
  public refuse(principal: string, now = Date.now()): string | undefined {
    const limits = this._limits
    if (!limits) return undefined
    if (limits.maxActiveRequests !== undefined) {
      const active = this._active.get(principal) ?? 0
      if (active >= limits.maxActiveRequests) {
        return `Your key is at its limit of ${limits.maxActiveRequests} request(s) running at once.`
      }
    }
    if (limits.requestsPerMinute !== undefined) {
      const starts = this.recent(principal, now)
      if (starts.length >= limits.requestsPerMinute) {
        return `Your key has started ${starts.length} requests in the last minute (limit ${limits.requestsPerMinute}). Wait a moment.`
      }
    }
    return undefined
  }

  public start(principal: string, now = Date.now()) {
    if (!this._limits) return
    this._active.set(principal, (this._active.get(principal) ?? 0) + 1)
    if (this._limits.requestsPerMinute !== undefined) {
      this._starts.set(principal, [...this.recent(principal, now), now])
    }
  }

  public end(principal: string) {
    if (!this._limits) return
    const active = (this._active.get(principal) ?? 1) - 1
    if (active <= 0) this._active.delete(principal)
    else this._active.set(principal, active)
  }

  private recent(principal: string, now: number): number[] {
    const starts = (this._starts.get(principal) ?? []).filter(
      (at) => now - at < MINUTE_MS
    )
    if (starts.length) this._starts.set(principal, starts)
    else this._starts.delete(principal)
    return starts
  }
}

/** A generation request waiting for a free slot. */
interface Waiting {
  /** Called once: with a slot already reserved, or with `false` when the gate closes. */
  admit: (ok: boolean) => void
}

interface Live {
  controller: AbortController
  background: boolean
}

type SlotWait =
  | { kind: "admitted"; waited: number }
  | { kind: "refused"; reason: "gateway" | "queue"; message: string; waited: number }
  | { kind: "gone"; waited: number }

export class InferenceGate {
  private readonly _meter: KeyMeter
  private readonly _live = new Set<Live>()
  /** Generation requests (fim and chat) running now; what the caps count. */
  private _generating = 0
  /** Generation requests waiting for a slot, oldest first. */
  private readonly _waiting: Waiting[] = []
  private _closed = false

  constructor(private readonly _options: GateOptions) {
    this._meter = new KeyMeter(_options.limits.perKey)
  }

  /** Requests holding a ticket now, plugins' included. */
  public get active(): number {
    return this._live.size
  }

  /** Developers' requests holding a ticket now. Zero means the models are idle. */
  public get developerActive(): number {
    let count = 0
    for (const live of this._live) if (!live.background) count++
    return count
  }

  public async admit(request: AdmitRequest): Promise<Admission> {
    const { principal, route } = request
    // Embeddings are not counted against the caps: an index run is
    // hundreds of small, quick requests, and a cap sized for generation
    // would refuse most of them. They still hold a ticket for draining and
    // are bound by the deadline.
    const metered = route !== "embeddings"
    let waited = 0
    if (this._closed) return this.refusal("gateway", "The gateway is shutting down.", 0)
    if (metered) {
      // A key over its own limit is refused at once: waiting would not help it.
      const keyRefusal = this._meter.refuse(principal)
      if (keyRefusal) return this.refusal("key", keyRefusal, 0)
      if (this._generating < this._options.limits.maxActiveRequests) {
        this._generating++
      } else {
        const slot = await this.waitForSlot(route, request.signal)
        if (slot.kind === "gone") return slot
        if (slot.kind === "refused") return this.refusal(slot.reason, slot.message, slot.waited)
        waited = slot.waited
        // The key's other requests may have been admitted while this one waited.
        const again = this._meter.refuse(principal)
        if (again) {
          this.releaseSlot()
          return this.refusal("key", again, waited)
        }
      }
      this._meter.start(principal)
    }
    return { kind: "admitted", ticket: this.issue(request, metered, waited) }
  }

  /** Stop admitting: everything waiting is refused, and so is anything new. */
  public close() {
    this._closed = true
    for (const entry of [...this._waiting]) entry.admit(false)
  }

  /** Abort every request holding a ticket. */
  public abortAll(reason: unknown) {
    for (const { controller } of this._live) controller.abort(reason)
  }

  private issue(request: AdmitRequest, metered: boolean, waited: number): Ticket {
    const { principal, routes, workspace } = request
    const { limits } = this._options
    const config = this._options.config()
    const { maxOutputTokens } = config.limits
    const rules = this._options.policyLicensed() ? config.policy?.routing : undefined

    const controller = new AbortController()
    const live: Live = { controller, background: request.background === true }
    this._live.add(live)
    this._options.metrics?.active(this._live.size)
    const timer = setTimeout(() => {
      controller.abort(
        new InferenceError(
          "timeout",
          `The request exceeded the gateway's deadline of ${Math.round(limits.requestDeadlineMs / 1000)}s.`
        )
      )
    }, limits.requestDeadlineMs)

    let open = true
    return {
      signal: controller.signal,
      waited,
      route: (alias, capability) => {
        const target = routes.route(alias, capability)
        // Routing rules: some workspaces may only use some aliases, or only local backends.
        const providerName = routes.providerOf(alias)
        const providerKind = providerName ? config.providers[providerName]?.provider : undefined
        const refusal = refuseByRouting(rules, workspace, alias, !!providerKind && isHostedProvider(providerKind))
        if (refusal) throw new InferenceError("authentication", refusal)
        return maxOutputTokens === undefined ? target : capOutputTokens(target, maxOutputTokens)
      },
      finish: () => {
        if (!open) return
        open = false
        clearTimeout(timer)
        this._live.delete(live)
        this._options.metrics?.active(this._live.size)
        if (metered) {
          this._meter.end(principal)
          this.releaseSlot()
        }
      }
    }
  }

  private refusal(reason: Refusal["reason"], message: string, waited: number): Refusal {
    return {
      kind: "refused",
      reason,
      message,
      waited,
      generating: this._generating,
      waiting: this._waiting.length
    }
  }

  /**
   * Waits for a generation slot, up to the route's wait. Resolves with the
   * slot already reserved, with why it was refused, or with `gone` when the
   * caller stopped waiting meanwhile.
   */
  private waitForSlot(route: "fim" | "chat", signal: AbortSignal | undefined): Promise<SlotWait> {
    const { maxActiveRequests, queue } = this._options.limits
    const waitMs = route === "fim" ? queue.fimWaitMs : queue.chatWaitMs
    if (waitMs <= 0 || this._waiting.length >= queue.maxWaiting) {
      const waiting = this._waiting.length
      return Promise.resolve({
        kind: "refused",
        reason: "gateway",
        waited: 0,
        message:
          `The gateway is busy: ${maxActiveRequests} request(s) already running` +
          (waiting ? ` and ${waiting} waiting` : "") +
          ". Try again shortly."
      })
    }
    if (signal?.aborted) return Promise.resolve({ kind: "gone", waited: 0 })
    return new Promise((resolve) => {
      const since = Date.now()
      const leave = () => {
        const index = this._waiting.indexOf(entry)
        if (index >= 0) this._waiting.splice(index, 1)
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        this._options.metrics?.queued(this._waiting.length)
      }
      const onAbort = () => {
        leave()
        resolve({ kind: "gone", waited: Date.now() - since })
      }
      const timer = setTimeout(() => {
        leave()
        resolve({
          kind: "refused",
          reason: "queue",
          waited: Date.now() - since,
          message:
            `The gateway is busy: ${maxActiveRequests} request(s) already running; ` +
            `waited ${waitMs} ms for a free slot. Try again shortly.`
        })
      }, waitMs)
      const entry: Waiting = {
        admit: (ok) => {
          leave()
          resolve(
            ok
              ? { kind: "admitted", waited: Date.now() - since }
              : { kind: "refused", reason: "gateway", waited: Date.now() - since, message: "The gateway is shutting down." }
          )
        }
      }
      signal?.addEventListener("abort", onAbort)
      this._waiting.push(entry)
      this._options.metrics?.queued(this._waiting.length)
    })
  }

  /** Gives a slot back and hands it straight to the oldest request waiting, if any. */
  private releaseSlot(): void {
    this._generating--
    const { maxActiveRequests } = this._options.limits
    while (this._waiting.length && this._generating < maxActiveRequests) {
      const next = this._waiting.shift()
      if (!next) break
      this._generating++
      next.admit(true)
    }
  }
}

/**
 * The gateway process's HTTP listener. The protocol handler does the
 * work; this wraps it with what a standalone process needs: a health
 * route, the bearer token, a cap on active requests, a deadline per
 * request, request logging, and a bounded shutdown.
 *
 *   GET /healthz            -> { status: "ok" }   (no token; says only that the listener is up)
 *   *   /twinny/v1/...      -> the protocol, token required
 */
import { randomBytes, timingSafeEqual } from "node:crypto"
import http from "node:http"
import { AddressInfo } from "node:net"

import { messageOf } from "../common/errors"
import { InferenceError } from "../extension/inference/errors"
import { handleRemoteRequest } from "../protocol/handler"
import { PEER_CLOSE, peerRoutePath } from "../protocol/peer"
import {
  REMOTE_JOIN_PATH,
  REMOTE_PROTOCOL_BASE,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SIGNIN_PATH,
  REMOTE_SIGNIN_POLL_PATH
} from "../protocol/types"
import {
  acceptUpgrade,
  isUpgradeRequest,
  refuseUpgrade
} from "../protocol/websocket"
import {
  isInferenceCapability,
  matchRemoteRoute,
  toErrorBody
} from "../protocol/wire"

import { PluginError, PluginHost } from "./plugins/host"
import { exportLines } from "./recording/export"
import { Recorder } from "./recording/recorder"
import type { RecordingQuery, RecordingRoute } from "./recording/store"
import { adminPageHtml } from "./admin-page"
import type { AuditLog } from "./audit"
import {
  GatewayConfig,
  hasTeamPool,
  isTeamProvider,
  policyForExtensions,
  pricingOf,
  teamPooledAliases,
  teamWantedModels
} from "./config"
import { ConfigurationConflict, GatewayConfiguration } from "./configuration"
import {
  clientAddress,
  DEMO_INVITE_PATH,
  DEMO_VISITOR,
  DEMO_VISITOR_TOKEN,
  DemoOptions,
  guestName,
  InviteThrottle
} from "./demo"
import { InferenceGate, refusalError } from "./gate"
import { InviteError, InviteStore } from "./invites"
import { KeyStore } from "./keys"
import { LicenseStore } from "./license"
import { GatewayLog } from "./log"
import type { GatewayMetrics } from "./metrics"
import { PeerRegistry } from "./peers"
import {
  readJsonBody,
  sendError,
  sendJson,
  sendMessage,
  sendMethodNotAllowed,
  sendPlugin,
  sendRefusal
} from "./reply"
import { RouteTable } from "./routes"
import { SeatBook } from "./seats"
import { isUserCode, normalizeUserCode, SignInRequests } from "./signin"
import { parseSince, summarizeUsage, UsageRecorder } from "./usage"

export const HEALTH_PATH = "/healthz"
/** Prometheus metrics, for admin keys. */
export const METRICS_PATH = "/metrics"
/** The admin page; the app on it signs in with an admin key. */
export const ADMIN_PATH = "/admin"
const ADMIN_API_PREFIX = "/twinny/v1/admin/"

export interface GatewayServerOptions {
  config: GatewayConfig
  /** The shared token, while one is still accepted. */
  token?: string
  keys: KeyStore
  /** The plan: how many keys may hold a seat. Absent means the free plan. */
  license?: LicenseStore
  routes: RouteTable
  log: GatewayLog
  usage?: UsageRecorder
  configuration?: GatewayConfiguration
  /** Sign-in requests; a fresh, empty set unless given. */
  signIns?: SignInRequests
  /** Invite links; without a store the join route answers 404. */
  invites?: InviteStore
  /** Content recording, when the gateway was started with somewhere to keep it. */
  recorder?: Recorder
  /** Teammates' computers sharing their models, when the gateway pools them. */
  peers?: PeerRegistry
  /** Demo mode: a read-only visitor on the admin page and short-lived guest keys. */
  demo?: DemoOptions
  /** Bundled plugins; without a host the plugin routes answer 404. */
  plugins?: PluginHost
  /** Who changed what, hash-chained; without it nothing is audited. */
  audit?: AuditLog
  /** Prometheus counters; without them /metrics answers 404. */
  metrics?: GatewayMetrics
  /** The gateway's version, for /metrics. */
  version?: string
}

/** Who a request came from: a key's name, or `shared` for the shared token. */
export const SHARED_PRINCIPAL = "shared"

export interface GatewayAddress {
  host: string
  port: number
  url: string
}

/** A listen failure the operator can act on. */
export class GatewayListenError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined
  ) {
    super(message)
    this.name = "GatewayListenError"
  }
}

/** What `authenticate` decided: a principal, or why not. */
type AuthResult =
  | {
      principal: string
      shared: boolean
      admin: boolean
      /** The demo page's visitor: reads the admin API, changes nothing, runs nothing. */
      visitor?: boolean
      /** An admin key that may read the admin API but not change anything. */
      readOnly?: boolean
    }
  | { refused: string }

const MINUTE_MS = 60_000

/** Constant-time on the bytes; a length mismatch still compares something. */
const tokenMatches = (
  presented: string | undefined,
  expected: string
): boolean => {
  if (!presented) return false
  const a = Buffer.from(presented, "utf8")
  const b = Buffer.from(expected, "utf8")
  if (a.length !== b.length) {
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

const bearerOf = (header: string | undefined): string | undefined => {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header || "")
  return match ? match[1] : undefined
}

export class GatewayServer {
  private readonly _server: http.Server
  private readonly _gate: InferenceGate
  private readonly _signIns: SignInRequests
  private readonly _seats: SeatBook
  private readonly _guestInvites?: InviteThrottle
  private _guestSweep?: NodeJS.Timeout
  private _draining = false
  private _nextId = 1
  private _address?: GatewayAddress

  constructor(private readonly _options: GatewayServerOptions) {
    this._server = http.createServer((req, res) => void this.handle(req, res))
    this._server.on("upgrade", (req, socket, head) =>
      this.handleUpgrade(req, socket as import("node:net").Socket, head)
    )
    this._gate = new InferenceGate({
      limits: _options.config.limits,
      config: () => this.config,
      policyLicensed: () =>
        _options.license?.current().features.includes("policy") === true,
      metrics: _options.metrics
    })
    this._signIns = _options.signIns ?? new SignInRequests()
    this._seats = new SeatBook({
      keys: _options.keys,
      license: _options.license,
      demo: _options.demo,
      log: _options.log
    })
    if (_options.demo)
      this._guestInvites = new InviteThrottle(_options.demo.invitesPerHour)
    this._server.keepAliveTimeout = 65_000
    this._server.headersTimeout = 70_000
    // A stream can be quiet for a long time while a model loads; the
    // per-request deadline is the bound, not the socket's.
    this._server.requestTimeout = 0
  }

  public get address(): GatewayAddress | undefined {
    return this._address
  }

  /** Requests at the models now, plugins' included. */
  public get active(): number {
    return this._gate.active
  }

  /** The way in to the models, for plugins as for developers. */
  public get gate(): InferenceGate {
    return this._gate
  }

  /** Who holds a seat on the plan; the demo's guests do not. */
  public get seats(): SeatBook {
    return this._seats
  }

  public get routes(): RouteTable {
    return this._options.configuration?.routes ?? this._options.routes
  }

  /** The configuration in force: the last admin save, else what the process started with. */
  private get config(): GatewayConfig {
    return this._options.configuration?.current ?? this._options.config
  }

  public start(): Promise<GatewayAddress> {
    const { host, port } = this._options.config.listen
    return new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        const message =
          error.code === "EADDRINUSE"
            ? `Port ${port} on ${host} is already in use. Stop the other process or change listen.port.`
            : error.code === "EADDRNOTAVAIL"
              ? `${host} is not an address of this machine. Change listen.host.`
              : error.code === "EACCES"
                ? `Permission denied listening on ${host}:${port}.`
                : `Could not listen on ${host}:${port}: ${error.message}`
        reject(new GatewayListenError(message, error.code))
      }
      this._server.once("error", onError)
      this._server.listen(port, host, () => {
        this._server.removeListener("error", onError)
        const bound = this._server.address() as AddressInfo
        const shownHost =
          bound.family === "IPv6" ? `[${bound.address}]` : bound.address
        this._address = {
          host: bound.address,
          port: bound.port,
          url: `http://${shownHost}:${bound.port}`
        }
        if (this._options.demo) {
          this._seats.sweepGuests()
          this._guestSweep = setInterval(
            () => this._seats.sweepGuests(),
            MINUTE_MS
          )
          this._guestSweep.unref()
        }
        resolve(this._address)
      })
    })
  }

  /**
   * Stops admitting work, gives active requests the configured grace,
   * then aborts what is left and closes every connection. Resolves within
   * the grace period plus a moment, whatever a backend does.
   */
  public async stop(reason = "The gateway is shutting down."): Promise<void> {
    if (this._draining) return
    this._draining = true
    if (this._guestSweep) clearInterval(this._guestSweep)
    // Nothing waiting will get a slot now: each is answered before the drain.
    this._gate.close()
    const { shutdownGraceMs } = this._options.config.limits
    const closed = new Promise<void>((resolve) =>
      this._server.close(() => resolve())
    )

    const deadline = Date.now() + shutdownGraceMs
    while (this._gate.active > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    this._gate.abortAll(new InferenceError("cancelled", reason))
    // Peers are closed once their jobs are gone; the jobs were just aborted.
    await this._options.peers?.stop(Math.max(0, deadline - Date.now()))
    // An aborted handler ends its stream with a terminal frame; give it a
    // moment to write that before the sockets are pulled.
    const settle = Date.now() + 1_000
    while (this._gate.active > 0 && Date.now() < settle) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    const closable = this._server as unknown as {
      closeAllConnections?: () => void
    }
    closable.closeAllConnections?.()
    await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(resolve, 1_000))
    ])
  }

  /* ------------------------------------------------------------------------ */

  /**
   * A named key is looked up by id and compared by hash; anything else is
   * compared against the shared token, if one is still accepted. The key
   * file is reread first when it changed, so a revocation is immediate.
   */
  private authenticate(header: string | undefined): AuthResult {
    const presented = bearerOf(header)
    if (!presented) {
      return { refused: "No gateway key was sent. Enter one on the provider." }
    }
    const { keys, token, demo } = this._options
    if (demo && presented === DEMO_VISITOR_TOKEN) {
      return {
        principal: DEMO_VISITOR,
        shared: false,
        admin: true,
        visitor: true
      }
    }
    if (KeyStore.looksLikeKey(presented)) {
      keys.refresh()
      const record = keys.verify(presented)
      if (!record) return { refused: keys.explain(presented) }
      const unseated = this._seats.seat(record)
      if (unseated) return { refused: unseated }
      return {
        principal: record.name,
        shared: false,
        admin: record.admin === true,
        ...(record.admin && record.readOnly ? { readOnly: true } : {})
      }
    }
    if (token && tokenMatches(presented, token)) {
      return { principal: SHARED_PRINCIPAL, shared: true, admin: false }
    }
    return {
      refused: token
        ? "The shared token does not match the gateway's."
        : "This gateway no longer accepts a shared token; use a personal gateway key."
    }
  }

  /** Writes one audit line, when the gateway keeps an audit log. */
  private audit(
    req: http.IncomingMessage,
    actor: string,
    action: string,
    target?: string,
    details?: Record<string, string | number | boolean>
  ): void {
    try {
      this._options.audit?.record({ action, actor, target, details, from: clientAddress(req) })
    } catch (error) {
      this._options.log.error({
        event: "audit.failed",
        message: messageOf(error)
      })
    }
  }

  /** The audit log routes: a filtered listing with the chain's verdict, and a full export. */
  private handleAudit(route: string, url: URL, req: http.IncomingMessage, res: http.ServerResponse) {
    const audit = this._options.audit
    if (!audit) {
      sendMessage(res, 404, "This gateway keeps no audit log.")
      return
    }
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"], "The audit log is read with GET.")
      return
    }
    if (route === "audit/export") {
      const text = audit.export()
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Length": Buffer.byteLength(text),
        "Content-Disposition": "attachment; filename=\"twinny-audit.jsonl\"",
        "Cache-Control": "no-store"
      })
      res.end(text)
      return
    }
    const since = url.searchParams.get("since")
    const limit = Number(url.searchParams.get("limit") ?? 200)
    sendJson(res, 200, {
      entries: audit.query({
        ...(since ? { since: parseSince(since, new Date()) } : {}),
        ...(url.searchParams.get("actor") ? { actor: url.searchParams.get("actor") as string } : {}),
        ...(url.searchParams.get("action") ? { action: url.searchParams.get("action") as string } : {}),
        limit: Number.isFinite(limit) ? Math.min(Math.max(1, limit), 1000) : 200
      }),
      verification: audit.verify()
    })
  }

  /**
   * The admin API behind the page: usage for everyone, the key list and
   * nothing a developer's own key could not already learn about itself.
   * Admin keys only; the shared token is never an admin.
   */
  private async handleAdmin(
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    auth: { principal: string; admin: boolean }
  ) {
    if (!auth.admin) {
      sendRefusal(
        res,
        403,
        "authentication",
        "This gateway key is not an admin key."
      )
      this._options.log.warn({ event: "admin.refused", key: auth.principal })
      return
    }
    const route = url.pathname
      .slice(ADMIN_API_PREFIX.length)
      .replace(/\/+$/, "")
    if (route === "provider-models") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(
          res,
          ["POST"],
          "Use POST to list a provider's models."
        )
        return
      }
      if (!this._options.configuration || this._draining) {
        sendMessage(
          res,
          503,
          "Provider model discovery is currently unavailable."
        )
        return
      }
      try {
        const body = await readJsonBody(req)
        sendJson(
          res,
          200,
          await this._options.configuration.listModels(
            body,
            this._options.keys.active().length
          )
        )
      } catch (error) {
        sendMessage(
          res,
          400,
          messageOf(error)
        )
      }
      return
    }
    if (route === "config") {
      if (req.method !== "GET" && req.method !== "PUT") {
        sendMethodNotAllowed(
          res,
          ["GET", "PUT"],
          "Use GET or PUT for configuration."
        )
        return
      }
      if (this._draining) {
        sendMessage(res, 503, "The gateway is shutting down.")
        return
      }
      const configuration = this._options.configuration
      if (!configuration) {
        sendMessage(
          res,
          503,
          "Configuration editing requires a gateway started with --config."
        )
        return
      }
      try {
        if (req.method === "GET") {
          sendJson(res, 200, configuration.snapshot())
          return
        }
        const body = await readJsonBody(req, 256 * 1024)
        const current = this.authenticate(req.headers.authorization)
        if ("refused" in current || !current.admin) {
          sendMessage(
            res,
            403,
            "An active admin key is required to save changes."
          )
          return
        }
        const saved = configuration.save(
          body,
          this._options.keys.active().length
        )
        this._options.recorder?.update(configuration.current.recording)
        if (hasTeamPool(configuration.current))
          this._options.peers?.refreshWanted()
        else
          this._options.peers?.disconnectAll(
            PEER_CLOSE.notConfigured,
            "The team pool was removed from the configuration."
          )
        this._options.log.info({
          event: "admin.config-updated",
          key: auth.principal,
          models: saved.models.length
        })
        this.audit(req, auth.principal, "config.saved", undefined, { models: saved.models.length })
        sendJson(res, 200, saved)
      } catch (error) {
        sendJson(res, error instanceof ConfigurationConflict ? 409 : 400, {
          error: {
            message: messageOf(error)
          }
        })
      }
      return
    }
    if (route === "license") {
      await this.handleLicense(req, res, auth)
      return
    }
    if (route === "signin" || route.startsWith("signin/")) {
      await this.handleAdminSignIn(route, req, res, auth)
      return
    }
    if (route === "invites" || route.startsWith("invites/")) {
      await this.handleAdminInvites(route, req, res, auth)
      return
    }
    if (route === "recordings" || route.startsWith("recordings/")) {
      await this.handleRecordings(route, url, req, res)
      return
    }
    if (route === "peers" || route.startsWith("peers/")) {
      this.handlePeers(route, req, res, auth)
      return
    }
    if (route === "plugins" || route.startsWith("plugins/")) {
      await this.handlePlugins(route, url, req, res, auth)
      return
    }
    if (route === "audit" || route === "audit/export") {
      this.handleAudit(route, url, req, res)
      return
    }
    const revoke = /^keys\/([0-9a-f]{8})\/revoke$/.exec(route)
    const wantsPost = route === "keys" && req.method === "POST"
    if (!wantsPost && !revoke && req.method !== "GET") {
      res.setHeader("Allow", "GET")
      sendError(
        res,
        new InferenceError("inference-failure", "This admin route is GET only.")
      )
      return
    }
    if (revoke && req.method !== "POST") {
      res.setHeader("Allow", "POST")
      sendError(
        res,
        new InferenceError("inference-failure", "Revoking is POST only.")
      )
      return
    }
    try {
      if (wantsPost) {
        // Make a key from the page. The secret goes back once, in this
        // reply, and nowhere else; the log gets the name only.
        const body = await readJsonBody(req)
        const name = typeof body.name === "string" ? body.name.trim() : ""
        const admin = body.admin === true
        const readOnly = admin && body.readOnly === true
        this._options.keys.reload()
        const refusal = this._seats.refuse(name)
        if (refusal) {
          sendRefusal(res, 409, "inference-failure", refusal)
          this._options.log.warn({
            event: "admin.key-refused",
            key: auth.principal,
            reason: "no-seat"
          })
          return
        }
        const { key, record } = this._options.keys.create(name, { admin, readOnly })
        this._options.log.info({
          event: "admin.key-created",
          key: auth.principal,
          reason: record.name
        })
        this.audit(req, auth.principal, "key.created", record.name, { admin, ...(readOnly ? { readOnly } : {}) })
        sendJson(res, 201, {
          key,
          record: {
            id: record.id,
            name: record.name,
            createdAt: record.createdAt,
            ...(record.admin ? { admin: true } : {}),
            ...(record.readOnly ? { readOnly: true } : {})
          }
        })
        return
      }
      if (revoke) {
        const id = revoke[1]
        this._options.keys.reload()
        const target = this._options.keys
          .list()
          .find((k) => k.id === id && !k.revokedAt)
        if (!target) {
          sendRefusal(
            res,
            404,
            "inference-failure",
            "No active key with that id."
          )
          return
        }
        if (target.name === auth.principal) {
          sendRefusal(
            res,
            400,
            "inference-failure",
            "That is the key you are signed in with. Revoke it from the CLI if you mean it."
          )
          return
        }
        const record = this._options.keys.revoke(id)
        this._options.log.info({
          event: "admin.key-revoked",
          key: auth.principal,
          reason: record?.name
        })
        this.audit(req, auth.principal, "key.revoked", record?.name ?? id)
        sendJson(res, 200, {
          id,
          name: record?.name,
          revokedAt: record?.revokedAt
        })
        return
      }
      switch (route) {
        case "usage": {
          const now = new Date()
          const since = parseSince(url.searchParams.get("since") || "7d", now)
          const usage = this._options.usage
          if (!usage) {
            sendJson(res, 200, {
              since,
              until: now,
              total: null,
              byKey: {},
              byModel: {},
              byKeyAndModel: {},
              byPeer: {},
              byDay: []
            })
            return
          }
          sendJson(res, 200, summarizeUsage(usage.dir, since, now, pricingOf(this.config)))
          return
        }
        case "keys": {
          this._options.keys.reload()
          const keys = this._options.keys
            .list()
            .map(({ id, name, createdAt, revokedAt, admin, readOnly }) => ({
              id,
              name,
              createdAt,
              ...(revokedAt ? { revokedAt } : {}),
              ...(admin ? { admin: true } : {}),
              ...(readOnly ? { readOnly: true } : {})
            }))
          sendJson(res, 200, {
            keys,
            sharedToken: !!this._options.token,
            ...(this._options.license ? { plan: this._seats.summary() } : {})
          })
          return
        }
        default:
          sendError(res, new InferenceError("inference-failure", "Not found."))
      }
    } catch (error) {
      sendRefusal(
        res,
        400,
        "inference-failure",
        messageOf(error)
      )
    }
  }

  /** The connected peers, and disconnecting one. Admin keys only (checked by the caller). */
  private handlePeers(
    route: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    auth: { principal: string }
  ) {
    const peers = this._options.peers
    if (!peers) {
      sendMessage(res, 503, "This gateway was started without peer support.")
      return
    }
    if (route === "peers") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, ["GET"], "Use GET to list peers.")
        return
      }
      sendJson(res, 200, {
        peers: peers.snapshot(),
        configured: hasTeamPool(this.config),
        wanted: teamWantedModels(this.config)
      })
      return
    }
    const match = /^peers\/(p[0-9]+)\/disconnect$/.exec(route)
    if (!match) {
      sendMessage(res, 404, "Not found.")
      return
    }
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"], "Disconnecting is POST only.")
      return
    }
    const target = peers.snapshot().find((peer) => peer.id === match[1])
    if (!target || !peers.disconnect(match[1])) {
      sendMessage(res, 404, "No connected peer with that id.")
      return
    }
    this._options.log.info({
      event: "admin.peer-disconnected",
      key: auth.principal,
      peer: target.label
    })
    sendJson(res, 200, { id: target.id, label: target.label })
  }

  /**
   * A sharing extension dialling in: the peer route, upgraded to a
   * WebSocket once the key checks out. The shared token cannot share,
   * since usage must say who served.
   */
  private handleUpgrade(
    req: http.IncomingMessage,
    socket: import("node:net").Socket,
    head: Buffer
  ) {
    const refuse = (
      status: number,
      error: InferenceError,
      headers?: Record<string, string>
    ) => {
      refuseUpgrade(socket, status, toErrorBody(error), headers)
      this._options.log.warn({
        event: "peer.refused",
        status,
        kind: error.kind
      })
    }
    let url: URL
    try {
      url = new URL(req.url || "/", "http://gateway")
    } catch {
      refuse(400, new InferenceError("inference-failure", "Invalid request URL."))
      return
    }
    if (url.pathname !== peerRoutePath()) {
      refuse(404, new InferenceError("inference-failure", "Not found."))
      return
    }
    if (!isUpgradeRequest(req)) {
      refuse(
        400,
        new InferenceError(
          "inference-failure",
          "The peer route is a WebSocket; send an Upgrade request."
        )
      )
      return
    }
    const peers = this._options.peers
    if (!peers) {
      refuse(
        503,
        new InferenceError(
          "provider-unavailable",
          "This gateway was started without peer support."
        )
      )
      return
    }
    const auth = this.authenticate(req.headers.authorization)
    if ("refused" in auth) {
      refuse(401, new InferenceError("authentication", auth.refused), {
        "WWW-Authenticate": "Bearer"
      })
      return
    }
    if (auth.shared) {
      refuse(
        403,
        new InferenceError(
          "authentication",
          "The shared token cannot share a computer; use a personal gateway key."
        )
      )
      return
    }
    if (this._draining) {
      refuse(
        503,
        new InferenceError(
          "provider-unavailable",
          "The gateway is shutting down."
        )
      )
      return
    }
    if (!hasTeamPool(this.config)) {
      refuse(
        404,
        new InferenceError(
          "model-unavailable",
          "This gateway has no team pool configured. Ask your admin to add a \"Team members' computers\" provider."
        )
      )
      return
    }
    const connection = acceptUpgrade(req, socket, head)
    peers.attach(connection, auth.principal)
  }

  /**
   * Recorded content for admins: a page of summaries, one record in full,
   * or an export as JSON lines. Reading is the admin's business; the
   * settings are saved with the configuration.
   */
  private async handleRecordings(
    route: string,
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const recorder = this._options.recorder
    if (!recorder) {
      sendMessage(
        res,
        503,
        "This gateway was started without recording support."
      )
      return
    }
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"], "Recordings are read-only here.")
      return
    }
    const query: RecordingQuery = {}
    const routeParam = url.searchParams.get("route")
    if (routeParam) {
      if (!isInferenceCapability(routeParam)) {
        sendMessage(res, 400, "route must be chat, fim or embeddings.")
        return
      }
      query.route = routeParam as RecordingRoute
    }
    const key = url.searchParams.get("key")
    if (key) query.key = key
    const outcome = url.searchParams.get("outcome")
    if (outcome) {
      if (outcome !== "ok" && outcome !== "error" && outcome !== "cancelled") {
        sendMessage(res, 400, "outcome must be ok, error or cancelled.")
        return
      }
      query.outcome = outcome
    }
    const since = url.searchParams.get("since")
    if (since) query.since = parseSince(since, new Date())
    const before = url.searchParams.get("before")
    if (before) query.before = before
    const search = url.searchParams.get("q")
    if (search) query.search = search.slice(0, 200)
    const limit = Number(url.searchParams.get("limit") ?? "")
    if (Number.isInteger(limit) && limit > 0) query.limit = limit

    if (route === "recordings") {
      sendJson(res, 200, {
        ...recorder.store.list(query),
        summary: recorder.summary(),
        keys: recorder.store.keys()
      })
      return
    }
    if (route === "recordings/export") {
      const format =
        url.searchParams.get("format") === "raw" ? "raw" : "training"
      const name = `twinny-recordings-${query.route ?? "all"}-${new Date().toISOString().slice(0, 10)}.jsonl`
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store"
      })
      let lines = 0
      for (const line of exportLines(recorder.store.each(query), format)) {
        if (!res.write(`${line}\n`))
          await new Promise((resolve) => res.once("drain", resolve))
        lines++
      }
      res.end()
      this._options.log.info({
        event: "recording.exported",
        route: query.route ?? "all",
        chunks: lines
      })
      return
    }
    const one = /^recordings\/([0-9]{14}-[0-9a-f]{8})$/.exec(route)
    if (one) {
      const record = recorder.store.get(one[1])
      if (!record)
        sendMessage(res, 404, "No such recording.")
      else sendJson(res, 200, record)
      return
    }
    sendMessage(res, 404, "Not found.")
  }

  /**
   * A visitor asking to try the demo from VS Code: a guest invite, made
   * without a credential. Bounded per address and in total, since anyone
   * can ask.
   */
  private handleDemoInvite(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const demo = this._options.demo
    const invites = this._options.invites
    if (!demo || !invites) {
      sendMessage(res, 404, "Not found.")
      return
    }
    if (req.method !== "POST") {
      sendMethodNotAllowed(
        res,
        ["POST"],
        "Asking for a guest invite is POST only."
      )
      return
    }
    if (this._draining) {
      sendMessage(res, 503, "The gateway is shutting down.")
      return
    }
    req.resume()
    if (!this._guestInvites?.admit(clientAddress(req))) {
      sendMessage(
        res,
        429,
        `That is ${demo.invitesPerHour} guest invites from your address in an hour. Try again later.`,
        { "Retry-After": "600" }
      )
      this._options.log.warn({ event: "demo.invite-refused", reason: "address" })
      return
    }
    try {
      this._options.keys.reload()
      if (this._seats.guests(invites) >= demo.maxGuests) {
        sendMessage(
          res,
          429,
          "The demo has as many guests as it takes right now. Try again in a few minutes.",
          { "Retry-After": "300" }
        )
        this._options.log.warn({ event: "demo.invite-refused", reason: "full" })
        return
      }
      const made = invites.create(
        {
          name: guestName(randomBytes(3).toString("hex")),
          createdBy: DEMO_VISITOR,
          ttlMs: demo.inviteTtlMs
        },
        (candidate) =>
          this._options.keys.active().some((key) => key.name === candidate)
      )
      this._options.log.info({
        event: "demo.invite-created",
        reason: made.record.name
      })
      sendJson(res, 201, {
        code: made.code,
        name: made.record.name,
        expiresAt: made.record.expiresAt,
        guestMinutes: Math.round(demo.guestTtlMs / MINUTE_MS)
      })
    } catch (error) {
      sendJson(res, error instanceof InviteError ? error.status : 400, {
        error: {
          message: messageOf(error)
        }
      })
    }
  }

  /**
   * The admin's side of sign-in: the waiting codes, and approving one
   * (which mints the key under the name the admin chooses) or denying it.
   */
  private async handleAdminSignIn(
    route: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    auth: { principal: string }
  ) {
    if (route === "signin") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, ["GET"], "Use GET to list sign-in requests.")
        return
      }
      sendJson(res, 200, { requests: this._signIns.pending() })
      return
    }
    const match = /^signin\/([A-Za-z0-9-]{9})\/(approve|deny)$/.exec(route)
    if (!match || req.method !== "POST") {
      sendMessage(res, 404, "Not found.")
      return
    }
    const [, rawCode, action] = match
    if (!isUserCode(rawCode)) {
      sendMessage(res, 400, "That is not a sign-in code.")
      return
    }
    const userCode = normalizeUserCode(rawCode)
    try {
      if (action === "deny") {
        this._signIns.deny(userCode)
        this._options.log.info({
          event: "signin.denied",
          key: auth.principal,
          code: userCode
        })
        sendJson(res, 200, { userCode, status: "denied" })
        return
      }
      const body = await readJsonBody(req)
      const name = typeof body.name === "string" ? body.name.trim() : ""
      const admin = body.admin === true
      if (!name)
        throw new Error(
          "Give the key a name: the developer's name or username."
        )
      // A developer whose key is gone (a reinstall, a machine without a
      // keyring) signs in again under the same name. "replace" revokes the
      // old key in the same step, so the lost one never holds a seat.
      const replace = body.replace === true
      this._options.keys.reload()
      const existing = this._options.keys
        .active()
        .find((key) => key.name === name)
      if (existing && !replace) {
        throw new Error(
          `An active key named "${name}" already exists. Approve with "replace" to revoke it and make a new one, or pick another name.`
        )
      }
      if (existing && existing.name === auth.principal) {
        throw new Error(
          "That is the key you are signed in with. Pick another name or make the key by hand."
        )
      }
      const refusal = this._seats.refuse(name, { replace })
      if (refusal) {
        sendMessage(res, 409, refusal)
        this._options.log.warn({
          event: "signin.refused",
          key: auth.principal,
          code: userCode,
          reason: "no-seat"
        })
        return
      }
      const made = this._signIns.approve(userCode, () => {
        if (existing) this._options.keys.revoke(existing.id)
        const { key, record } = this._options.keys.create(name, { admin })
        return { key, name: record.name }
      })
      this.audit(req, auth.principal, "signin.approved", name, { ...(admin ? { admin: true } : {}), ...(existing ? { replaced: true } : {}) })
      this._options.log.info({
        event: "signin.approved",
        key: auth.principal,
        code: userCode,
        reason: made,
        ...(existing ? { replaced: existing.id } : {})
      })
      sendJson(res, 201, {
        userCode,
        status: "approved",
        name: made,
        ...(admin ? { admin: true } : {}),
        ...(existing ? { replaced: existing.id } : {})
      })
    } catch (error) {
      sendMessage(
        res,
        400,
        messageOf(error)
      )
    }
  }

  /**
   * The admin's side of invites: the open ones, making one (the code goes
   * back once, in this reply), and withdrawing one.
   */
  private async handleAdminInvites(
    route: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    auth: { principal: string; admin: boolean }
  ) {
    const invites = this._options.invites
    if (!invites) {
      sendMessage(res, 404, "This gateway does not keep invites.")
      return
    }
    try {
      if (route === "invites") {
        if (req.method === "GET") {
          // A demo's guest invites are the visitors' own business, not the team's.
          sendJson(res, 200, {
            invites: invites
              .pending()
              .filter((invite) => !this._seats.isGuest(invite.name))
          })
          return
        }
        if (req.method !== "POST") {
          sendMethodNotAllowed(
            res,
            ["GET", "POST"],
            "Use GET to list invites or POST to make one."
          )
          return
        }
        const body = await readJsonBody(req)
        const name = typeof body.name === "string" ? body.name.trim() : ""
        if (!name)
          throw new InviteError(
            "Give the invite a key name: the developer's name or username.",
            400
          )
        const admin = body.admin === true
        const replace = body.replace === true
        // Seats are checked now so an invite that cannot be opened is never
        // sent, and again when it is opened, since keys may have been made since.
        this._options.keys.reload()
        const refusal = this._seats.refuse(name, { replace })
        if (refusal) {
          sendMessage(res, 409, refusal)
          this._options.log.warn({
            event: "invite.refused",
            key: auth.principal,
            reason: "no-seat"
          })
          return
        }
        const made = invites.create(
          { name, admin, replace, createdBy: auth.principal },
          (candidate) =>
            this._options.keys.active().some((key) => key.name === candidate)
        )
        this._options.log.info({
          event: "invite.created",
          key: auth.principal,
          reason: made.record.name,
          ...(admin ? { admin: true } : {})
        })
        this.audit(req, auth.principal, "invite.created", made.record.name, { ...(admin ? { admin: true } : {}), ...(replace ? { replace: true } : {}) })
        sendJson(res, 201, { code: made.code, invite: made.record })
        return
      }
      const match = /^invites\/([0-9a-f]{8})$/.exec(route)
      if (!match) {
        sendMessage(res, 404, "Not found.")
        return
      }
      if (req.method !== "DELETE") {
        sendMethodNotAllowed(
          res,
          ["DELETE"],
          "Withdrawing an invite is DELETE."
        )
        return
      }
      if (!invites.revoke(match[1])) {
        sendMessage(res, 404, "No open invite with that id.")
        return
      }
      this._options.log.info({
        event: "invite.withdrawn",
        key: auth.principal,
        reason: match[1]
      })
      this.audit(req, auth.principal, "invite.withdrawn", match[1])
      sendJson(res, 200, { id: match[1], status: "withdrawn" })
    } catch (error) {
      const status = error instanceof InviteError ? error.status : 400
      sendJson(res, status, {
        error: {
          message: messageOf(error)
        }
      })
    }
  }

  /**
   * The plugin store and the plugins' own routes. Enabling and disabling
   * is logged with the admin's key; what a plugin does with a request is
   * the plugin's business.
   */
  private async handlePlugins(
    route: string,
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    auth: { principal: string; admin: boolean }
  ) {
    const plugins = this._options.plugins
    if (!plugins) {
      sendMessage(res, 404, "This gateway has no plugins.")
      return
    }
    try {
      if (route === "plugins") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res, ["GET"], "Use GET to list plugins.")
          return
        }
        sendJson(res, 200, {
          plugins: plugins.list(),
          licensed: plugins.licensed
        })
        return
      }
      const match = /^plugins\/([a-z][a-z0-9-]{1,31})(?:\/(enable|disable|api)(?:\/(.*))?)?$/.exec(
        route
      )
      if (!match || !plugins.has(match[1])) {
        sendMessage(res, 404, "No such plugin.")
        return
      }
      const [, id, action, rest] = match
      if (action === "enable" || action === "disable") {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res, ["POST"], "Switching a plugin is POST.")
          return
        }
        const summary =
          action === "enable" ? plugins.enable(id) : await plugins.disable(id)
        this._options.log.info({
          event: `plugin.${action}d`,
          key: auth.principal,
          reason: id
        })
        this.audit(req, auth.principal, `plugin.${action}d`, id)
        sendJson(res, 200, { plugin: summary })
        return
      }
      if (action !== "api") {
        sendMessage(res, 404, "Not found.")
        return
      }
      const answer = await plugins.handle(id, {
        method: req.method ?? "GET",
        path: (rest ?? "").replace(/\/+$/, ""),
        query: url.searchParams,
        body: () => readJsonBody(req, 256 * 1024),
        principal: auth.principal
      })
      req.resume()
      if (req.method !== "GET" && answer.status < 400)
        this.audit(req, auth.principal, "plugin.write", id, { method: req.method ?? "", path: (rest ?? "").replace(/\/+$/, "") })
      sendPlugin(res, answer)
    } catch (error) {
      const status = error instanceof PluginError ? error.status : 400
      sendJson(res, status, {
        error: {
          message: messageOf(error)
        }
      })
    }
  }

  /** A plugin's browser-facing routes: no credential; the plugin decides what to show. */
  private async handlePublicPlugin(id: string, rest: string, url: URL, req: http.IncomingMessage, res: http.ServerResponse) {
    const plugins = this._options.plugins
    if (!plugins || !plugins.has(id)) {
      sendMessage(res, 404, "Not found.")
      return
    }
    try {
      const answer = await plugins.handlePublic(id, {
        method: req.method ?? "GET",
        path: rest,
        query: url.searchParams,
        headers: {
          host: typeof req.headers.host === "string" ? req.headers.host : undefined,
          "x-forwarded-proto": typeof req.headers["x-forwarded-proto"] === "string" ? req.headers["x-forwarded-proto"].split(",")[0].trim() : undefined,
          "x-forwarded-host": typeof req.headers["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"] : undefined
        },
        address: clientAddress(req),
        body: () => readJsonBody(req, 64 * 1024),
        ...(() => {
          // A developer's key, when one is sent, names the caller; a bad one is simply absent.
          if (!req.headers.authorization) return {}
          const auth = this.authenticate(req.headers.authorization)
          return "refused" in auth || auth.visitor ? {} : { principal: auth.principal }
        })()
      })
      req.resume()
      sendPlugin(res, answer)
    } catch (error) {
      const status = error instanceof PluginError ? error.status : 400
      sendMessage(res, status, messageOf(error))
    }
  }

  /**
   * An invite made on a plugin's behalf, on the gateway's terms: the seat
   * check, the name rules and the replace semantics are the same as on the
   * People page. Used by sign-in plugins to mint a key for a verified person.
   */
  public async inviteFor(input: { name: string; admin?: boolean; replace?: boolean; ttlMs?: number; createdBy: string }): Promise<{ code: string; expiresAt: string }> {
    const invites = this._options.invites
    if (!invites) throw new PluginError("This gateway does not keep invites.", 503)
    this._options.keys.reload()
    const refusal = this._seats.refuse(input.name, { replace: input.replace })
    if (refusal) throw new PluginError(refusal, 409)
    try {
      const made = invites.create(
        { name: input.name, admin: input.admin, replace: input.replace, createdBy: input.createdBy, ttlMs: input.ttlMs },
        (candidate) => this._options.keys.active().some((key) => key.name === candidate)
      )
      this._options.audit?.record({ action: "invite.created", actor: input.createdBy, target: input.name, details: { ...(input.admin ? { admin: true } : {}), ...(input.replace ? { replace: true } : {}) } })
      return { code: made.code, expiresAt: made.record.expiresAt }
    } catch (error) {
      if (error instanceof InviteError) throw new PluginError(error.message, error.status)
      throw error
    }
  }

  /**
   * The developer's side of an invite, taking no credential: the code from
   * the link becomes a key under the name the admin chose, once.
   */
  private async handleJoin(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"], "Join is POST only.")
      return
    }
    if (this._draining) {
      sendMessage(res, 503, "The gateway is shutting down.")
      return
    }
    const invites = this._options.invites
    if (!invites) {
      sendMessage(res, 404, "This gateway does not accept invites.")
      return
    }
    try {
      const body = await readJsonBody(req, 4 * 1024)
      const result = invites.redeem(body.code, body.machine, (invite) => {
        this._options.keys.reload()
        const existing = this._options.keys
          .active()
          .find((key) => key.name === invite.name)
        if (existing && !invite.replace) {
          throw new InviteError(
            `A key named "${invite.name}" was made since this invite was sent. Ask your admin for a new invite.`,
            409
          )
        }
        const refusal = this._seats.refuse(invite.name, {
          replace: invite.replace === true
        })
        if (refusal) throw new InviteError(`${refusal} Ask your admin.`, 409)
        if (existing) this._options.keys.revoke(existing.id)
        const { key, record } = this._options.keys.create(invite.name, {
          admin: invite.admin === true
        })
        return { key, keyId: record.id }
      })
      this._options.log.info({
        event: "invite.opened",
        key: result.name,
        ...(result.admin ? { admin: true } : {})
      })
      this.audit(req, result.name, "invite.opened", result.name, { ...(result.admin ? { admin: true } : {}) })
      sendJson(res, 201, result)
    } catch (error) {
      const status = error instanceof InviteError ? error.status : 400
      if (status === 409)
        this._options.log.warn({ event: "invite.refused", reason: "no-seat" })
      sendJson(res, status, {
        error: {
          message: messageOf(error)
        }
      })
    }
  }

  /**
   * The developer's side of sign-in, taking no credential: start a request
   * and get a code to read to the admin; poll until the admin has acted.
   */
  private async handleSignIn(
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"], "Sign-in routes are POST only.")
      return
    }
    if (this._draining) {
      sendMessage(res, 503, "The gateway is shutting down.")
      return
    }
    try {
      const body = await readJsonBody(req, 4 * 1024)
      if (pathname === `${REMOTE_PROTOCOL_BASE}${REMOTE_SIGNIN_POLL_PATH}`) {
        const result = this._signIns.poll(body.deviceCode)
        if (result.status === "approved") {
          this._options.log.info({
            event: "signin.collected",
            key: result.name
          })
        }
        sendJson(res, 200, result)
        return
      }
      const address = req.socket.remoteAddress ?? "unknown"
      const started = this._signIns.start({
        name: body.name,
        machine: body.machine,
        address
      })
      this._options.log.info({
        event: "signin.requested",
        code: started.userCode
      })
      sendJson(res, 201, started)
    } catch (error) {
      sendMessage(
        res,
        400,
        messageOf(error)
      )
    }
  }

  /**
   * The licence: read the plan, install a token, or remove it. Installing
   * verifies the signature first; a bad token changes nothing. The token
   * is logged by id and org only.
   */
  private async handleLicense(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    auth: { principal: string }
  ) {
    const license = this._options.license
    if (!license) {
      sendMessage(res, 503, "This gateway was started without licence support.")
      return
    }
    const plan = () => license.summary(this._seats.holders())
    try {
      switch (req.method) {
        case "GET":
          license.refresh()
          sendJson(res, 200, plan())
          return
        case "PUT": {
          const body = await readJsonBody(req)
          const token = typeof body.token === "string" ? body.token.trim() : ""
          if (!token) throw new Error("Paste the licence token in \"token\".")
          const installed = license.install(token)
          await this._options.plugins?.refresh()
          this._options.log.info({
            event: "admin.license-installed",
            key: auth.principal,
            reason: installed.licenseId ?? "",
            status: installed.status
          })
          this.audit(req, auth.principal, "license.installed")
          sendJson(res, 200, plan())
          return
        }
        case "DELETE":
          license.remove()
          await this._options.plugins?.refresh()
          this._options.log.info({
            event: "admin.license-removed",
            key: auth.principal
          })
          this.audit(req, auth.principal, "license.removed")
          sendJson(res, 200, plan())
          return
        default:
          sendMethodNotAllowed(
            res,
            ["GET", "PUT", "DELETE"],
            "Use GET, PUT or DELETE for the licence."
          )
      }
    } catch (error) {
      sendMessage(
        res,
        400,
        messageOf(error)
      )
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let url: URL
    try {
      url = new URL(req.url || "/", "http://gateway")
    } catch {
      sendMessage(res, 400, "Invalid request URL.")
      return
    }

    if (url.pathname === HEALTH_PATH) {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET")
        sendJson(res, 405, { status: "method-not-allowed" })
        return
      }
      sendJson(res, this._draining ? 503 : 200, {
        status: this._draining ? "stopping" : "ok"
      })
      return
    }

    if (url.pathname === ADMIN_PATH || url.pathname === `${ADMIN_PATH}/`) {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET")
        sendJson(res, 405, { status: "method-not-allowed" })
        return
      }
      const html = adminPageHtml({ demo: !!this._options.demo })
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(html),
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:"
      })
      res.end(html)
      return
    }

    if (url.pathname === METRICS_PATH) {
      const metrics = this._options.metrics
      if (!metrics) {
        sendMessage(res, 404, "Metrics are off on this gateway.")
        return
      }
      const auth = this.authenticate(req.headers.authorization)
      if ("refused" in auth || !auth.admin) {
        sendError(res, new InferenceError("authentication", "refused" in auth ? auth.refused : "Metrics need an admin key."), {
          "WWW-Authenticate": "Bearer"
        })
        return
      }
      this._options.keys.refresh()
      const active = this._seats.holders().length
      const seats = this._seats.summary()?.seats ?? active
      metrics.plan(active, seats)
      const text = metrics.render(this._options.version ?? "dev")
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Content-Length": Buffer.byteLength(text),
        "Cache-Control": "no-store"
      })
      res.end(text)
      return
    }

    if (
      url.pathname === `${REMOTE_PROTOCOL_BASE}${REMOTE_SIGNIN_PATH}` ||
      url.pathname === `${REMOTE_PROTOCOL_BASE}${REMOTE_SIGNIN_POLL_PATH}`
    ) {
      await this.handleSignIn(url.pathname, req, res)
      return
    }
    if (url.pathname === `${REMOTE_PROTOCOL_BASE}${REMOTE_JOIN_PATH}`) {
      await this.handleJoin(req, res)
      return
    }
    if (url.pathname === `${REMOTE_PROTOCOL_BASE}${DEMO_INVITE_PATH}`) {
      this.handleDemoInvite(req, res)
      return
    }
    const publicPlugin = /^\/twinny\/v1\/plugins\/([a-z][a-z0-9-]{1,31})(?:\/(.*))?$/.exec(url.pathname)
    if (publicPlugin) {
      await this.handlePublicPlugin(publicPlugin[1], (publicPlugin[2] ?? "").replace(/\/+$/, ""), url, req, res)
      return
    }

    const adminApi = url.pathname.startsWith(ADMIN_API_PREFIX)
    const match = adminApi ? undefined : matchRemoteRoute(url.pathname)
    if (!match && !adminApi) {
      sendError(res, new InferenceError("inference-failure", "Not found."))
      return
    }

    // The token gate comes before anything that could touch a provider.
    const auth = this.authenticate(req.headers.authorization)
    if ("refused" in auth) {
      sendError(res, new InferenceError("authentication", auth.refused), {
        "WWW-Authenticate": "Bearer"
      })
      this._options.log.warn({
        event: "auth.rejected",
        route: match?.route ?? "admin"
      })
      this._options.metrics?.authRejected()
      return
    }
    const { principal } = auth

    // A read-only admin sees everything on the page and changes nothing.
    if (auth.readOnly && adminApi && req.method !== "GET") {
      req.resume()
      sendRefusal(
        res,
        403,
        "authentication",
        "This admin key is read-only: it can look at everything and change nothing."
      )
      return
    }

    // The demo's visitor looks and touches nothing: reads of the admin API
    // (never recorded content) and the routes that describe the gateway.
    if (auth.visitor) {
      const refusal = adminApi
        ? req.method !== "GET"
          ? "This is the public demo, so changes are switched off. Run your own with: npx twinny-server quickstart"
          : url.pathname.startsWith(`${ADMIN_API_PREFIX}recordings`)
            ? "Recorded content is not shown in the public demo."
            : undefined
        : match && isInferenceCapability(match.route)
          ? "The demo page's visitor cannot run models. Use \"Try it in VS Code\" for a guest key."
          : undefined
      if (refusal) {
        req.resume()
        sendRefusal(res, 403, "authentication", refusal)
        return
      }
    }

    if (adminApi || !match) {
      await this.handleAdmin(url, req, res, auth)
      return
    }

    if (this._draining) {
      sendError(
        res,
        new InferenceError(
          "provider-unavailable",
          "The gateway is shutting down."
        )
      )
      return
    }

    const id = `${this._nextId++}`
    const started = Date.now()
    const { limits } = this._options.config
    // Each request keeps the routing table it started with, even across an admin save.
    const routes = this.routes
    const policyLicensed = this._options.license?.current().features.includes("policy") === true
    const workspaceHeader = req.headers["x-twinny-workspace"]
    const workspace = typeof workspaceHeader === "string" ? workspaceHeader.slice(0, 200) : undefined

    if (!isInferenceCapability(match.route)) {
      const outcome = await handleRemoteRequest(match.route, req, res, {
        models: routes.models,
        route: routes.route,
        identity: {
          key: principal,
          shared: auth.shared,
          ...(auth.admin ? { admin: true } : {})
        },
        status: async () => {
          const status = await routes.checkBackends()
          for (const backend of status.backends) this._options.metrics?.backend(backend.provider, backend.ok, backend.ms / 1000)
          const peers = this._options.peers
          if (!peers) return status
          const config = this.config
          return {
            ...status,
            backends: status.backends.map((backend) =>
              isTeamProvider(config, backend.provider)
                ? { ...backend, ms: 0, peers: peers.online() }
                : backend
            )
          }
        },
        team: () => {
          const configured = policyForExtensions(routes.policy())
          const recording = this._options.recorder?.active() ?? []
          const config = this.config
          const pooled = teamPooledAliases(config)
          const policy = {
            ...(configured && policyLicensed ? configured : {}),
            ...(recording.length ? { recording } : {}),
            ...(pooled.length ? { peers: pooled } : {})
          }
          return {
            defaults: routes.teamDefaults(),
            models: routes.models(),
            ...(Object.keys(policy).length ? { policy } : {}),
            ...(this._options.peers && hasTeamPool(config)
              ? { sharing: { wanted: teamWantedModels(config) } }
              : {})
          }
        }
      })
      this._options.log.info({
        event: "request",
        id,
        key: principal,
        route: outcome.route,
        outcome: outcome.outcome,
        kind: outcome.kind,
        status: outcome.status,
        ms: Date.now() - started
      })
      return
    }

    const capability = match.route
    // The response closing before anything was written means the client left.
    const left = new AbortController()
    const onClose = () => left.abort()
    res.on("close", onClose)
    const admission = await this._gate.admit({
      principal,
      route: capability,
      routes,
      workspace,
      signal: left.signal
    })
    res.removeListener("close", onClose)
    if (admission.kind === "gone") {
      this._options.log.info({
        event: "request.abandoned",
        id,
        key: principal,
        route: capability,
        waited: admission.waited
      })
      return
    }
    if (admission.kind === "refused") {
      sendError(res, refusalError(admission), { "Retry-After": "1" })
      this._options.log.warn({
        event: "request.refused",
        id,
        key: principal,
        route: capability,
        kind: "rate-limited",
        reason: admission.reason,
        active: admission.generating,
        waiting: admission.waiting,
        ...(admission.waited ? { waited: admission.waited } : {})
      })
      return
    }
    const { ticket } = admission
    const { waited } = ticket

    const recorder = this._options.recorder
    const capture = recorder?.enabled(capability) === true
    try {
      const outcome = await handleRemoteRequest(capability, req, res, {
        models: routes.models,
        route: ticket.route,
        maxBodyBytes: limits.maxBodyBytes,
        signal: ticket.signal,
        capture
      })
      const ms = Date.now() - started
      if (capture && recorder && outcome.captured && outcome.alias) {
        recorder.record({
          key: principal,
          route: capability,
          alias: outcome.alias,
          outcome: outcome.outcome,
          ms,
          usage: outcome.usage,
          capture: outcome.captured
        })
      }
      this._options.log.info({
        event: "request",
        id,
        key: principal,
        route: outcome.route,
        alias: outcome.alias,
        outcome: outcome.outcome,
        kind: outcome.kind,
        status: outcome.status,
        ms,
        ...(waited ? { waited } : {}),
        chunks: outcome.chunks,
        peer: outcome.backend
      })
      this._options.usage?.record({
        key: principal,
        route: capability,
        alias: outcome.alias,
        outcome: outcome.outcome,
        kind: outcome.kind,
        status: outcome.status,
        ms,
        ...(outcome.chunks !== undefined ? { chunks: outcome.chunks } : {}),
        ...(outcome.inputs !== undefined ? { inputs: outcome.inputs } : {}),
        ...(outcome.backend ? { peer: outcome.backend } : {}),
        usage: outcome.usage
      })
      this._options.metrics?.request({
        key: principal,
        route: capability,
        alias: outcome.alias,
        outcome: outcome.outcome,
        status: outcome.status,
        ms,
        ...(outcome.chunks !== undefined ? { chunks: outcome.chunks } : {}),
        ...(outcome.usage?.promptTokens !== undefined ? { promptTokens: outcome.usage.promptTokens } : {}),
        ...(outcome.usage?.completionTokens !== undefined ? { completionTokens: outcome.usage.completionTokens } : {})
      })
    } catch {
      // The handler reports every failure as an outcome; this is belt and braces.
      this._options.log.error({
        event: "request.crashed",
        id,
        route: capability
      })
      if (!res.headersSent)
        sendError(
          res,
          new InferenceError("inference-failure", "The gateway failed.")
        )
      else res.destroy()
    } finally {
      ticket.finish()
    }
  }
}


export const describeProtocol = () => `twinny/v${REMOTE_PROTOCOL_VERSION}`

/**
 * This machine as a member of the team's pool: one outbound WebSocket to
 * the gateway, the models it offers announced, jobs run on its local
 * server through the same inference layer the gateway uses, chunks
 * streamed back.
 *
 * Pure: no vscode. `TeamShare` wraps it with storage, settings and the
 * window lock; tests drive it against an in-process gateway.
 */
import { EventEmitter } from "node:events"

import type { TeamShareState } from "../../common/team"
import type { RemoteRouteTarget } from "../../protocol/handler"
import { runInferenceJob } from "../../protocol/job"
import {
  DEFAULT_PEER_SLOTS,
  encodePeerFrame,
  GatewayToPeerFrame,
  MAX_PEER_SLOTS,
  parseGatewayFrame,
  PEER_CLOSE,
  PEER_JOB_DEADLINE_MS,
  PEER_PING_INTERVAL_MS,
  PEER_PROTOCOL_VERSION,
  PeerModel,
  PeerProtocolError,
  peerRoutePath,
  PeerToGatewayFrame
} from "../../protocol/peer"
import {
  dialWebSocket,
  WebSocketConnection,
  WebSocketHandshakeError
} from "../../protocol/websocket"
import { InferenceError, toInferenceError } from "../inference/errors"
import type { InferenceCapability } from "../inference/types"

export interface SharerSession {
  /** The gateway base URL, as the team connection holds it. */
  url: string
  /** The developer's personal key. */
  token: string
}

export interface SharerOptions {
  /** Where to connect and as whom; undefined means "not connected to a team". */
  session(): Promise<SharerSession | undefined>
  /** What the admin page shows this computer as. */
  machine: string
  /** The local server's kind, for the admin page. */
  backendKind: string
  /** The models the local server offers now. Rejects when it is down. */
  listModels(): Promise<PeerModel[]>
  /**
   * The client for an announced model and a job. Called only for models
   * in the last announced list; anything else is refused before this.
   */
  route(model: string, capability: InferenceCapability): RemoteRouteTarget
  /** How many jobs to run at once. */
  slots?: () => number
  log?: { info(message: string): void; warn(message: string): void }
  dial?: typeof dialWebSocket
  reconnect?: { minMs: number; maxMs: number }
  modelPollMs?: number
  jobDeadlineMs?: number
  /** A gateway silent for this long is presumed gone; the socket is dropped and redialled. */
  silenceMs?: number
}

export interface SharerStatus {
  state: TeamShareState
  models: string[]
  wanted: string[]
  served: number
  backendOk?: boolean
  error?: string
  /** The gateway said not to come back (key revoked, no pool); the wrapper switches sharing off. */
  refused?: boolean
}

interface RunningJob {
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_RECONNECT = { minMs: 1_000, maxMs: 30_000 }
const DEFAULT_MODEL_POLL_MS = 60_000

/** How a handshake failure reads on the share card. */
export const describeHandshakeFailure = (error: unknown): string => {
  if (error instanceof WebSocketHandshakeError) {
    if (error.status === 401 || error.status === 403) {
      return `The gateway refused your key (HTTP ${error.status}). Reconnect to the team from the Providers tab.`
    }
    if (error.status === 404) {
      return "The gateway has no team pool configured. Ask your admin to add a \"Team members' computers\" provider."
    }
    if (error.status) {
      return `The gateway did not accept the sharing connection (HTTP ${error.status}). If a reverse proxy sits in front, enable WebSocket upgrades for ${peerRoutePath()}.`
    }
    return error.message
  }
  return toInferenceError(error).message
}

export class Sharer extends EventEmitter {
  private _state: TeamShareState = "off"
  private _socket?: WebSocketConnection
  private _models: PeerModel[] = []
  private _wanted: string[] = []
  private _served = 0
  private _error?: string
  private _refused = false
  private _backendOk?: boolean
  private _slots = DEFAULT_PEER_SLOTS
  private _attempt = 0
  private _reconnectTimer?: ReturnType<typeof setTimeout>
  private _modelTimer?: ReturnType<typeof setInterval>
  private _silenceTimer?: ReturnType<typeof setTimeout>
  private readonly _jobs = new Map<string, RunningJob>()
  private _generation = 0

  constructor(private readonly _options: SharerOptions) {
    super()
  }

  public get state(): TeamShareState {
    return this._state
  }

  public status(): SharerStatus {
    return {
      state: this._state,
      models: this._models.map((model) => model.id),
      wanted: [...this._wanted],
      served: this._served,
      ...(this._backendOk !== undefined ? { backendOk: this._backendOk } : {}),
      ...(this._error ? { error: this._error } : {}),
      ...(this._refused ? { refused: true } : {})
    }
  }

  /** Connects, and keeps reconnecting until `stop()`. Resolves once the first attempt has settled. */
  public async start(): Promise<void> {
    if (this._state !== "off") return
    this._refused = false
    this._error = undefined
    this._attempt = 0
    const generation = ++this._generation
    this.setState("connecting")
    await this.connect(generation)
  }

  /** Drops the connection and forgets nothing; a later `start()` begins afresh. */
  public stop(): void {
    this._generation++
    this.clearTimers()
    for (const [id, job] of this._jobs) {
      job.controller.abort(new InferenceError("cancelled", "Sharing stopped."))
      clearTimeout(job.timer)
      this._jobs.delete(id)
    }
    const socket = this._socket
    this._socket = undefined
    socket?.close(1000, "Sharing stopped.")
    this.setState("off")
  }

  /** Re-reads the local model list and announces a change. */
  public async refreshModels(): Promise<void> {
    let models: PeerModel[]
    try {
      models = await this._options.listModels()
      this._backendOk = true
    } catch (error) {
      this._backendOk = false
      this._options.log?.warn(
        `team share: local server is not answering: ${toInferenceError(error).message}`
      )
      models = []
    }
    const changed =
      JSON.stringify(models.map((m) => m.id)) !==
      JSON.stringify(this._models.map((m) => m.id))
    this._models = models
    if (changed && this._socket && this._state === "online")
      this.send({ type: "models", models })
    if (changed || this._backendOk !== undefined)
      this.emit("change", this.status())
  }

  /* ------------------------------------------------------------------------ */

  private async connect(generation: number): Promise<void> {
    if (generation !== this._generation) return
    const session = await this._options.session()
    if (generation !== this._generation) return
    if (!session) {
      this._error = "Connect to a team first."
      this._refused = true
      this.setState("off")
      return
    }
    await this.refreshModels()
    if (generation !== this._generation) return
    let socket: WebSocketConnection
    try {
      socket = await (this._options.dial ?? dialWebSocket)(
        `${session.url}${peerRoutePath()}`,
        {
          Authorization: `Bearer ${session.token}`
        }
      )
    } catch (error) {
      if (generation !== this._generation) return
      this._error = describeHandshakeFailure(error)
      const status =
        error instanceof WebSocketHandshakeError ? error.status : undefined
      if (status === 401 || status === 403 || status === 404) {
        this._refused = true
        this._options.log?.warn(`team share: ${this._error}`)
        this.setState("off")
        return
      }
      this.scheduleReconnect(generation)
      return
    }
    if (generation !== this._generation) {
      socket.close(1000, "Superseded.")
      return
    }
    this._socket = socket
    this._error = undefined
    socket.on("message", (text) => this.onFrame(generation, text))
    socket.on("close", (code, reason) =>
      this.onClosed(generation, code, reason)
    )
    socket.on("error", () => undefined)
    this.send({
      type: "hello",
      protocol: PEER_PROTOCOL_VERSION,
      name: this._options.machine,
      backend: { kind: this._options.backendKind },
      models: this._models,
      slots: Math.min(
        MAX_PEER_SLOTS,
        Math.max(1, this._options.slots?.() ?? DEFAULT_PEER_SLOTS)
      )
    })
    this.touch()
  }

  private onFrame(generation: number, text: string) {
    if (generation !== this._generation) return
    this.touch()
    let frame: GatewayToPeerFrame
    try {
      frame = parseGatewayFrame(text)
    } catch (error) {
      this._options.log?.warn(
        `team share: ${error instanceof PeerProtocolError ? error.message : String(error)}`
      )
      this._socket?.close(PEER_CLOSE.protocol, "Malformed frame.")
      return
    }
    switch (frame.type) {
      case "welcome":
        this._wanted = frame.wanted
        this._slots = frame.slots
        this._attempt = 0
        if (this._state !== "online") {
          this.setState("online")
          this._options.log?.info(
            `team share: online, offering ${this._models.length} model(s); the team wants ${frame.wanted.join(", ") || "nothing yet"}`
          )
          this.startModelPolling(generation)
        } else {
          this.emit("change", this.status())
        }
        return
      case "ping":
        this.send({ type: "pong" })
        return
      case "cancel": {
        const job = this._jobs.get(frame.id)
        if (job)
          job.controller.abort(
            new InferenceError("cancelled", "The requester cancelled.")
          )
        return
      }
      case "job":
        void this.runJob(generation, frame.id, frame.capability, frame.request)
        return
    }
  }

  private async runJob(
    generation: number,
    id: string,
    capability: InferenceCapability,
    request: { model: string }
  ) {
    const refuse = (error: InferenceError) =>
      this.send({
        type: "error",
        id,
        error: { kind: error.kind, message: error.message }
      })
    if (this._jobs.size >= this._slots) {
      refuse(
        new InferenceError(
          "rate-limited",
          `This computer is already running ${this._slots} request(s).`
        )
      )
      return
    }
    if (!this._models.some((model) => model.id === request.model)) {
      refuse(
        new InferenceError(
          "model-unavailable",
          `${request.model} is not offered by this computer.`
        )
      )
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(
      () =>
        controller.abort(
          new InferenceError(
            "timeout",
            "The request exceeded this computer's deadline."
          )
        ),
      this._options.jobDeadlineMs ?? PEER_JOB_DEADLINE_MS
    )
    this._jobs.set(id, { controller, timer })
    const started = Date.now()
    try {
      const result = await runInferenceJob({
        capability,
        input: request,
        route: (model, job) => {
          if (!this._models.some((entry) => entry.id === model)) {
            throw new InferenceError(
              "model-unavailable",
              `${model} is not offered by this computer.`
            )
          }
          return this._options.route(model, job)
        },
        signal: controller.signal,
        chunk: (chunk) => {
          if (generation !== this._generation || this._socket?.closed) return
          return this._socket?.send(
            encodePeerFrame({ type: "chunk", id, chunk })
          )
        }
      })
      if (generation !== this._generation) return
      if (result.outcome === "ok") {
        this._served++
        this.send({
          type: "done",
          id,
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.response ? { response: result.response } : {})
        })
      } else {
        const error =
          result.error ??
          new InferenceError("inference-failure", "The job failed.")
        if (error.kind === "provider-unavailable") this._backendOk = false
        refuse(error)
      }
      this._options.log?.info(
        `team share: ${capability} ${request.model} ${result.outcome}${result.kind ? ` (${result.kind})` : ""} in ${Date.now() - started} ms`
      )
    } finally {
      clearTimeout(timer)
      this._jobs.delete(id)
      this.emit("change", this.status())
    }
  }

  private onClosed(generation: number, code: number, reason: string) {
    if (generation !== this._generation) return
    this._socket = undefined
    this.stopModelPolling()
    if (this._silenceTimer) clearTimeout(this._silenceTimer)
    for (const [id, job] of this._jobs) {
      job.controller.abort(
        new InferenceError("cancelled", "The gateway connection closed.")
      )
      clearTimeout(job.timer)
      this._jobs.delete(id)
    }
    if (code === PEER_CLOSE.revoked || code === PEER_CLOSE.notConfigured) {
      this._refused = true
      this._error =
        code === PEER_CLOSE.revoked
          ? "Your gateway key was revoked. Ask your admin for a new one."
          : "The gateway no longer pools teammates' computers."
      this._options.log?.warn(`team share: ${this._error}`)
      this._generation++
      this.setState("off")
      return
    }
    this._error = reason
      ? `The gateway closed the connection: ${reason}`
      : "The gateway connection dropped."
    this.scheduleReconnect(generation)
  }

  private scheduleReconnect(generation: number) {
    if (generation !== this._generation) return
    const { minMs, maxMs } = this._options.reconnect ?? DEFAULT_RECONNECT
    const base = Math.min(maxMs, minMs * 2 ** Math.min(this._attempt, 10))
    const delay = Math.round(base * (0.75 + Math.random() * 0.5))
    this._attempt++
    this.setState("reconnecting")
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = undefined
      void this.connect(generation)
    }, delay)
    this._reconnectTimer.unref?.()
  }

  /** The gateway pings every 15 s; twice that with nothing at all means the link is dead. */
  private touch() {
    if (this._silenceTimer) clearTimeout(this._silenceTimer)
    const socket = this._socket
    if (!socket) return
    this._silenceTimer = setTimeout(
      () => {
        if (this._socket !== socket) return
        this._options.log?.warn(
          "team share: no word from the gateway; reconnecting"
        )
        socket.destroy(1006, "No word from the gateway.")
      },
      this._options.silenceMs ?? PEER_PING_INTERVAL_MS * 3
    )
    this._silenceTimer.unref?.()
  }

  private startModelPolling(generation: number) {
    this.stopModelPolling()
    this._modelTimer = setInterval(() => {
      if (generation !== this._generation) return
      void this.refreshModels()
    }, this._options.modelPollMs ?? DEFAULT_MODEL_POLL_MS)
    this._modelTimer.unref?.()
  }

  private stopModelPolling() {
    if (this._modelTimer) clearInterval(this._modelTimer)
    this._modelTimer = undefined
  }

  private clearTimers() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer)
    this._reconnectTimer = undefined
    if (this._silenceTimer) clearTimeout(this._silenceTimer)
    this._silenceTimer = undefined
    this.stopModelPolling()
  }

  private send(frame: PeerToGatewayFrame) {
    void this._socket?.send(encodePeerFrame(frame))
  }

  private setState(state: TeamShareState) {
    this._state = state
    this.emit("change", this.status())
  }
}

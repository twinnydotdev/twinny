/**
 * A loopback HTTP server that makes a paired device look like a local
 * Ollama.
 *
 *   GET  /p2p/<token>/<device>/api/tags            -> models
 *   GET  /p2p/<token>/<device>/v1/models           -> models (OpenAI shape)
 *   POST /p2p/<token>/<device>/v1/chat/completions -> chat
 *   POST /p2p/<token>/<device>/api/generate        -> generate
 *   POST /p2p/<token>/<device>/api/embed           -> embed
 *
 * Nothing else answers. The server binds to 127.0.0.1 on a random port and
 * the token is random per session, so the address is never stored and no
 * other local process can guess it. Streaming bodies are relayed as they
 * arrive; closing the HTTP request cancels the remote generation.
 */

import { randomBytes } from "node:crypto"
import http from "node:http"
import { AddressInfo } from "node:net"

import { logger } from "../../common/logger"
import {
  InferenceBody,
  InferenceKind,
  isInferenceKind,
  P2pClient,
  P2pRequestError,
  RemoteModel
} from "../../p2p"

const MAX_BODY_BYTES = 16 * 1024 * 1024
const CONNECT_TIMEOUT_MS = 20_000

export type GatewayRoute = InferenceKind | "tags" | "models"

export interface GatewayMatch {
  token: string
  deviceId: string
  route: GatewayRoute
}

export interface GatewayAddress {
  hostname: string
  port: number
  /** `/p2p/<token>/<device>` — the provider's path is appended to this. */
  basePath: string
}

/** Hands the gateway a live client, or throws a `P2pRequestError`. */
export type ClientResolver = (deviceId: string) => Promise<P2pClient>

const ROUTES: Record<string, { method: string; route: GatewayRoute }> = {
  "api/tags": { method: "GET", route: "tags" },
  "v1/models": { method: "GET", route: "models" },
  "v1/chat/completions": { method: "POST", route: "chat" },
  "api/generate": { method: "POST", route: "generate" },
  "api/embed": { method: "POST", route: "embed" }
}

/** Pure, so the routing table has a unit test of its own. */
export const matchGatewayRoute = (
  method: string | undefined,
  pathname: string
): GatewayMatch | undefined => {
  const match = /^\/p2p\/([0-9a-f]{32})\/([0-9a-f]{64})\/(.+?)\/?$/i.exec(
    pathname
  )
  if (!match) return undefined
  const [, token, deviceId, rest] = match
  const entry = ROUTES[rest.toLowerCase()]
  if (!entry || entry.method !== (method || "").toUpperCase()) return undefined
  return {
    token: token.toLowerCase(),
    deviceId: deviceId.toLowerCase(),
    route: entry.route
  }
}

/** Ollama's `/api/tags` shape, which twinny's model listing already reads. */
export const toOllamaTags = (models: RemoteModel[]) => ({
  models: models.map((model) => ({
    name: model.name,
    model: model.name,
    size: model.size,
    details: {
      family: model.family,
      parameter_size: model.parameterSize,
      quantization_level: model.quantization
    }
  }))
})

export const toOpenAiModels = (models: RemoteModel[]) => ({
  object: "list",
  data: models.map((model) => ({
    id: model.name,
    object: "model",
    owned_by: "twinny-p2p"
  }))
})

/** HTTP status for a P2P failure, so existing error handling reads well. */
export const statusForError = (error: unknown): number => {
  const code = error instanceof P2pRequestError ? error.code : undefined
  switch (code) {
    case "unauthorized":
    case "pairing-closed":
    case "pairing-failed":
      return 403
    case "bad-request":
      return 400
    case "busy":
      return 429
    case "timeout":
      return 504
    case "disconnected":
      return 503
    default:
      return 502
  }
}

export class P2pGateway {
  private readonly _token = randomBytes(16).toString("hex")
  private _server?: http.Server
  private _port = 0

  constructor(private readonly _resolveClient: ClientResolver) {}

  public get running(): boolean {
    return !!this._server && this._port > 0
  }

  public get port(): number {
    return this._port
  }

  public get token(): string {
    return this._token
  }

  public addressFor(deviceId: string): GatewayAddress | undefined {
    if (!this.running || !/^[0-9a-f]{64}$/i.test(deviceId)) return undefined
    return {
      hostname: "127.0.0.1",
      port: this._port,
      basePath: `/p2p/${this._token}/${deviceId.toLowerCase()}`
    }
  }

  public start(): Promise<number> {
    if (this._server) return Promise.resolve(this._port)
    const server = http.createServer((req, res) => void this.handle(req, res))
    server.keepAliveTimeout = 65_000
    server.headersTimeout = 70_000
    // Streams can be quiet for a long time while a model loads.
    server.requestTimeout = 0
    this._server = server
    return new Promise<number>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject)
        this._port = (server.address() as AddressInfo).port
        logger.log(`p2p gateway listening on 127.0.0.1:${this._port}`)
        resolve(this._port)
      })
    })
  }

  public stop(): Promise<void> {
    const server = this._server
    this._server = undefined
    this._port = 0
    if (!server) return Promise.resolve()
    return new Promise((resolve) => {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
      server.close(() => resolve())
    })
  }

  /* ------------------------------------------------------------------------ */

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || "/", "http://127.0.0.1")
    const match = matchGatewayRoute(req.method, url.pathname)
    if (!match || match.token !== this._token) {
      this.fail(res, 404, "Not found.")
      return
    }

    let client: P2pClient
    try {
      client = await this._resolveClient(match.deviceId)
      await client.connect(CONNECT_TIMEOUT_MS)
    } catch (error) {
      this.fail(res, statusForError(error), this.describe(error))
      return
    }

    try {
      switch (match.route) {
        case "tags":
          this.json(res, 200, toOllamaTags(await client.listModels()))
          return
        case "models":
          this.json(res, 200, toOpenAiModels(await client.listModels()))
          return
        default:
          await this.relay(req, res, client, match.route)
      }
    } catch (error) {
      if (!res.headersSent)
        this.fail(res, statusForError(error), this.describe(error))
      else res.destroy()
    }
  }

  private async relay(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    client: P2pClient,
    kind: InferenceKind
  ) {
    if (!isInferenceKind(kind)) {
      this.fail(res, 404, "Not found.")
      return
    }

    let body: InferenceBody
    try {
      body = await this.readJson(req)
    } catch (error) {
      this.fail(res, 400, this.describe(error))
      return
    }

    let finished = false
    const handle = client.infer(kind, body, {
      onHead: (head) => {
        if (res.headersSent) return
        res.writeHead(head.status, {
          "Content-Type": head.contentType,
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no"
        })
        res.flushHeaders()
      },
      onChunk: (chunk) => {
        if (!res.headersSent)
          res.writeHead(200, { "Content-Type": "application/json" })
        res.write(chunk)
      },
      onEnd: () => {
        finished = true
        if (!res.headersSent)
          res.writeHead(200, { "Content-Type": "application/json" })
        res.end()
      },
      onError: (error) => {
        finished = true
        if (error.code === "cancelled") {
          res.destroy()
          return
        }
        if (!res.headersSent)
          this.fail(res, statusForError(error), this.describe(error))
        else res.destroy()
      }
    })

    // The caller going away (a stop button, an aborted completion) must stop
    // the GPU too, not just the pipe.
    res.on("close", () => {
      if (!finished) handle.cancel()
    })
  }

  private readJson(req: http.IncomingMessage): Promise<InferenceBody> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(
            new P2pRequestError("bad-request", "The request body is too large.")
          )
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on("end", () => {
        try {
          const parsed: unknown = JSON.parse(
            Buffer.concat(chunks as Uint8Array[]).toString("utf8") || "{}"
          )
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            typeof (parsed as { model?: unknown }).model !== "string"
          ) {
            reject(
              new P2pRequestError(
                "bad-request",
                "The request must name a model."
              )
            )
            return
          }
          resolve(parsed as InferenceBody)
        } catch {
          reject(
            new P2pRequestError("bad-request", "The request body is not JSON.")
          )
        }
      })
      req.on("error", (error) =>
        reject(new P2pRequestError("bad-request", error.message))
      )
    })
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private json(res: http.ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(value))
  }

  /** Both Ollama's and OpenAI's error shapes, so either client reads it. */
  private fail(res: http.ServerResponse, status: number, message: string) {
    this.json(res, status, { error: { message, type: "twinny_p2p" } })
  }
}

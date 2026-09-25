/**
 * The extension side of the protocol: an `InferenceProvider` whose backend
 * is a gateway. The registry wraps it like any other adapter, so features
 * see the usual client, and the gateway's normalized errors come back as
 * the same `InferenceError` kinds they were sent as.
 */
import { API_PROVIDERS } from "../common/constants"
import { deadline } from "../common/deadline"
import { getProviderOrigin } from "../common/provider-validation"
import { TwinnyProvider } from "../common/types"
import { InferenceError, toInferenceError } from "../extension/inference/errors"
import {
  ChatChunk,
  ChatRequest,
  EmbeddingRequest,
  EmbeddingResponse,
  FimChunk,
  FimRequest,
  InferenceCapability,
  InferenceModel,
  InferenceOptions,
  InferenceProvider
} from "../extension/inference/types"

import {
  REMOTE_JOIN_PATH,
  REMOTE_PROTOCOL_BASE,
  REMOTE_SIGNIN_PATH,
  REMOTE_SIGNIN_POLL_PATH,
  RemoteIdentity,
  RemoteJoinResult,
  RemoteRoute,
  RemoteSignInPoll,
  RemoteSignInStart,
  RemoteStatus,
  RemoteTeam
} from "./types"
import {
  errorFromBody,
  isDoneFrame,
  isErrorBody,
  kindForStatus,
  parseFrame,
  parseIdentity,
  parseModels,
  parseStatus,
  parseTeam,
  remoteRoutePath
} from "./wire"

/** Waiting on the gateway's first byte for longer than this is a failure. */
const CONNECT_TIMEOUT_MS = 60_000
const MAX_ERROR_BODY = 400

export interface RemoteEndpoint {
  /** Origin plus any base path, e.g. `http://gpu-box:8765` or `https://ai.example/twinny`. */
  baseUrl: string
  token?: string
}

type Fetch = typeof fetch

/** The endpoint a stored provider names; the token is whatever it carries. */
export const endpointFromProvider = (config: TwinnyProvider): RemoteEndpoint => {
  const origin = getProviderOrigin({
    ...config,
    apiHostname: config.apiHostname || "localhost"
  })
  const base = (config.apiPath || "").replace(/\/+$/, "")
  return { baseUrl: `${origin}${base}`, token: config.apiKey || undefined }
}

export class RemoteInferenceProvider implements InferenceProvider {
  public readonly id = API_PROVIDERS.TwinnyRemote

  constructor(
    private readonly _endpoint: RemoteEndpoint,
    private readonly _fetch: Fetch = fetch,
    /** The workspace the request is for, sent as `X-Twinny-Workspace` so routing rules can apply. */
    private readonly _workspace: () => string | undefined = () => undefined
  ) {}

  public static fromProvider(config: TwinnyProvider, fetchImpl?: Fetch, workspace?: () => string | undefined) {
    return new RemoteInferenceProvider(endpointFromProvider(config), fetchImpl, workspace)
  }

  /** The gateway decides per alias; the client can attempt any of them. */
  public capabilities(): InferenceCapability[] {
    return ["fim", "chat", "embeddings"]
  }

  public async models(options?: InferenceOptions): Promise<InferenceModel[]> {
    const response = await this.send("models", undefined, options?.signal)
    return parseModels(await response.json())
  }

  /** Who the gateway takes this provider's credential for. */
  public async whoami(options?: InferenceOptions): Promise<RemoteIdentity> {
    const response = await this.send("whoami", undefined, options?.signal)
    return parseIdentity(await response.json())
  }

  /** The gateway's live check of its backends. */
  public async status(options?: InferenceOptions): Promise<RemoteStatus> {
    const response = await this.send("status", undefined, options?.signal)
    return parseStatus(await response.json())
  }

  public async team(options?: InferenceOptions): Promise<RemoteTeam> {
    const response = await this.send("team", undefined, options?.signal)
    return parseTeam(await response.json())
  }

  /** Asks the gateway for a sign-in code. Needs no credential. */
  public async startSignIn(
    request: { name?: string; machine?: string },
    options?: InferenceOptions
  ): Promise<RemoteSignInStart> {
    const response = await this.send(REMOTE_SIGNIN_PATH, request, options?.signal)
    const body = (await response.json()) as Record<string, unknown>
    if (
      typeof body?.deviceCode !== "string" ||
      typeof body?.userCode !== "string" ||
      typeof body?.expiresAt !== "string"
    ) {
      throw new InferenceError("inference-failure", "The gateway sent no sign-in code.")
    }
    return {
      deviceCode: body.deviceCode,
      userCode: body.userCode,
      expiresAt: body.expiresAt,
      interval: typeof body.interval === "number" && body.interval > 0 ? body.interval : 3
    }
  }

  /**
   * Opens an invite: the code from the admin's link becomes a key, once.
   * Needs no credential. A used, withdrawn, expired or unknown code is an
   * `authentication` error with the gateway's reason.
   */
  public async join(request: { code: string; machine?: string }, options?: InferenceOptions): Promise<RemoteJoinResult> {
    const response = await this.send(REMOTE_JOIN_PATH, request, options?.signal)
    const body = (await response.json()) as Record<string, unknown>
    if (typeof body?.key !== "string" || typeof body?.name !== "string") {
      throw new InferenceError("inference-failure", "The gateway accepted the invite but sent no key.")
    }
    return { key: body.key, name: body.name, admin: body.admin === true }
  }

  /** Whether the admin has approved yet. The key, when it comes, comes once. */
  public async pollSignIn(deviceCode: string, options?: InferenceOptions): Promise<RemoteSignInPoll> {
    const response = await this.send(REMOTE_SIGNIN_POLL_PATH, { deviceCode }, options?.signal)
    const body = (await response.json()) as Record<string, unknown>
    switch (body?.status) {
      case "pending":
      case "slow-down":
      case "denied":
      case "expired":
        return { status: body.status }
      case "approved":
        if (typeof body.key !== "string" || typeof body.name !== "string") {
          throw new InferenceError("inference-failure", "The gateway approved the sign-in but sent no key.")
        }
        return { status: "approved", key: body.key, name: body.name }
      default:
        throw new InferenceError("inference-failure", "The gateway sent an unexpected sign-in status.")
    }
  }

  public fim(request: FimRequest, options?: InferenceOptions) {
    return this.stream<FimChunk>("fim", request, options)
  }

  public chat(request: ChatRequest, options?: InferenceOptions) {
    // The protocol carries a conversation as roles and content; anything
    // the extension keeps on a message for itself stays here.
    const messages = request.messages.map(({ role, content }) => ({ role, content }))
    return this.stream<ChatChunk>("chat", { ...request, messages }, options)
  }

  public async embeddings(
    request: EmbeddingRequest,
    options?: InferenceOptions
  ): Promise<EmbeddingResponse> {
    const response = await this.send("embeddings", request, options?.signal)
    const body = (await response.json()) as { vectors?: unknown }
    const vectors = Array.isArray(body?.vectors) ? (body.vectors as number[][]) : []
    if (!vectors.length) {
      throw new InferenceError(
        "inference-failure",
        "The gateway answered but returned no embedding vector."
      )
    }
    return { vectors }
  }

  /* ------------------------------------------------------------------------ */

  private headers(): Record<string, string> {
    const { token } = this._endpoint
    return {
      Accept: "application/json, application/x-ndjson",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(this._workspace() ? { "X-Twinny-Workspace": String(this._workspace()).slice(0, 200) } : {})
    }
  }

  private url(route: RemoteRoute | `/${string}`) {
    return `${this._endpoint.baseUrl}${route.startsWith("/") ? `${REMOTE_PROTOCOL_BASE}${route}` : remoteRoutePath(route as RemoteRoute)}`
  }

  /**
   * One request, answered or failed. Redirects are never followed: the
   * token is for the configured gateway, not wherever it might point.
   */
  private async send(
    route: RemoteRoute | `/${string}`,
    body: unknown,
    signal: AbortSignal | undefined,
    keepOpen?: (answered: () => void, done: () => void) => void
  ): Promise<Response> {
    const timer = deadline(CONNECT_TIMEOUT_MS, {
      parent: signal,
      reason: () =>
        new InferenceError(
          "timeout",
          `The gateway did not answer within ${CONNECT_TIMEOUT_MS / 1000}s.`
        )
    })
    let response: Response
    try {
      response = await this._fetch(this.url(route), {
        method: body === undefined ? "GET" : "POST",
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timer.signal,
        redirect: "manual"
      })
    } catch (error) {
      timer.done()
      throw this.transportError(error, timer.signal)
    }
    const redirected =
      response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)
    if (redirected || !response.ok) timer.done()
    else if (keepOpen) keepOpen(timer.answered, timer.done)
    else timer.done()

    if (redirected) {
      throw new InferenceError(
        "provider-unavailable",
        "The gateway answered with a redirect. Requests are not repeated at another address; point the provider at the gateway itself.",
        { status: response.status }
      )
    }
    if (!response.ok) throw await this.responseError(response)
    return response
  }

  private async *stream<T>(
    route: "fim" | "chat",
    request: unknown,
    options?: InferenceOptions
  ): AsyncGenerator<T> {
    let answered = () => undefined as void
    let release = () => undefined as void
    const response = await this.send(route, request, options?.signal, (onAnswer, onDone) => {
      answered = onAnswer
      release = onDone
    })
    if (!response.body) {
      release()
      throw new InferenceError("inference-failure", "The gateway sent no reply body.")
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""
    let ended = false
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        // The first byte arrived: the connect clock stops, the consumer's
        // signal keeps the connection on a leash until the stream is over.
        answered()
        buffer += value
        let newline: number
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          const frame = parseFrame(line)
          if (frame === undefined) continue
          if (isErrorBody(frame)) throw errorFromBody(frame)
          if (isDoneFrame(frame)) {
            ended = true
            return
          }
          yield frame as T
        }
      }
      const rest = parseFrame(buffer)
      if (rest !== undefined) {
        if (isErrorBody(rest)) throw errorFromBody(rest)
        if (isDoneFrame(rest)) {
          ended = true
          return
        }
        yield rest as T
      }
      if (!ended) {
        throw new InferenceError(
          "provider-unavailable",
          "The gateway closed the stream before the reply finished."
        )
      }
    } catch (error) {
      throw this.transportError(error, options?.signal)
    } finally {
      release()
      await reader.cancel().catch(() => undefined)
    }
  }

  private transportError(error: unknown, signal?: AbortSignal): InferenceError {
    if (signal?.aborted && signal.reason instanceof InferenceError) return signal.reason
    return toInferenceError(error)
  }

  private async responseError(response: Response): Promise<InferenceError> {
    let text = ""
    try {
      text = (await response.text()).slice(0, MAX_ERROR_BODY)
    } catch {
      // The status alone will have to do.
    }
    try {
      const parsed = JSON.parse(text)
      if (isErrorBody(parsed)) return errorFromBody(parsed, response.status)
    } catch {
      // Not the protocol's error shape: a proxy in front of the gateway, probably.
    }
    return new InferenceError(
      kindForStatus(response.status),
      `The gateway responded with status ${response.status}${text ? `: ${text.trim()}` : ""}`,
      { status: response.status }
    )
  }
}

/**
 * Who a stored gateway provider connects as, for the provider UI. Errors
 * come back as `InferenceError`s like everything else the client throws.
 */
export const fetchRemoteIdentity = (
  config: TwinnyProvider,
  options?: InferenceOptions
): Promise<RemoteIdentity> => RemoteInferenceProvider.fromProvider(config).whoami(options)

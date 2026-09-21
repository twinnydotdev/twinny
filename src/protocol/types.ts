/**
 * The Twinny remote inference protocol, version 1.
 *
 * The extension's remote provider speaks it to a gateway; the gateway
 * answers it with whatever inference adapter it has configured. Requests
 * and replies are the inference layer's own shapes (`FimRequest`,
 * `ChatRequest`, `EmbeddingRequest`, their chunks and `InferenceModel`),
 * carried as JSON over HTTP:
 *
 *   GET  {base}/twinny/v1/models      -> { protocol, models }
 *   GET  {base}/twinny/v1/whoami      -> { protocol, key, shared }
 *   GET  {base}/twinny/v1/status      -> { protocol, backends, models }  (live backend checks)
 *   POST {base}/twinny/v1/fim         -> NDJSON stream of FimChunk
 *   POST {base}/twinny/v1/chat        -> NDJSON stream of ChatChunk
 *   POST {base}/twinny/v1/embeddings  -> EmbeddingResponse
 *
 * A stream is one JSON object per line: the chunks themselves, then either
 * `{"done":true}` or `{"error":{"kind","message"}}`. A failure before the
 * stream starts is an HTTP error whose body is that same error object, so
 * the client rebuilds the `InferenceError` kind the gateway saw.
 *
 * Every request names a public model alias and a capability and nothing
 * else about where or how it is served: the gateway owns its configuration.
 *
 * Pure: no vscode, shared by the extension and the gateway.
 */
import type { InferenceErrorKind } from "../extension/inference/errors"
import type {
  InferenceCapability,
  InferenceModel
} from "../extension/inference/types"

export const REMOTE_PROTOCOL_VERSION = 1

/** Every route lives under this path, after whatever base the gateway has. */
export const REMOTE_PROTOCOL_BASE = "/twinny/v1"

export type TeamDefaults = Partial<Record<InferenceCapability, string>>

/**
 * What a team's admin asks connected extensions to enforce. Sent on the
 * team route only when the gateway's licence carries the `policy` feature.
 */
export interface TeamPolicy {
  /**
   * Only the team gateway: a connected developer may not add or activate
   * providers of any other kind. Absent or false means no restriction.
   */
  teamOnly?: boolean
  /** While connected, the team's default models stay the active ones for their jobs. */
  lockDefaults?: boolean
  /**
   * Which requests the gateway keeps the content of. Disclosure, not a
   * rule the extension enforces; sent whenever recording is on.
   */
  recording?: InferenceCapability[]
  /**
   * Aliases served by teammates' computers: requests to them run on a
   * colleague's machine. Disclosure, sent whenever the pool has aliases.
   */
  peers?: string[]
  /** Put before every chat's system prompt on connected extensions. */
  systemPrompt?: string
}

/** The gateway has a team pool: connected extensions may share their computer. */
export interface TeamSharing {
  /** Backend model names the pool's aliases want. */
  wanted: string[]
}

export interface RemoteTeam extends RemoteModelsResponse {
  defaults: TeamDefaults
  policy?: TeamPolicy
  sharing?: TeamSharing
}

export type RemoteRoute = "models" | "whoami" | "status" | "team" | InferenceCapability

export const REMOTE_ROUTE_PATHS: Record<RemoteRoute, string> = {
  models: "/models",
  whoami: "/whoami",
  status: "/status",
  team: "/team",
  fim: "/fim",
  chat: "/chat",
  embeddings: "/embeddings"
}

export const REMOTE_ROUTES = Object.keys(REMOTE_ROUTE_PATHS) as RemoteRoute[]

/** Sign-in: how a client gets a key. Neither path takes a credential. */
export const REMOTE_SIGNIN_PATH = "/signin"
export const REMOTE_SIGNIN_POLL_PATH = "/signin/poll"

export interface RemoteSignInStart {
  deviceCode: string
  userCode: string
  expiresAt: string
  /** Seconds between polls. */
  interval: number
}

export type RemoteSignInPoll =
  | { status: "pending" | "slow-down" | "denied" | "expired" }
  | { status: "approved"; key: string; name: string }

/** Join: opening an invite link. Takes no credential; the code is the credential, once. */
export const REMOTE_JOIN_PATH = "/join"

export interface RemoteJoinResult {
  key: string
  name: string
  admin: boolean
}

/** The extension id the invite link opens: `vscode://<id>/join`. */
export const TWINNY_EXTENSION_ID = "rjmacarthy.twinny"

/**
 * The link an admin sends. Opening it in VS Code (or a fork, with its own
 * scheme) connects the developer: the extension opens the invite, gets a
 * key, and shows the team's defaults to confirm.
 */
export const inviteLink = (gatewayUrl: string, code: string, scheme = "vscode"): string => {
  const query = new URLSearchParams({ url: gatewayUrl.replace(/\/+$/, ""), code })
  return `${scheme}://${TWINNY_EXTENSION_ID}/join?${query.toString()}`
}

/** A link with no code: opens Connect to team with the URL filled in. */
export const teamLink = (gatewayUrl: string, scheme = "vscode"): string => {
  const query = new URLSearchParams({ url: gatewayUrl.replace(/\/+$/, "") })
  return `${scheme}://${TWINNY_EXTENSION_ID}/team?${query.toString()}`
}

export const REMOTE_STREAM_CONTENT_TYPE = "application/x-ndjson"

export interface RemoteModelsResponse {
  protocol: number
  models: InferenceModel[]
}

/** Who the gateway took the caller for. */
export interface RemoteIdentity {
  protocol: number
  /** The key's name, or `shared` for the shared token. */
  key: string
  shared: boolean
  /** Whether the credential may read the gateway's admin routes. */
  admin?: boolean
}

export interface RemoteBackendStatus {
  /** The configured provider name, not its address. */
  provider: string
  ok: boolean
  /** Why it failed, when it did. */
  kind?: InferenceErrorKind
  ms: number
  /** For the team pool: how many teammates' computers are connected. */
  peers?: number
}

/** The gateway's own view of its backends, checked when asked. */
export interface RemoteStatus {
  protocol: number
  backends: RemoteBackendStatus[]
  models: Array<{ id: string; provider: string; ok: boolean }>
}

export interface RemoteErrorBody {
  error: {
    kind: InferenceErrorKind
    message: string
  }
}

export interface RemoteDoneFrame {
  done: true
}

/** One line of a streamed reply. */
export type RemoteStreamFrame<T> = T | RemoteDoneFrame | RemoteErrorBody

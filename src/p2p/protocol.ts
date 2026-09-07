/**
 * The Twinny peer-to-peer inference protocol.
 *
 * Two parties: a *client* (the VS Code extension) and a *node* (a machine
 * running Ollama). They speak newline-delimited JSON frames over one
 * Noise-encrypted hyperdht stream. Every frame carries a request `id` so a
 * single connection can multiplex many streaming requests.
 *
 * The node only ever does five things: prove it is alive, list the models it
 * serves, accept a pairing request, forward an inference request to one of
 * three fixed Ollama routes, and cancel one. Nothing here can reach any
 * other URL, run a command, or touch a file.
 *
 * Pure: no vscode, no networking. Shared by the extension and the node.
 */

export const P2P_PROTOCOL_VERSION = 1

/** The largest single frame either side will accept. Prompts carry images. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

/**
 * The only Ollama routes a node will forward to, keyed by the request type
 * the client sends. `chat` is Ollama's OpenAI-compatible endpoint, which is
 * what twinny's chat already speaks; the other two are Ollama's own.
 */
export const INFERENCE_ROUTES = {
  chat: "/v1/chat/completions",
  generate: "/api/generate",
  embed: "/api/embed"
} as const

export type InferenceKind = keyof typeof INFERENCE_ROUTES

export const INFERENCE_KINDS = Object.keys(INFERENCE_ROUTES) as InferenceKind[]

/** A request body forwarded to Ollama. Only `model` is inspected. */
export interface InferenceBody {
  model: string
  [key: string]: unknown
}

export interface NodeInfo {
  name: string
  publicKey: string
  version: number
}

export interface RemoteModel {
  name: string
  size?: number
  family?: string
  parameterSize?: string
  quantization?: string
}

export type P2pErrorCode =
  | "unauthorized"
  | "bad-request"
  | "busy"
  | "upstream"
  | "cancelled"
  | "pairing-closed"
  | "pairing-failed"
  | "unsupported"

/* -------------------------------------------------------------------------- */
/*  client -> node                                                            */
/* -------------------------------------------------------------------------- */

export interface PairFrame {
  id: string
  type: "pair"
  /** Hex of the secret half of the pairing code. */
  secret: string
  /** What the node should call this device in its list. */
  name?: string
  version: number
}

export interface PingFrame {
  id: string
  type: "ping"
}

export interface ModelsFrame {
  id: string
  type: "models"
}

export interface InferenceFrame {
  id: string
  type: InferenceKind
  request: InferenceBody
}

export interface CancelFrame {
  type: "cancel"
  id: string
}

export type ClientFrame =
  | PairFrame
  | PingFrame
  | ModelsFrame
  | InferenceFrame
  | CancelFrame

/* -------------------------------------------------------------------------- */
/*  node -> client                                                            */
/* -------------------------------------------------------------------------- */

export interface PairedFrame {
  id: string
  type: "paired"
  node: NodeInfo
}

export interface PongFrame {
  id: string
  type: "pong"
  node: NodeInfo
  /** Whether the node could reach its Ollama when it answered. */
  ollama: boolean
}

export interface ModelListFrame {
  id: string
  type: "models"
  models: RemoteModel[]
}

/** First frame of an inference reply: what Ollama answered with. */
export interface HeadFrame {
  id: string
  type: "head"
  status: number
  contentType: string
}

export interface BodyFrame {
  id: string
  type: "body"
  chunk: string
}

export interface EndFrame {
  id: string
  type: "end"
}

export interface ErrorFrame {
  id: string
  type: "error"
  code: P2pErrorCode
  message: string
}

export type NodeFrame =
  | PairedFrame
  | PongFrame
  | ModelListFrame
  | HeadFrame
  | BodyFrame
  | EndFrame
  | ErrorFrame

/* -------------------------------------------------------------------------- */
/*  Parsing                                                                   */
/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 64

export const isInferenceKind = (value: unknown): value is InferenceKind =>
  typeof value === "string" && value in INFERENCE_ROUTES

/**
 * Turns whatever a peer sent into a frame the node understands, or nothing.
 * Anything unexpected is dropped on the floor rather than half-handled.
 */
export const parseClientFrame = (value: unknown): ClientFrame | undefined => {
  if (!isRecord(value) || !isId(value.id)) return undefined
  const { id, type } = value

  switch (type) {
    case "ping":
    case "models":
      return { id, type }
    case "cancel":
      return { id, type }
    case "pair":
      if (typeof value.secret !== "string") return undefined
      return {
        id,
        type,
        secret: value.secret,
        name: typeof value.name === "string" ? value.name.slice(0, 80) : undefined,
        version: typeof value.version === "number" ? value.version : 0
      }
    default:
      if (!isInferenceKind(type)) return undefined
      if (!isRecord(value.request) || typeof value.request.model !== "string") {
        return undefined
      }
      return { id, type, request: value.request as InferenceBody }
  }
}

export const parseNodeFrame = (value: unknown): NodeFrame | undefined => {
  if (!isRecord(value) || !isId(value.id)) return undefined
  const { id, type } = value

  switch (type) {
    case "paired":
      return isRecord(value.node)
        ? { id, type, node: value.node as unknown as NodeInfo }
        : undefined
    case "pong":
      return isRecord(value.node)
        ? {
            id,
            type,
            node: value.node as unknown as NodeInfo,
            ollama: value.ollama === true
          }
        : undefined
    case "models":
      return {
        id,
        type,
        models: Array.isArray(value.models)
          ? value.models.filter(
              (m): m is RemoteModel => isRecord(m) && typeof m.name === "string"
            )
          : []
      }
    case "head":
      return {
        id,
        type,
        status: typeof value.status === "number" ? value.status : 200,
        contentType:
          typeof value.contentType === "string"
            ? value.contentType
            : "application/octet-stream"
      }
    case "body":
      return typeof value.chunk === "string"
        ? { id, type, chunk: value.chunk }
        : undefined
    case "end":
      return { id, type }
    case "error":
      return {
        id,
        type,
        code: (typeof value.code === "string" ? value.code : "upstream") as P2pErrorCode,
        message: typeof value.message === "string" ? value.message : "Unknown error"
      }
    default:
      return undefined
  }
}

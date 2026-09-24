/**
 * The peer protocol, version 1: how a developer's extension serves its
 * local models to the team through the gateway.
 *
 * One WebSocket per sharing machine, opened by the extension to
 * `GET {base}/twinny/v1/peers` with its usual bearer key. Text frames,
 * one JSON object each. The gateway hands the peer jobs in the same
 * shapes its own adapters get (`FimRequest`, `ChatRequest`,
 * `EmbeddingRequest`, already validated); the peer streams back the
 * same chunks and usage the HTTP protocol carries.
 *
 * Sharer -> gateway: hello, models, chunk, done, error, pong.
 * Gateway -> sharer: welcome, job, cancel, ping.
 *
 * Pure: no vscode, shared by the extension and the gateway.
 */
import { isRecord } from "../common/guards"
import { InferenceError } from "../extension/inference/errors"
import type {
  ChatChunk,
  ChatRequest,
  EmbeddingRequest,
  EmbeddingResponse,
  FimChunk,
  FimRequest,
  InferenceCapability,
  InferenceUsage
} from "../extension/inference/types"

import { REMOTE_PROTOCOL_BASE } from "./types"
import {
  isInferenceCapability,
  isInferenceErrorKind,
  parseRequest
} from "./wire"

export const PEER_PROTOCOL_VERSION = 1

export const PEER_PATH = "/peers"

/** The full route below a base such as `/ai` (or nothing). */
export const peerRoutePath = (basePath = ""): string =>
  `${basePath}${REMOTE_PROTOCOL_BASE}${PEER_PATH}`

/** How many jobs a sharer runs at once unless it says otherwise. */
export const DEFAULT_PEER_SLOTS = 2
/** The most the gateway will ever hand one peer at once. */
export const MAX_PEER_SLOTS = 8

/** The first frame must arrive within this, or the socket is closed. */
export const HELLO_TIMEOUT_MS = 5_000
/** The gateway pings this often; a peer silent for two intervals is gone. */
export const PEER_PING_INTERVAL_MS = 15_000
/** How long one job may run on a peer before the sharer gives up on it. */
export const PEER_JOB_DEADLINE_MS = 120_000
/** A peer whose local server refused a job is skipped for this long. */
export const PEER_DEGRADED_MS = 30_000

/** Close codes the gateway uses; 4000–4999 are the application's own. */
export const PEER_CLOSE = {
  /** The gateway is stopping. */
  stopping: 1001,
  /** The key was revoked; do not reconnect. */
  revoked: 4001,
  /** A malformed frame or a broken promise (a job for a model not announced, say). */
  protocol: 4002,
  /** An admin disconnected this peer from the admin page. */
  disconnected: 4003,
  /** The gateway has no team pool configured; do not reconnect until it does. */
  notConfigured: 4004
} as const

export interface PeerModel {
  id: string
  name: string
}

export interface PeerBackend {
  /** The local server's kind: `ollama`, `lmstudio`… informational. */
  kind: string
}

/* ------------------------------- sharer -> gateway ------------------------ */

export interface PeerHelloFrame {
  type: "hello"
  protocol: number
  /** The machine's name, for the admin page: `desktop`. */
  name: string
  backend: PeerBackend
  models: PeerModel[]
  slots: number
}

export interface PeerModelsFrame {
  type: "models"
  models: PeerModel[]
}

export interface PeerChunkFrame {
  type: "chunk"
  id: string
  chunk: FimChunk | ChatChunk
}

export interface PeerDoneFrame {
  type: "done"
  id: string
  usage?: InferenceUsage
  /** Embeddings answer whole: the response rides on the done frame. */
  response?: EmbeddingResponse
}

export interface PeerErrorFrame {
  type: "error"
  id: string
  error: { kind: InferenceError["kind"]; message: string }
}

export interface PeerPongFrame {
  type: "pong"
}

export type PeerToGatewayFrame =
  | PeerHelloFrame
  | PeerModelsFrame
  | PeerChunkFrame
  | PeerDoneFrame
  | PeerErrorFrame
  | PeerPongFrame

/* ------------------------------- gateway -> sharer ------------------------ */

export interface PeerWelcomeFrame {
  type: "welcome"
  protocol: number
  /** Backend model names the pool's aliases want; what the share card shows. */
  wanted: string[]
  /** min(peer's slots, gateway cap). */
  slots: number
}

export interface PeerJobFrame {
  type: "job"
  id: string
  capability: InferenceCapability
  /** Already validated by the gateway; `model` is the backend model name. */
  request: FimRequest | ChatRequest | EmbeddingRequest
}

export interface PeerCancelFrame {
  type: "cancel"
  id: string
}

export interface PeerPingFrame {
  type: "ping"
}

export type GatewayToPeerFrame =
  | PeerWelcomeFrame
  | PeerJobFrame
  | PeerCancelFrame
  | PeerPingFrame

/* -------------------------------------------------------------------------- */
/*  Parsing                                                                   */
/* -------------------------------------------------------------------------- */

export class PeerProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PeerProtocolError"
  }
}

const MAX_NAME_CHARS = 64
const MAX_MODEL_CHARS = 128
const MAX_MODELS = 500
const MAX_ID_CHARS = 64
const MAX_ERROR_MESSAGE_CHARS = 400

const parseJson = (text: string): Record<string, unknown> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new PeerProtocolError("A frame was not JSON.")
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    throw new PeerProtocolError("A frame had no type.")
  }
  return parsed
}

const requireId = (frame: Record<string, unknown>): string => {
  const id = frame.id
  if (typeof id !== "string" || !id || id.length > MAX_ID_CHARS) {
    throw new PeerProtocolError(`A ${String(frame.type)} frame had no job id.`)
  }
  return id
}

/** A machine or model name as it may appear on the admin page: trimmed, bounded, one line. */
const cleanName = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined
  const text = value
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, max)
  return text || undefined
}

export const parsePeerModels = (value: unknown): PeerModel[] => {
  if (!Array.isArray(value))
    throw new PeerProtocolError("\"models\" must be a list.")
  const models: PeerModel[] = []
  const seen = new Set<string>()
  for (const entry of value.slice(0, MAX_MODELS)) {
    if (!isRecord(entry)) continue
    const id = cleanName(entry.id, MAX_MODEL_CHARS)
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push({ id, name: cleanName(entry.name, MAX_MODEL_CHARS) ?? id })
  }
  return models
}

const parseSlots = (value: unknown, fallback: number): number => {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new PeerProtocolError("\"slots\" must be a whole number of at least 1.")
  }
  return Math.min(value, MAX_PEER_SLOTS)
}

const parseUsage = (value: unknown): InferenceUsage | undefined => {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value))
    throw new PeerProtocolError("\"usage\" must be an object.")
  const usage: InferenceUsage = {}
  if (
    typeof value.promptTokens === "number" &&
    Number.isFinite(value.promptTokens)
  )
    usage.promptTokens = value.promptTokens
  if (
    typeof value.completionTokens === "number" &&
    Number.isFinite(value.completionTokens)
  )
    usage.completionTokens = value.completionTokens
  return Object.keys(usage).length ? usage : undefined
}

const parseChunk = (value: unknown): FimChunk | ChatChunk => {
  if (!isRecord(value))
    throw new PeerProtocolError("\"chunk\" must be an object.")
  const usage = parseUsage(value.usage)
  if (typeof value.text === "string")
    return { text: value.text, ...(usage ? { usage } : {}) }
  if (typeof value.content === "string")
    return { content: value.content, ...(usage ? { usage } : {}) }
  throw new PeerProtocolError("\"chunk\" carries neither text nor content.")
}

const parseEmbeddingResponse = (value: unknown): EmbeddingResponse => {
  if (!isRecord(value) || !Array.isArray(value.vectors))
    throw new PeerProtocolError("\"response\" has no vectors.")
  const vectors: number[][] = []
  for (const vector of value.vectors) {
    if (
      !Array.isArray(vector) ||
      !vector.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      throw new PeerProtocolError("\"response\" has a malformed vector.")
    }
    vectors.push(vector as number[])
  }
  const usage = parseUsage(value.usage)
  return { vectors, ...(usage ? { usage } : {}) }
}

/** What the gateway accepts from a sharer. Anything else is a protocol error. */
export const parsePeerFrame = (text: string): PeerToGatewayFrame => {
  const frame = parseJson(text)
  switch (frame.type) {
    case "hello": {
      if (frame.protocol !== PEER_PROTOCOL_VERSION) {
        throw new PeerProtocolError(
          `Peer protocol ${String(frame.protocol)} is not supported; this gateway speaks ${PEER_PROTOCOL_VERSION}.`
        )
      }
      const name = cleanName(frame.name, MAX_NAME_CHARS)
      if (!name) throw new PeerProtocolError("\"name\" must name the machine.")
      const kind = isRecord(frame.backend)
        ? cleanName(frame.backend.kind, MAX_NAME_CHARS)
        : undefined
      if (!kind)
        throw new PeerProtocolError(
          "\"backend.kind\" must name the local server."
        )
      return {
        type: "hello",
        protocol: PEER_PROTOCOL_VERSION,
        name,
        backend: { kind },
        models: parsePeerModels(frame.models),
        slots: parseSlots(frame.slots, DEFAULT_PEER_SLOTS)
      }
    }
    case "models":
      return { type: "models", models: parsePeerModels(frame.models) }
    case "chunk":
      return {
        type: "chunk",
        id: requireId(frame),
        chunk: parseChunk(frame.chunk)
      }
    case "done": {
      const id = requireId(frame)
      const usage = parseUsage(frame.usage)
      const response =
        frame.response === undefined
          ? undefined
          : parseEmbeddingResponse(frame.response)
      return {
        type: "done",
        id,
        ...(usage ? { usage } : {}),
        ...(response ? { response } : {})
      }
    }
    case "error": {
      const id = requireId(frame)
      const error = frame.error
      if (
        !isRecord(error) ||
        !isInferenceErrorKind(error.kind) ||
        typeof error.message !== "string"
      ) {
        throw new PeerProtocolError("An error frame had no error kind.")
      }
      return {
        type: "error",
        id,
        error: {
          kind: error.kind,
          message: error.message.slice(0, MAX_ERROR_MESSAGE_CHARS)
        }
      }
    }
    case "pong":
      return { type: "pong" }
    default:
      throw new PeerProtocolError(
        `Unknown frame type "${String(frame.type).slice(0, 32)}".`
      )
  }
}

/** What a sharer accepts from the gateway. Jobs are re-validated in full. */
export const parseGatewayFrame = (text: string): GatewayToPeerFrame => {
  const frame = parseJson(text)
  switch (frame.type) {
    case "welcome": {
      if (frame.protocol !== PEER_PROTOCOL_VERSION) {
        throw new PeerProtocolError(
          `The gateway speaks peer protocol ${String(frame.protocol)}; this extension speaks ${PEER_PROTOCOL_VERSION}.`
        )
      }
      const wanted = Array.isArray(frame.wanted)
        ? [
            ...new Set(
              frame.wanted
                .map((entry) => cleanName(entry, MAX_MODEL_CHARS))
                .filter((entry): entry is string => !!entry)
            )
          ]
        : []
      return {
        type: "welcome",
        protocol: PEER_PROTOCOL_VERSION,
        wanted,
        slots: parseSlots(frame.slots, DEFAULT_PEER_SLOTS)
      }
    }
    case "job": {
      const id = requireId(frame)
      if (!isInferenceCapability(frame.capability))
        throw new PeerProtocolError("A job named no capability.")
      // `parseRequest` refuses unknown fields, so nothing about this
      // machine's servers can be smuggled in on a job.
      let request: FimRequest | ChatRequest | EmbeddingRequest
      try {
        request = parseRequest(frame.capability, frame.request)
      } catch (error) {
        throw new PeerProtocolError(
          error instanceof Error ? error.message : String(error)
        )
      }
      return { type: "job", id, capability: frame.capability, request }
    }
    case "cancel":
      return { type: "cancel", id: requireId(frame) }
    case "ping":
      return { type: "ping" }
    default:
      throw new PeerProtocolError(
        `Unknown frame type "${String(frame.type).slice(0, 32)}".`
      )
  }
}

export const encodePeerFrame = (
  frame: PeerToGatewayFrame | GatewayToPeerFrame
): string => JSON.stringify(frame)

/** `alice@desktop`: the key that shares and the machine it shares from. */
export const peerLabel = (key: string, machine: string): string =>
  `${key}@${machine}`

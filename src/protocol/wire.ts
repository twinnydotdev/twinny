/**
 * The parts of the protocol both sides agree on without talking: which
 * HTTP status carries which error kind, what a valid request body is, and
 * how a stream line is read.
 */
import { isRecord } from "../common/guards"
import {
  InferenceError,
  InferenceErrorKind,
  isInferenceError
} from "../extension/inference/errors"
import {
  ChatRequest,
  EmbeddingRequest,
  FimRequest,
  InferenceCapability,
  InferenceModel
} from "../extension/inference/types"

import type { RemoteTeam } from "./types"
import {
  REMOTE_PROTOCOL_BASE,
  REMOTE_ROUTE_PATHS,
  REMOTE_ROUTES,
  RemoteBackendStatus,
  RemoteDoneFrame,
  RemoteErrorBody,
  RemoteIdentity,
  RemoteRoute,
  RemoteStatus,
  TeamPolicy
} from "./types"

const KINDS: InferenceErrorKind[] = [
  "provider-unavailable",
  "model-unavailable",
  "unsupported-capability",
  "authentication",
  "rate-limited",
  "timeout",
  "cancelled",
  "inference-failure"
]

export const isInferenceErrorKind = (
  value: unknown
): value is InferenceErrorKind =>
  typeof value === "string" && (KINDS as string[]).includes(value)

const STATUS_FOR_KIND: Record<InferenceErrorKind, number> = {
  "provider-unavailable": 503,
  "model-unavailable": 404,
  "unsupported-capability": 400,
  authentication: 401,
  "rate-limited": 429,
  timeout: 504,
  cancelled: 499,
  "inference-failure": 502
}

export const statusForKind = (kind: InferenceErrorKind): number =>
  STATUS_FOR_KIND[kind]

/** What a status alone says, for a reply whose body is not the protocol's. */
export const kindForStatus = (status: number): InferenceErrorKind => {
  if (status === 401 || status === 403) return "authentication"
  if (status === 404) return "model-unavailable"
  if (status === 429) return "rate-limited"
  if (status === 408 || status === 504) return "timeout"
  if (status >= 500) return "provider-unavailable"
  return "inference-failure"
}

/** How much of an error message travels; the rest is only ever local. */
export const MAX_ERROR_MESSAGE_CHARS = 400

export const toErrorBody = (error: InferenceError): RemoteErrorBody => ({
  error: {
    kind: error.kind,
    message: (error.message || "Unknown error").slice(
      0,
      MAX_ERROR_MESSAGE_CHARS
    )
  }
})

export const isErrorBody = (value: unknown): value is RemoteErrorBody =>
  isRecord(value) &&
  isRecord(value.error) &&
  isInferenceErrorKind(value.error.kind) &&
  typeof value.error.message === "string"

export const isDoneFrame = (value: unknown): value is RemoteDoneFrame =>
  isRecord(value) && value.done === true

/** An `InferenceError` as the other side reported it, status attached. */
export const errorFromBody = (body: RemoteErrorBody, status?: number) =>
  new InferenceError(body.error.kind, body.error.message, { status })

/* -------------------------------------------------------------------------- */
/*  Routing                                                                   */
/* -------------------------------------------------------------------------- */

export interface RemoteRouteMatch {
  route: RemoteRoute
  /** The method the route wants; the request's may differ. */
  method: "GET" | "POST"
}

export const methodForRoute = (route: RemoteRoute): "GET" | "POST" =>
  route === "models" ||
  route === "whoami" ||
  route === "status" ||
  route === "team"
    ? "GET"
    : "POST"

/** The full path of a route below a base such as `/ai` (or nothing). */
export const remoteRoutePath = (route: RemoteRoute, basePath = ""): string =>
  `${basePath}${REMOTE_PROTOCOL_BASE}${REMOTE_ROUTE_PATHS[route]}`

/**
 * Which protocol route a path names, if any. The method is not checked
 * here so a wrong one can be answered with 405 rather than 404.
 */
export const matchRemoteRoute = (
  pathname: string,
  basePath = ""
): RemoteRouteMatch | undefined => {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname
  for (const route of REMOTE_ROUTES) {
    if (clean === remoteRoutePath(route, basePath)) {
      return { route, method: methodForRoute(route) }
    }
  }
  return undefined
}

/* -------------------------------------------------------------------------- */
/*  Request validation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A request the gateway will not run: malformed, oversized, or carrying
 * fields the protocol has no place for. Reported as `inference-failure`
 * with a 4xx status so a client can tell it from a backend problem.
 */
export class RemoteRequestError extends InferenceError {
  constructor(message: string, status = 400) {
    super("inference-failure", `Invalid request: ${message}`, { status })
    this.name = "RemoteRequestError"
  }
}

export const isRemoteRequestError = (
  error: unknown
): error is RemoteRequestError =>
  error instanceof RemoteRequestError ||
  (isInferenceError(error) && error.name === "RemoteRequestError")

const MAX_ALIAS_CHARS = 128

const requireRecord = (body: unknown): Record<string, unknown> => {
  if (!isRecord(body))
    throw new RemoteRequestError("the body must be a JSON object.")
  return body
}

/** Anything not on the allow-list is refused, not dropped: nothing about the server can be smuggled in. */
const rejectUnknownFields = (
  body: Record<string, unknown>,
  allowed: string[]
) => {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key))
  if (unknown.length) {
    throw new RemoteRequestError(
      `unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")}.`
    )
  }
}

const requireModel = (body: Record<string, unknown>): string => {
  const model = body.model
  if (typeof model !== "string" || !model.trim()) {
    throw new RemoteRequestError("\"model\" must name a model alias.")
  }
  if (model.length > MAX_ALIAS_CHARS) {
    throw new RemoteRequestError("\"model\" is too long.")
  }
  return model
}

const optionalString = (
  body: Record<string, unknown>,
  key: string
): string | undefined => {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string")
    throw new RemoteRequestError(`"${key}" must be a string.`)
  return value
}

const optionalNumber = (
  body: Record<string, unknown>,
  key: string
): number | undefined => {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RemoteRequestError(`"${key}" must be a number.`)
  }
  return value
}

const optionalStringList = (
  body: Record<string, unknown>,
  key: string
): string[] | undefined => {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RemoteRequestError(`"${key}" must be a list of strings.`)
  }
  return value as string[]
}

const ROLES = ["system", "user", "assistant", "tool"]

const MAX_TOOLS = 64
const MAX_TOOL_NAME_CHARS = 64
const TOOL_NAME = /^[A-Za-z0-9_-]+$/

/** The calls an assistant turn made, in the OpenAI shape the tool loop writes. */
const parseMessageToolCalls = (value: unknown, index: number) => {
  if (!Array.isArray(value)) {
    throw new RemoteRequestError(`message ${index}: "tool_calls" must be a list.`)
  }
  return value.map((call) => {
    if (!isRecord(call) || !isRecord(call.function)) {
      throw new RemoteRequestError(`message ${index} has a tool call that is not an object.`)
    }
    rejectUnknownFields(call, ["id", "type", "function"])
    rejectUnknownFields(call.function, ["name", "arguments"])
    const { id } = call
    const { name, arguments: args } = call.function
    if (typeof id !== "string" || !id || typeof name !== "string" || !name || typeof args !== "string") {
      throw new RemoteRequestError(`message ${index} has a tool call without an id, a name or arguments.`)
    }
    return { id, type: "function" as const, function: { name, arguments: args } }
  })
}

/**
 * A conversation. `tools` admits what a tool conversation adds (chat
 * only): tool results, and the calls on an assistant's turn.
 */
const parseMessages = (messages: unknown, tools = false): ChatRequest["messages"] => {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new RemoteRequestError("\"messages\" must be a non-empty list.")
  }
  return messages.map((message, index) => {
    if (!isRecord(message)) {
      throw new RemoteRequestError(`message ${index} must be an object.`)
    }
    const { role, content } = message
    if (typeof role !== "string" || !ROLES.includes(role) || (role === "tool" && !tools)) {
      throw new RemoteRequestError(`message ${index} has no valid role.`)
    }
    // What a tool conversation adds, each on the one role that carries it:
    // the calls on the assistant's turn, the call answered on a result.
    rejectUnknownFields(message, [
      "role",
      "content",
      ...(role === "assistant" && tools ? ["tool_calls"] : []),
      ...(role === "tool" ? ["tool_call_id"] : [])
    ])
    if (role === "tool") {
      if (typeof content !== "string") {
        throw new RemoteRequestError(`message ${index} has no content.`)
      }
      if (typeof message.tool_call_id !== "string" || !message.tool_call_id) {
        throw new RemoteRequestError(`message ${index} does not say which tool call it answers.`)
      }
      return { role, content, tool_call_id: message.tool_call_id } as unknown as ChatRequest["messages"][number]
    }
    const calls =
      message.tool_calls === undefined || message.tool_calls === null
        ? undefined
        : parseMessageToolCalls(message.tool_calls, index)
    // A turn that only made calls has nothing to say: its content is null.
    const empty = content === null || content === undefined
    if (calls?.length ? !empty && typeof content !== "string" : typeof content !== "string" && !Array.isArray(content)) {
      throw new RemoteRequestError(`message ${index} has no content.`)
    }
    return {
      role,
      content: empty ? null : content,
      ...(calls?.length ? { tool_calls: calls } : {})
    } as unknown as ChatRequest["messages"][number]
  })
}

/** The tools a request offers: a name, what it does, and a JSON schema for its arguments. */
const parseTools = (value: unknown): ChatRequest["tools"] => {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > MAX_TOOLS) {
    throw new RemoteRequestError(`"tools" must be a list of at most ${MAX_TOOLS} tools.`)
  }
  const tools = value.map((tool, index) => {
    if (!isRecord(tool)) throw new RemoteRequestError(`tool ${index} must be an object.`)
    rejectUnknownFields(tool, ["name", "description", "parameters"])
    const { name, description, parameters } = tool
    if (typeof name !== "string" || !TOOL_NAME.test(name) || name.length > MAX_TOOL_NAME_CHARS) {
      throw new RemoteRequestError(`tool ${index} has no valid name.`)
    }
    if (typeof description !== "string") {
      throw new RemoteRequestError(`tool "${name}" has no description.`)
    }
    if (!isRecord(parameters)) {
      throw new RemoteRequestError(`tool "${name}" has no parameters schema.`)
    }
    return { name, description, parameters }
  })
  return tools.length ? tools : undefined
}

const REASONING_EFFORTS = ["low", "medium", "high"]

export const parseFimRequest = (input: unknown): FimRequest => {
  const body = requireRecord(input)
  rejectUnknownFields(body, [
    "model",
    "prompt",
    "prefix",
    "suffix",
    "stop",
    "maxTokens",
    "temperature",
    "keepAlive",
    "messages"
  ])
  const prompt = body.prompt
  if (typeof prompt !== "string")
    throw new RemoteRequestError("\"prompt\" must be a string.")
  const keepAlive = body.keepAlive
  if (
    keepAlive !== undefined &&
    keepAlive !== null &&
    typeof keepAlive !== "string" &&
    typeof keepAlive !== "number"
  ) {
    throw new RemoteRequestError("\"keepAlive\" must be a string or a number.")
  }
  return {
    model: requireModel(body),
    prompt,
    prefix: optionalString(body, "prefix"),
    suffix: optionalString(body, "suffix"),
    stop: optionalStringList(body, "stop"),
    maxTokens: optionalNumber(body, "maxTokens"),
    temperature: optionalNumber(body, "temperature"),
    keepAlive:
      keepAlive === null
        ? undefined
        : (keepAlive as string | number | undefined),
    // A chat-only FIM model's prompt, as the chat it was rendered from
    // (see `getFimChat`), so the backend does not template it again.
    messages:
      body.messages === undefined || body.messages === null
        ? undefined
        : parseMessages(body.messages)
  }
}

export const parseChatRequest = (input: unknown): ChatRequest => {
  const body = requireRecord(input)
  rejectUnknownFields(body, ["model", "messages", "maxTokens", "temperature", "tools", "think", "reasoningEffort"])
  const { think, reasoningEffort } = body
  if (think !== undefined && think !== null && typeof think !== "boolean") {
    throw new RemoteRequestError("\"think\" must be true or false.")
  }
  if (reasoningEffort !== undefined && reasoningEffort !== null && !REASONING_EFFORTS.includes(reasoningEffort as string)) {
    throw new RemoteRequestError(`"reasoningEffort" must be one of ${REASONING_EFFORTS.join(", ")}.`)
  }
  const tools = parseTools(body.tools)
  return {
    model: requireModel(body),
    messages: parseMessages(body.messages, true),
    maxTokens: optionalNumber(body, "maxTokens"),
    temperature: optionalNumber(body, "temperature"),
    // Left out when absent, so a plain chat reaches the backend as it always did.
    ...(tools ? { tools } : {}),
    ...(typeof think === "boolean" ? { think } : {}),
    ...(typeof reasoningEffort === "string" ? { reasoningEffort: reasoningEffort as ChatRequest["reasoningEffort"] } : {})
  }
}

export const parseEmbeddingRequest = (input: unknown): EmbeddingRequest => {
  const body = requireRecord(input)
  rejectUnknownFields(body, ["model", "input"])
  const value = body.input
  const valid =
    typeof value === "string" ||
    (Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) => typeof item === "string"))
  if (!valid) {
    throw new RemoteRequestError(
      "\"input\" must be a string or a list of strings."
    )
  }
  return { model: requireModel(body), input: value as string | string[] }
}

export const parseRequest = (
  capability: InferenceCapability,
  input: unknown
): FimRequest | ChatRequest | EmbeddingRequest => {
  switch (capability) {
    case "fim":
      return parseFimRequest(input)
    case "chat":
      return parseChatRequest(input)
    case "embeddings":
      return parseEmbeddingRequest(input)
  }
}

/* -------------------------------------------------------------------------- */
/*  Models                                                                    */
/* -------------------------------------------------------------------------- */

const CAPABILITIES: InferenceCapability[] = ["fim", "chat", "embeddings"]

export const isInferenceCapability = (
  value: unknown
): value is InferenceCapability =>
  typeof value === "string" && (CAPABILITIES as string[]).includes(value)

export const parseIdentity = (input: unknown): RemoteIdentity => {
  if (!isRecord(input) || typeof input.key !== "string") {
    throw new InferenceError(
      "inference-failure",
      "The gateway sent no identity."
    )
  }
  return {
    protocol: typeof input.protocol === "number" ? input.protocol : 0,
    key: input.key,
    shared: input.shared === true,
    ...(input.admin === true ? { admin: true } : {})
  }
}

export const parseStatus = (input: unknown): RemoteStatus => {
  if (!isRecord(input) || !Array.isArray(input.backends)) {
    throw new InferenceError("inference-failure", "The gateway sent no status.")
  }
  const backends: RemoteBackendStatus[] = []
  for (const entry of input.backends) {
    if (!isRecord(entry) || typeof entry.provider !== "string") continue
    backends.push({
      provider: entry.provider,
      ok: entry.ok === true,
      ...(isInferenceErrorKind(entry.kind) ? { kind: entry.kind } : {}),
      ms: typeof entry.ms === "number" ? entry.ms : 0,
      ...(typeof entry.peers === "number" ? { peers: entry.peers } : {})
    })
  }
  const models: RemoteStatus["models"] = []
  for (const entry of Array.isArray(input.models) ? input.models : []) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.provider !== "string"
    )
      continue
    models.push({
      id: entry.id,
      provider: entry.provider,
      ok: entry.ok === true
    })
  }
  return {
    protocol: typeof input.protocol === "number" ? input.protocol : 0,
    backends,
    models
  }
}

/** Only what the protocol defines survives the trip; nothing else is trusted. */
export const parseModels = (input: unknown): InferenceModel[] => {
  const models = isRecord(input) ? input.models : undefined
  if (!Array.isArray(models)) return []
  const parsed: InferenceModel[] = []
  for (const entry of models) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) continue
    const capabilities = Array.isArray(entry.capabilities)
      ? entry.capabilities.filter(isInferenceCapability)
      : []
    parsed.push({
      id: entry.id,
      name:
        typeof entry.name === "string" && entry.name ? entry.name : entry.id,
      capabilities,
      ...(typeof entry.contextWindow === "number"
        ? { contextWindow: entry.contextWindow }
        : {}),
      ...(typeof entry.model === "string" && entry.model ? { model: entry.model } : {})
    })
  }
  return parsed
}

export const parseTeam = (input: unknown): RemoteTeam => {
  if (
    !isRecord(input) ||
    input.protocol !== 1 ||
    !isRecord(input.defaults) ||
    !Array.isArray(input.models)
  ) {
    throw new InferenceError(
      "inference-failure",
      "This gateway does not publish compatible team defaults. Ask your admin to update it."
    )
  }
  const models = parseModels(input)
  const defaults: RemoteTeam["defaults"] = {}
  for (const [capability, alias] of Object.entries(input.defaults)) {
    if (
      !isInferenceCapability(capability) ||
      typeof alias !== "string" ||
      !models.some(
        (model) => model.id === alias && model.capabilities.includes(capability)
      )
    ) {
      throw new InferenceError(
        "inference-failure",
        "The gateway published an invalid team default. Ask your admin to check its configuration."
      )
    }
    defaults[capability] = alias
  }
  const team: RemoteTeam = { protocol: 1, defaults, models }
  if (input.policy !== undefined) {
    if (!isRecord(input.policy)) {
      throw new InferenceError(
        "inference-failure",
        "The gateway published an invalid team policy. Ask your admin to check its configuration."
      )
    }
    const policy: TeamPolicy = {}
    if (input.policy.teamOnly !== undefined) {
      if (typeof input.policy.teamOnly !== "boolean") {
        throw new InferenceError(
          "inference-failure",
          "The gateway published an invalid team policy. Ask your admin to check its configuration."
        )
      }
      policy.teamOnly = input.policy.teamOnly
    }
    if (input.policy.lockDefaults !== undefined) {
      if (typeof input.policy.lockDefaults !== "boolean") {
        throw new InferenceError(
          "inference-failure",
          "The gateway published an invalid team policy. Ask your admin to check its configuration."
        )
      }
      policy.lockDefaults = input.policy.lockDefaults
    }
    if (input.policy.recording !== undefined) {
      const routes = input.policy.recording
      if (!Array.isArray(routes) || !routes.every(isInferenceCapability)) {
        throw new InferenceError(
          "inference-failure",
          "The gateway published an invalid team policy. Ask your admin to check its configuration."
        )
      }
      if (routes.length) policy.recording = [...new Set(routes)]
    }
    if (input.policy.peers !== undefined) {
      const aliases = input.policy.peers
      if (!Array.isArray(aliases) || !aliases.every((alias) => typeof alias === "string")) {
        throw new InferenceError(
          "inference-failure",
          "The gateway published an invalid team policy. Ask your admin to check its configuration."
        )
      }
      if (aliases.length) policy.peers = [...new Set(aliases as string[])]
    }
    if (input.policy.systemPrompt !== undefined) {
      if (typeof input.policy.systemPrompt !== "string") {
        throw new InferenceError(
          "inference-failure",
          "The gateway published an invalid team policy. Ask your admin to check its configuration."
        )
      }
      if (input.policy.systemPrompt.trim()) policy.systemPrompt = input.policy.systemPrompt.slice(0, 20_000)
    }
    team.policy = policy
  }
  if (input.sharing !== undefined) {
    if (!isRecord(input.sharing) || !Array.isArray(input.sharing.wanted) || !input.sharing.wanted.every((m) => typeof m === "string")) {
      throw new InferenceError(
        "inference-failure",
        "The gateway published invalid sharing details. Ask your admin to check its configuration."
      )
    }
    team.sharing = { wanted: [...new Set(input.sharing.wanted as string[])] }
  }
  return team
}

/** One stream line, parsed. Blank lines are skipped; junk is a protocol error. */
export const parseFrame = (line: string): unknown | undefined => {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    throw new InferenceError(
      "inference-failure",
      "The gateway sent a line that is not JSON."
    )
  }
}

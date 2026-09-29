/**
 * Finds the model servers already running on this machine and sorts their
 * models into what the gateway needs: something for chat, something for
 * autocomplete (FIM) and something for embeddings.
 *
 * The list of servers to try and the shape of an answer come from the
 * extension (`src/common/provider-discovery.ts`), and each server is asked
 * through the same inference adapter the gateway serves it with, so any
 * backend the extension knows is a backend quickstart can find: Ollama,
 * LM Studio, llama.cpp, Oobabooga, LiteLLM, Open WebUI, QVAC, or any
 * OpenAI-compatible server. Nothing here prefers one over another beyond
 * the extension's own order when several answer.
 */
import { API_PROVIDERS, PROVIDER_DISPLAY_NAMES } from "../common/constants"
import { candidateList, dedupeServers, DiscoveredServer, LocalServerCandidate } from "../common/provider-discovery"
import { getEndpointDefaults } from "../common/provider-validation"
import { TwinnyProvider } from "../common/types"
import { providerRegistry } from "../extension/inference/registry"

export type { DiscoveredServer, LocalServerCandidate }

/**
 * `[kind=]host[:port]` or a URL: `10.0.0.5:1234`, `lmstudio=10.0.0.5`,
 * `llamacpp=http://gpu-box:8080`. Without a kind, the port says which
 * server is usual there; failing that it is an OpenAI-compatible server.
 */
export const parseBackendOption = (value: string, defaultKind?: string): LocalServerCandidate => {
  let kind = defaultKind
  let rest = value.trim()
  const named = /^([a-z][a-z0-9-]*)=(.+)$/i.exec(rest)
  if (named) {
    kind = named[1].toLowerCase()
    rest = named[2]
  }
  let protocol = "http"
  const url = /^(https?):\/\/(.+?)\/*$/i.exec(rest)
  if (url) {
    protocol = url[1].toLowerCase()
    rest = url[2]
  }
  const match = /^(\[[^\]\s]+\]|[^:/\s]+)(?::(\d{1,5}))?$/.exec(rest)
  if (!match) throw new Error(`"${value}" is not a host, host:port or URL.`)
  const host = match[1].replace(/^\[|\]$/g, "")
  const port = match[2] ? Number(match[2]) : undefined
  if (!host || (port !== undefined && (port < 1 || port > 65535))) throw new Error(`"${value}" is not a host, host:port or URL.`)
  if (!kind) kind = port ? kindForPort(port) : API_PROVIDERS.Ollama
  if (!providerRegistry.providerIds().includes(kind)) {
    throw new Error(`"${kind}" is not a provider kind the gateway can serve. Known: ${providerRegistry.providerIds().join(", ")}.`)
  }
  const defaults = getEndpointDefaults(kind, "chat")
  return {
    provider: kind,
    apiHostname: host,
    apiPort: port ?? defaults?.apiPort ?? 80,
    apiProtocol: protocol
  }
}

/** The server that usually listens on a port, from the extension's defaults. */
const kindForPort = (port: number): string => {
  for (const provider of LOCAL_KINDS) {
    if (getEndpointDefaults(provider, "chat")?.apiPort === port) return provider
  }
  return API_PROVIDERS.OpenAICompatible
}

/** Servers people run on their own machine, in the extension's order, plus QVAC. */
const LOCAL_KINDS: string[] = [
  API_PROVIDERS.Ollama,
  API_PROVIDERS.LMStudio,
  API_PROVIDERS.LlamaCpp,
  API_PROVIDERS.Qvac,
  API_PROVIDERS.Oobabooga,
  API_PROVIDERS.LiteLLM,
  API_PROVIDERS.OpenWebUI,
  API_PROVIDERS.OpenAICompatible
]

/** Every usual local address, as the extension tries them on first run. */
export const localCandidates = (): LocalServerCandidate[] => {
  const usual = candidateList()
  const qvac = getEndpointDefaults(API_PROVIDERS.Qvac, "chat")
  if (qvac?.apiHostname && qvac.apiPort && !usual.some((c) => c.apiPort === qvac.apiPort)) {
    usual.splice(3, 0, { provider: API_PROVIDERS.Qvac, apiHostname: qvac.apiHostname, apiPort: qvac.apiPort, apiProtocol: qvac.apiProtocol || "http" })
  }
  return usual
}

export const describeCandidate = (candidate: LocalServerCandidate): string =>
  `${PROVIDER_DISPLAY_NAMES[candidate.provider] || candidate.provider} at ${candidate.apiHostname}:${candidate.apiPort}`

const asChatDraft = (candidate: LocalServerCandidate): TwinnyProvider => ({
  id: "discovery",
  label: describeCandidate(candidate),
  modelName: "",
  type: "chat",
  apiPath: getEndpointDefaults(candidate.provider, "chat")?.apiPath ?? "",
  apiKey: "",
  ...candidate
})

/** One candidate, asked for its models through its adapter; nothing on failure. */
const probe = async (candidate: LocalServerCandidate, timeoutMs: number): Promise<DiscoveredServer | undefined> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const models = await providerRegistry.resolve(asChatDraft(candidate)).models({ signal: controller.signal })
    const names = models.map((m) => m.id).filter((id) => !!id)
    if (!names.length) return undefined
    return { ...candidate, label: PROVIDER_DISPLAY_NAMES[candidate.provider] || candidate.provider, models: names }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

export interface DiscoveryResult {
  servers: DiscoveredServer[]
  ms: number
}

/**
 * Asks every candidate at once; whoever answers with models is in, best
 * first. Never rejects: an empty list is the answer when nothing is running.
 */
export const discoverServers = async (candidates: LocalServerCandidate[], timeoutMs = 3_000): Promise<DiscoveryResult> => {
  const started = Date.now()
  const answers = await Promise.all(candidates.map((candidate) => probe(candidate, timeoutMs)))
  const servers = dedupeServers(answers.filter((server): server is DiscoveredServer => !!server))
  return { servers, ms: Date.now() - started }
}

/* -------------------------------------------------------------------------- */
/*  Ranking                                                                   */
/* -------------------------------------------------------------------------- */

const EMBEDDING = /embed|minilm|bge|e5-|arctic|mxbai|gte-|snowflake|nomic|jina/i
/** Trained on code with fill-in-the-middle tokens. */
const CODE = /coder|codellama|starcoder|codegemma|codestral|deepseek-coder|granite-code|stable-code|codeqwen|code-|-code|:code|yi-coder/i
/** Base or completion-only variants: right for autocomplete, poor at chat. */
const BASE = /[-:]code\b|-base\b|starcoder/i
const INSTRUCT = /instruct|chat|-it\b/i

export type Role = "chat" | "fim" | "embeddings"

const score = (name: string, role: Role): number => {
  const embedding = EMBEDDING.test(name)
  switch (role) {
    case "embeddings":
      return embedding ? 10 : -1
    case "fim":
      if (embedding || !CODE.test(name)) return -1
      return 10 + (BASE.test(name) ? 2 : 0) + (/coder/i.test(name) ? 1 : 0)
    case "chat":
      if (embedding) return -1
      if (BASE.test(name)) return 1
      return 10 + (INSTRUCT.test(name) ? 2 : 0) + (CODE.test(name) ? 1 : 0)
  }
}

/** Models that can do the role, best first. Empty when nothing fits. */
export const candidatesFor = (models: string[], role: Role): string[] =>
  models
    .map((name, index) => ({ name, index, score: score(name, role) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.name)

export interface ModelPick {
  chat?: string
  fim?: string
  embeddings?: string
}

/** The best guess for each role, for a run with nobody at the keyboard. */
export const pickModels = (models: string[]): ModelPick => ({
  chat: candidatesFor(models, "chat")[0],
  fim: candidatesFor(models, "fim")[0],
  embeddings: candidatesFor(models, "embeddings")[0]
})

/** Roughly what the name says, for a hint next to a choice. */
export const describeModel = (name: string): string => {
  if (EMBEDDING.test(name)) return "embeddings"
  if (BASE.test(name)) return "completion only"
  if (CODE.test(name)) return "code"
  return ""
}

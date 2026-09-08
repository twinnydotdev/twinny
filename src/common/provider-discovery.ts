/**
 * Finding a model server that is already running on this machine, and
 * turning it into providers, so a first run works without anyone typing
 * an address.
 *
 * Pure: the network calls live in `src/extension/providers/discovery.ts`.
 * This file decides *where* to look and *what to make* of an answer.
 */
import {
  API_PROVIDERS,
  FIM_TEMPLATE_FORMAT,
  PROVIDER_DISPLAY_NAMES
} from "./constants"
import { pickModelStrict } from "./model-pick"
import {
  getEndpointDefaults,
  PROVIDER_TYPES,
  ProviderType
} from "./provider-validation"
import { TwinnyProvider } from "./types"

/** An address to try, and which server is expected to answer there. */
export interface LocalServerCandidate {
  provider: string
  apiHostname: string
  apiPort: number
  apiProtocol: string
}

/** A candidate that answered with a model list. */
export interface DiscoveredServer extends LocalServerCandidate {
  label: string
  models: string[]
}

/**
 * The servers people run locally, in the order twinny prefers them when
 * more than one answers. Ollama first because it is by far the most
 * common; the OpenAI-compatible catch-all last because its port (8080) is
 * shared with llama.cpp and is claimed by that entry first.
 */
export const LOCAL_SERVER_PROVIDERS: string[] = [
  API_PROVIDERS.Ollama,
  API_PROVIDERS.LMStudio,
  API_PROVIDERS.LlamaCpp,
  API_PROVIDERS.Oobabooga,
  API_PROVIDERS.LiteLLM,
  API_PROVIDERS.OpenWebUI,
  API_PROVIDERS.OpenAICompatible
]

export const DEFAULT_LOCAL_CANDIDATES: LocalServerCandidate[] =
  LOCAL_SERVER_PROVIDERS.flatMap((provider) => {
    const defaults = getEndpointDefaults(provider, "chat")
    if (!defaults?.apiHostname || !defaults.apiPort) return []
    return [
      {
        provider,
        apiHostname: defaults.apiHostname,
        apiPort: defaults.apiPort,
        apiProtocol: defaults.apiProtocol || "http"
      }
    ]
  })

const sameAddress = (a: LocalServerCandidate, b: LocalServerCandidate) =>
  a.apiHostname === b.apiHostname &&
  a.apiPort === b.apiPort &&
  a.apiProtocol === b.apiProtocol

/**
 * Merges extra candidates (a configured Ollama address, say) with the
 * defaults. An extra that shares an address with a default replaces it,
 * keeping the default's position; otherwise it goes first.
 */
export const candidateList = (
  extras: LocalServerCandidate[] = []
): LocalServerCandidate[] => {
  const list = DEFAULT_LOCAL_CANDIDATES.map(
    (candidate) => extras.find((extra) => sameAddress(extra, candidate)) || candidate
  )
  const fresh = extras.filter((extra) => !list.some((c) => sameAddress(c, extra)))
  return [...fresh, ...list]
}

/**
 * Two candidates can share a port (llama.cpp and the generic entry both
 * default to 8080). When both "answer", it is the same server twice: keep
 * the first by preference.
 */
export const dedupeServers = (servers: DiscoveredServer[]): DiscoveredServer[] =>
  servers.filter(
    (server, index) => servers.findIndex((s) => sameAddress(s, server)) === index
  )

export const describeServer = (server: DiscoveredServer) =>
  `${server.label} at ${server.apiHostname}:${server.apiPort}`

/**
 * The providers a found server can back, one per job it has a suitable
 * model for. A job without one is left out on purpose: twinny then shows
 * it as unset rather than pointing autocomplete at a chat model that will
 * babble, or embeddings at a model that has no vectors.
 */
export const providersForServer = (
  server: DiscoveredServer,
  makeId: () => string
): TwinnyProvider[] => {
  const providers: TwinnyProvider[] = []
  for (const type of PROVIDER_TYPES) {
    const modelName = pickModelStrict(server.models, type)
    if (!modelName) continue
    const endpoint = getEndpointDefaults(server.provider, type)
    providers.push({
      id: makeId(),
      label: labelFor(server, type),
      modelName,
      provider: server.provider,
      type,
      apiHostname: server.apiHostname,
      apiPort: server.apiPort,
      apiProtocol: server.apiProtocol,
      apiPath: endpoint?.apiPath ?? "",
      apiKey: "",
      ...(type === "fim" ? { fimTemplate: FIM_TEMPLATE_FORMAT.automatic } : {})
    })
  }
  return providers
}

const labelFor = (server: DiscoveredServer, type: ProviderType) => {
  const name = PROVIDER_DISPLAY_NAMES[server.provider] || server.provider
  return type === "chat" ? name : `${name} ${type.toUpperCase()}`
}

/**
 * Looks for a model server already running on this machine.
 *
 * Every usual address (Ollama, LM Studio, llama.cpp, Oobabooga, LiteLLM,
 * Open WebUI, and any OpenAI-compatible server on 8080) is asked for its
 * model list at once; whichever answer is what twinny sets itself up with.
 */
import { v4 as uuidv4 } from "uuid"
import { workspace } from "vscode"

import { API_PROVIDERS, PROVIDER_DISPLAY_NAMES } from "../../common/constants"
import { logger } from "../../common/logger"
import {
  candidateList,
  dedupeServers,
  DiscoveredServer,
  LocalServerCandidate,
  providersForServer
} from "../../common/provider-discovery"
import { TwinnyProvider } from "../../common/types"

import { listProviderModels } from "./probe"
import { ProviderStore } from "./store"

/**
 * The Ollama address from settings. Usually the default, in which case it
 * just replaces the built-in Ollama candidate; a custom port gets tried in
 * addition to the usual one.
 */
const configuredOllama = (): LocalServerCandidate => {
  const config = workspace.getConfiguration("twinny")
  const hostname = config.get<string>("ollamaHostname") || "localhost"
  return {
    provider: API_PROVIDERS.Ollama,
    // 0.0.0.0 is where Ollama *listens*; it is not an address to call.
    apiHostname: hostname === "0.0.0.0" ? "localhost" : hostname,
    apiPort: config.get<number>("ollamaApiPort") || 11434,
    apiProtocol: config.get<boolean>("ollamaUseTls") ? "https" : "http"
  }
}

const asChatDraft = (candidate: LocalServerCandidate): TwinnyProvider => ({
  id: "",
  label: "",
  modelName: "",
  type: "chat",
  apiPath: "",
  apiKey: "",
  ...candidate
})

const probe = async (
  candidate: LocalServerCandidate
): Promise<DiscoveredServer | undefined> => {
  const { models } = await listProviderModels(asChatDraft(candidate))
  if (models.length === 0) return undefined
  return {
    ...candidate,
    label: PROVIDER_DISPLAY_NAMES[candidate.provider] || candidate.provider,
    models
  }
}

/** Every server that answered, best first. Never rejects. */
export const discoverLocalServers = async (
  extras: LocalServerCandidate[] = [configuredOllama()]
): Promise<DiscoveredServer[]> => {
  const candidates = candidateList(extras)
  const results = await Promise.all(
    candidates.map((candidate) => probe(candidate).catch(() => undefined))
  )
  const found = dedupeServers(
    results.filter((server): server is DiscoveredServer => !!server)
  )
  logger.log(
    found.length
      ? `Found local model servers: ${found
          .map((s) => `${s.label} (${s.models.length} models)`)
          .join(", ")}`
      : "No local model server answered."
  )
  return found
}

/**
 * Creates providers for a found server and makes them active for any job
 * that has none. Returns what was created.
 */
export const applyDiscoveredServer = async (
  store: ProviderStore,
  server: DiscoveredServer
): Promise<TwinnyProvider[]> => {
  const providers = providersForServer(server, uuidv4)
  if (providers.length) await store.addAll(providers)
  return providers
}

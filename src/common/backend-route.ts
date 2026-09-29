/**
 * A backend address plus a model and a job, as the inference layer wants
 * it: one `TwinnyProvider`. The gateway builds these from its
 * configuration; a sharing extension builds them for the local server it
 * shares. Pure: no vscode.
 */
import { getEndpointDefaults, ProviderType } from "./provider-validation"
import { TwinnyProvider } from "./types"

export type BackendCapability = "fim" | "chat" | "embeddings"

/** Where a backend listens; anything unset falls back to the adapter's usual address. */
export interface BackendEndpoint {
  /** The adapter kind: `ollama`, `lmstudio`, `openai-compatible`… */
  provider: string
  apiHostname?: string
  apiPort?: number
  apiProtocol?: string
  /** The route for each job; the adapter's usual route when unset. */
  paths?: Partial<Record<BackendCapability, string>>
}

export const TYPE_FOR_CAPABILITY: Record<BackendCapability, ProviderType> = {
  fim: "fim",
  chat: "chat",
  embeddings: "embedding"
}

export interface BackendRouteOptions {
  id: string
  label: string
  apiKey?: string
}

/**
 * The provider an adapter is given for one model and job: the backend's
 * address, the route for the job (configured, or the adapter's usual
 * one), the backend model, and the key when there is one.
 */
export const providerForBackend = (
  backend: BackendEndpoint,
  model: string,
  capability: BackendCapability,
  options: BackendRouteOptions
): TwinnyProvider => {
  const type = TYPE_FOR_CAPABILITY[capability]
  const defaults = getEndpointDefaults(backend.provider, type) || {}
  return {
    id: options.id,
    label: options.label,
    modelName: model,
    provider: backend.provider,
    type,
    apiHostname: backend.apiHostname ?? defaults.apiHostname,
    apiPort: backend.apiPort ?? defaults.apiPort,
    apiProtocol: backend.apiProtocol ?? defaults.apiProtocol ?? "http",
    apiPath: backend.paths?.[capability] ?? defaults.apiPath ?? "",
    apiKey: options.apiKey ?? ""
  }
}

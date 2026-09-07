/**
 * Everything twinny knows about what makes a provider configuration valid,
 * and how to tidy one up before it is saved.
 *
 * Pure: no vscode or React imports, so it runs identically in the webview
 * form (for inline feedback) and in the extension (as the guard on save and
 * import), and is unit tested directly.
 */
import {
  API_PROVIDERS,
  FIM_TEMPLATE_FORMAT,
  OPEN_AI_COMPATIBLE_PROVIDERS
} from "./constants"
import { TwinnyProvider } from "./types"

export type ProviderType = "chat" | "fim" | "embedding"

export const PROVIDER_TYPES: ProviderType[] = ["chat", "fim", "embedding"]

/**
 * APIs twinny talks to through fluency.js. They have a fixed public endpoint,
 * so for chat the hostname, port and path fields do not apply.
 */
export const HOSTED_PROVIDERS: string[] = [
  API_PROVIDERS.Anthropic,
  API_PROVIDERS.OpenAI,
  API_PROVIDERS.Mistral,
  API_PROVIDERS.Groq,
  API_PROVIDERS.OpenRouter,
  API_PROVIDERS.Cohere,
  API_PROVIDERS.Perplexity,
  API_PROVIDERS.Gemini
]

/** Providers that will reject a request without a key. */
const KEY_REQUIRED_PROVIDERS: string[] = [
  ...HOSTED_PROVIDERS,
  API_PROVIDERS.Deepseek
]

/** Hosted APIs that offer no completions endpoint twinny can drive for FIM. */
const CHAT_ONLY_PROVIDERS: string[] = [
  API_PROVIDERS.Anthropic,
  API_PROVIDERS.Groq,
  API_PROVIDERS.Cohere,
  API_PROVIDERS.Perplexity,
  API_PROVIDERS.Gemini
]

export const isHostedProvider = (provider: string) =>
  HOSTED_PROVIDERS.includes(provider)

export const isOpenAICompatibleProvider = (provider: string) =>
  (Object.values(OPEN_AI_COMPATIBLE_PROVIDERS) as string[]).includes(provider)

/**
 * A paired device. Requests still go to an address (the extension's local
 * gateway), but the person never types one: the address is decided at
 * request time from the device id, so the endpoint fields do not apply.
 */
export const isP2pProvider = (provider: string) =>
  provider === API_PROVIDERS.TwinnyP2P

/**
 * Whether the hostname / port / path fields matter for this provider + type.
 * Chat with a hosted API goes through fluency.js and ignores them; everything
 * else is a raw HTTP request to the address the user gives.
 */
export const usesEndpoint = (provider: string, type: string) =>
  type !== "chat" || !isHostedProvider(provider)

/** Whether the person configures the hostname / port / path themselves. */
export const hasConfigurableEndpoint = (provider: string, type: string) =>
  usesEndpoint(provider, type) && !isP2pProvider(provider)

export const expectsApiKey = (provider: string) =>
  KEY_REQUIRED_PROVIDERS.includes(provider)

export const supportsType = (provider: string, type: string) =>
  type === "chat" || !CHAT_ONLY_PROVIDERS.includes(provider)

export interface EndpointDefaults {
  apiHostname?: string
  apiPort?: number
  apiProtocol?: string
  apiPath?: string
}

/**
 * Where each server usually listens and which route serves each job. The
 * chat path is the OpenAI-style *base* (fluency.js appends
 * `/chat/completions`); FIM and embedding paths are the full route.
 */
const ENDPOINT_DEFAULTS: Record<
  string,
  Partial<Record<ProviderType, EndpointDefaults>>
> = {
  [API_PROVIDERS.Ollama]: {
    chat: { apiHostname: "localhost", apiPort: 11434, apiPath: "/v1" },
    fim: { apiHostname: "localhost", apiPort: 11434, apiPath: "/api/generate" },
    embedding: { apiHostname: "localhost", apiPort: 11434, apiPath: "/api/embed" }
  },
  [API_PROVIDERS.LMStudio]: {
    chat: { apiHostname: "localhost", apiPort: 1234, apiPath: "/v1" },
    fim: { apiHostname: "localhost", apiPort: 1234, apiPath: "/v1/completions" },
    embedding: { apiHostname: "localhost", apiPort: 1234, apiPath: "/v1/embeddings" }
  },
  [API_PROVIDERS.LlamaCpp]: {
    chat: { apiHostname: "localhost", apiPort: 8080, apiPath: "/v1" },
    fim: { apiHostname: "localhost", apiPort: 8080, apiPath: "/completion" },
    embedding: { apiHostname: "localhost", apiPort: 8080, apiPath: "/embedding" }
  },
  [API_PROVIDERS.Oobabooga]: {
    chat: { apiHostname: "localhost", apiPort: 5000, apiPath: "/v1" },
    fim: { apiHostname: "localhost", apiPort: 5000, apiPath: "/v1/completions" },
    embedding: { apiHostname: "localhost", apiPort: 5000, apiPath: "/v1/embeddings" }
  },
  [API_PROVIDERS.LiteLLM]: {
    chat: { apiHostname: "localhost", apiPort: 4000, apiPath: "/v1" },
    fim: { apiHostname: "localhost", apiPort: 4000, apiPath: "/v1/chat/completions" },
    embedding: { apiHostname: "localhost", apiPort: 4000, apiPath: "/v1/embeddings" }
  },
  [API_PROVIDERS.OpenWebUI]: {
    chat: { apiHostname: "localhost", apiPort: 3000, apiPath: "/api" },
    fim: { apiHostname: "localhost", apiPort: 3000, apiPath: "/ollama/api/generate" },
    embedding: { apiHostname: "localhost", apiPort: 3000, apiPath: "/ollama/api/embed" }
  },
  [API_PROVIDERS.OpenAICompatible]: {
    chat: { apiHostname: "localhost", apiPort: 8080, apiPath: "/v1" },
    fim: { apiHostname: "localhost", apiPort: 8080, apiPath: "/v1/completions" },
    embedding: { apiHostname: "localhost", apiPort: 8080, apiPath: "/v1/embeddings" }
  },
  [API_PROVIDERS.Deepseek]: {
    chat: { apiHostname: "api.deepseek.com", apiProtocol: "https", apiPath: "/v1" },
    fim: { apiHostname: "api.deepseek.com", apiProtocol: "https", apiPath: "/beta/completions" }
  },
  [API_PROVIDERS.OpenRouter]: {
    fim: { apiHostname: "openrouter.ai", apiProtocol: "https", apiPath: "/api/v1/completions" }
  },
  [API_PROVIDERS.Mistral]: {
    fim: { apiHostname: "api.mistral.ai", apiProtocol: "https", apiPath: "/v1/fim/completions" }
  },
  [API_PROVIDERS.OpenAI]: {
    embedding: { apiHostname: "api.openai.com", apiProtocol: "https", apiPath: "/v1/embeddings" }
  }
}

export const getEndpointDefaults = (
  provider: string,
  type: string
): EndpointDefaults | undefined =>
  ENDPOINT_DEFAULTS[provider]?.[type as ProviderType]

/* -------------------------------------------------------------------------- */
/*  Normalisation                                                             */
/* -------------------------------------------------------------------------- */

const trim = (value: unknown) =>
  typeof value === "string" ? value.trim() : ""

/** Junk stays NaN rather than vanishing, so validation can point at it. */
const parsePort = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined
  return Number(String(value).trim())
}

const ensureLeadingSlash = (path: string) =>
  path && !path.startsWith("/") ? `/${path}` : path

const stripTrailingSlash = (path: string) =>
  path.length > 1 ? path.replace(/\/+$/, "") : path

/**
 * People paste whole URLs into the hostname box. Rather than reject that,
 * take it apart: `https://my-box:8080/v1` fills the protocol, port and path.
 */
const splitPastedUrl = (hostname: string) => {
  const match = /^(?:(https?):\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/i.exec(hostname)
  if (!match) return { hostname }
  const [, protocol, host, port, path] = match
  return {
    hostname: host,
    protocol: protocol?.toLowerCase(),
    port: port ? Number(port) : undefined,
    path: path ? stripTrailingSlash(path) : undefined
  }
}

/**
 * Cleans a provider up for saving: trims, coerces the port to a number,
 * unpicks a pasted URL, fixes the path shape, and drops fields that only
 * make sense for another type. Never throws; `validateProvider` reports what
 * is still wrong afterwards.
 */
export const normalizeProvider = (input: TwinnyProvider): TwinnyProvider => {
  const type = (
    PROVIDER_TYPES.includes(trim(input.type) as ProviderType)
      ? trim(input.type)
      : "chat"
  ) as ProviderType
  const providerName = trim(input.provider) || API_PROVIDERS.Ollama

  const pasted = splitPastedUrl(trim(input.apiHostname))
  const hostname = pasted.hostname.toLowerCase()
  const port = pasted.port ?? parsePort(input.apiPort)
  const protocol = (pasted.protocol || trim(input.apiProtocol) || "http")
    .toLowerCase()
    .replace(/:$/, "")

  let path = stripTrailingSlash(ensureLeadingSlash(trim(input.apiPath)))
  if (!path && pasted.path) path = pasted.path
  // fluency.js adds the route itself; a user following older docs will
  // have included it, which then 404s.
  if (type === "chat" && isOpenAICompatibleProvider(providerName)) {
    path = path.replace(/\/chat\/completions$/i, "")
  }

  const normalized: TwinnyProvider = {
    id: trim(input.id),
    label: trim(input.label),
    modelName: trim(input.modelName),
    provider: providerName,
    type,
    apiHostname: hostname,
    apiPort: port,
    apiProtocol: protocol === "https" ? "https" : "http",
    apiPath: path,
    apiKey: trim(input.apiKey)
  }

  if (type === "fim") {
    normalized.fimTemplate =
      trim(input.fimTemplate) || FIM_TEMPLATE_FORMAT.automatic
    if (input.repositoryLevel) normalized.repositoryLevel = true
  }

  if (isP2pProvider(providerName)) {
    normalized.deviceId = trim(input.deviceId).toLowerCase()
    // The gateway address is filled in per request; nothing typed here
    // should survive, or it would be shown as if it mattered.
    normalized.apiHostname = ""
    normalized.apiPort = undefined
    normalized.apiPath = ""
    normalized.apiKey = ""
  }

  return normalized
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

export type ProviderField = keyof TwinnyProvider

export interface ProviderValidation {
  /** Field -> message. Empty when the provider can be saved. */
  errors: Partial<Record<ProviderField, string>>
  /** Things that will probably not work but are allowed. */
  warnings: string[]
  valid: boolean
}

const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i
const IPV6_PATTERN = /^\[?[0-9a-f:]+\]?$/i

const isValidHostname = (hostname: string) =>
  HOSTNAME_PATTERN.test(hostname) || IPV6_PATTERN.test(hostname)

/**
 * Judges a provider as it is; run `normalizeProvider` first when checking
 * something that came from a form so trivial whitespace is not an error.
 */
export const validateProvider = (
  provider: TwinnyProvider
): ProviderValidation => {
  const errors: ProviderValidation["errors"] = {}
  const warnings: string[] = []
  const { type, provider: providerName } = provider
  const knownProviders = Object.values(API_PROVIDERS) as string[]

  if (!provider.label) errors.label = "Give the provider a name."
  if (!provider.modelName) errors.modelName = "Enter the model to use."

  if (!PROVIDER_TYPES.includes(type as ProviderType)) {
    errors.type = "Type must be chat, fim or embedding."
  }

  if (!knownProviders.includes(providerName)) {
    errors.provider = `Unknown provider "${providerName}".`
  } else if (!supportsType(providerName, type)) {
    errors.provider = `${providerName} only supports chat in twinny. For ${type} use a local server, OpenRouter, DeepSeek or Mistral.`
  }

  if (
    type === "fim" &&
    provider.fimTemplate &&
    !(Object.values(FIM_TEMPLATE_FORMAT) as string[]).includes(provider.fimTemplate)
  ) {
    errors.fimTemplate = `Unknown FIM template "${provider.fimTemplate}".`
  }

  if (isP2pProvider(providerName) && !/^[0-9a-f]{64}$/.test(provider.deviceId || "")) {
    errors.deviceId = "Pair a device first, then create the provider from its card."
  }

  if (hasConfigurableEndpoint(providerName, type)) {
    const hostname = provider.apiHostname || ""
    if (!hostname) {
      errors.apiHostname = "Enter the hostname of the server."
    } else if (/:\/\//.test(hostname) || hostname.includes("/")) {
      errors.apiHostname = "Enter just the host, e.g. localhost — not a URL."
    } else if (!isValidHostname(hostname)) {
      errors.apiHostname = `"${hostname}" is not a valid hostname.`
    }

    if (provider.apiPort !== undefined) {
      const port = Number(provider.apiPort)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        errors.apiPort = "Port must be a whole number between 1 and 65535."
      }
    }

    if (provider.apiProtocol && !/^https?$/.test(provider.apiProtocol)) {
      errors.apiProtocol = "Protocol must be http or https."
    }

    const path = provider.apiPath || ""
    if (path && !path.startsWith("/")) {
      errors.apiPath = "The API path must start with /."
    } else if (/\s/.test(path)) {
      errors.apiPath = "The API path must not contain spaces."
    }

    if (
      type === "chat" &&
      isOpenAICompatibleProvider(providerName) &&
      /\/chat\/completions$/i.test(path)
    ) {
      warnings.push(
        "twinny appends /chat/completions itself; the path will be shortened to the API base when saved."
      )
    }

    if (type !== "chat" && !path) {
      const suggested = getEndpointDefaults(providerName, type)?.apiPath
      warnings.push(
        suggested
          ? `No API path set. ${providerName} usually serves ${type} at ${suggested}.`
          : "No API path set; the request will go to the server root."
      )
    }

    if (
      type === "chat" &&
      providerName === API_PROVIDERS.Ollama &&
      /\/api\/(generate|chat)$/.test(path)
    ) {
      warnings.push(
        "Chat uses Ollama's OpenAI-compatible API. The path is normally /v1, not /api/generate."
      )
    }
    if (
      type === "fim" &&
      providerName === API_PROVIDERS.Ollama &&
      /^\/v1\/?$/.test(path)
    ) {
      warnings.push(
        "FIM against Ollama normally uses /api/generate; /v1 is the chat base."
      )
    }
  }

  if (expectsApiKey(providerName) && !provider.apiKey) {
    warnings.push(
      `${providerName} needs an API key. Leave it blank only if the key is set in your environment.`
    )
  }

  return { errors, warnings, valid: Object.keys(errors).length === 0 }
}

/* -------------------------------------------------------------------------- */
/*  Presentation helpers                                                      */
/* -------------------------------------------------------------------------- */

/** The base address, without the route: `http://localhost:11434`. */
export const getProviderOrigin = (provider: TwinnyProvider) => {
  if (!provider.apiHostname) return ""
  const protocol = provider.apiProtocol || "http"
  const port = provider.apiPort ? `:${provider.apiPort}` : ""
  return `${protocol}://${provider.apiHostname}${port}`
}

/**
 * The URL a request will actually hit, for showing the user. Empty for a
 * hosted chat provider, which has no configurable address.
 */
export const describeProviderEndpoint = (provider: TwinnyProvider) => {
  if (!hasConfigurableEndpoint(provider.provider, provider.type)) return ""
  const origin = getProviderOrigin(provider)
  if (!origin) return ""
  const path = provider.apiPath || ""
  const route =
    provider.type === "chat" && isOpenAICompatibleProvider(provider.provider)
      ? `${path}/chat/completions`
      : path
  return `${origin}${route}`
}

/** A one-line human summary: `codellama:7b-code · localhost:11434`. */
export const summarizeProvider = (provider: TwinnyProvider) => {
  const where = isP2pProvider(provider.provider)
    ? "P2P device"
    : usesEndpoint(provider.provider, provider.type)
      ? `${provider.apiHostname || "?"}${provider.apiPort ? `:${provider.apiPort}` : ""}`
      : provider.provider
  return [provider.modelName || "no model", where].join(" · ")
}

/** Import files are user-supplied; only keep entries that are providers. */
export const isProviderLike = (value: unknown): value is TwinnyProvider => {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.label === "string" &&
    typeof candidate.modelName === "string" &&
    typeof candidate.provider === "string" &&
    typeof candidate.type === "string"
  )
}

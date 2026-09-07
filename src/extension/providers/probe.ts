/**
 * Live checks against a provider: "does this configuration actually answer?"
 * and "which models does it serve?".
 *
 * Nothing here touches the editor (the one vscode import is transitive via
 * `utils`, which a script can stub), so it can be driven from node against a
 * local server. Every function resolves — failures come back as a result,
 * never as a rejection — because the caller is a UI that wants to show the
 * reason, not a stack trace.
 */
import { models as hostedCatalogue, TokenJS } from "fluency.js"
import { CompletionNonStreaming, LLMProvider } from "fluency.js/dist/chat"

import { API_PROVIDERS, OPEN_AI_COMPATIBLE_PROVIDERS } from "../../common/constants"
import {
  ProviderModelList,
  ProviderTestResult
} from "../../common/messaging/protocol"
import {
  getProviderOrigin,
  isHostedProvider,
  isOpenAICompatibleProvider,
  usesEndpoint
} from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"
import { createStreamRequestBodyFim } from "../completion/request-body"
import { getFimDataFromProvider } from "../utils"

import { describeProviderErrorPlain } from "./errors"

const PROBE_TIMEOUT_MS = 20_000
const LIST_TIMEOUT_MS = 6_000

const FIM_PROBE_PROMPT = "def add(a, b):\n    return"
const EMBED_PROBE_INPUT = "hello"

interface HttpFailure extends Error {
  status?: number
}

const withTimeout = (ms: number) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, done: () => clearTimeout(timer) }
}

const authHeaders = (provider: TwinnyProvider): Record<string, string> => ({
  "Content-Type": "application/json",
  ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
})

const httpError = async (response: Response): Promise<HttpFailure> => {
  let detail = ""
  try {
    detail = (await response.text()).slice(0, 300)
  } catch {
    // The status alone is enough.
  }
  const error: HttpFailure = new Error(
    `${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`
  )
  error.status = response.status
  return error
}

const endpointUrl = (provider: TwinnyProvider) =>
  `${getProviderOrigin(provider)}${provider.apiPath || ""}`

/* -------------------------------------------------------------------------- */
/*  Testing                                                                   */
/* -------------------------------------------------------------------------- */

const fluencyProvider = (provider: TwinnyProvider): LLMProvider =>
  (isOpenAICompatibleProvider(provider.provider)
    ? OPEN_AI_COMPATIBLE_PROVIDERS.OpenAICompatible
    : provider.provider) as LLMProvider

const testChat = async (provider: TwinnyProvider): Promise<string> => {
  const tokenJs = new TokenJS({
    baseURL: isOpenAICompatibleProvider(provider.provider)
      ? endpointUrl(provider)
      : undefined,
    apiKey: provider.apiKey || undefined
  })
  const body: CompletionNonStreaming<LLMProvider> = {
    messages: [{ role: "user", content: "Say hi." }],
    model: provider.modelName,
    provider: fluencyProvider(provider),
    max_tokens: 8
  }
  const response = await tokenJs.chat.completions.create(body)
  return response.choices?.[0]?.message?.content?.toString() || ""
}

/**
 * Sends the same shaped request the completion provider will send and reads
 * the first streamed chunk. Whether a real token came back is what tells the
 * user their model and template are wired up, not just that the port is open.
 */
const testFim = async (provider: TwinnyProvider): Promise<string> => {
  const body = createStreamRequestBodyFim(provider.provider, FIM_PROBE_PROMPT, {
    model: provider.modelName,
    numPredictFim: 8,
    temperature: 0
  })
  const { signal, done } = withTimeout(PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(endpointUrl(provider), {
      method: "POST",
      headers: authHeaders(provider),
      body: JSON.stringify(body),
      signal
    })
    if (!response.ok) throw await httpError(response)
    if (!response.body) return ""

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let text = ""
    let sample = ""
    // A few reads is plenty to see a token; the stream is then cancelled so
    // the server does not keep generating for a probe.
    for (let i = 0; i < 6 && !sample; i++) {
      const { value, done: finished } = await reader.read()
      if (finished) break
      text += value
      for (const line of text.split("\n")) {
        const payload = line.replace(/^data:\s*/, "").trim()
        if (!payload || payload === "[DONE]") continue
        try {
          const token = getFimDataFromProvider(
            provider.provider,
            JSON.parse(payload)
          )
          if (token) {
            sample = token
            break
          }
        } catch {
          // A partial line; keep reading.
        }
      }
    }
    await reader.cancel().catch(() => undefined)
    return sample
  } finally {
    done()
  }
}

const findVector = (value: unknown, depth = 0): number[] | undefined => {
  if (depth > 4 || value === null || typeof value !== "object") return undefined
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((n) => typeof n === "number")) {
      return value as number[]
    }
    for (const item of value) {
      const found = findVector(item, depth + 1)
      if (found) return found
    }
    return undefined
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    const found = findVector(item, depth + 1)
    if (found) return found
  }
  return undefined
}

const testEmbedding = async (provider: TwinnyProvider): Promise<string> => {
  const { signal, done } = withTimeout(PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(endpointUrl(provider), {
      method: "POST",
      headers: authHeaders(provider),
      body: JSON.stringify({
        model: provider.modelName,
        input: EMBED_PROBE_INPUT,
        stream: false
      }),
      signal
    })
    if (!response.ok) throw await httpError(response)
    const vector = findVector(await response.json())
    if (!vector) {
      throw new Error("The server answered but returned no embedding vector.")
    }
    return `${vector.length} dimensions`
  } finally {
    done()
  }
}

export const testProvider = async (
  provider: TwinnyProvider
): Promise<ProviderTestResult> => {
  const started = Date.now()
  try {
    let sample: string
    switch (provider.type) {
      case "fim":
        sample = await testFim(provider)
        break
      case "embedding":
        sample = await testEmbedding(provider)
        break
      default:
        sample = await testChat(provider)
    }
    return {
      success: true,
      latencyMs: Date.now() - started,
      sample: sample.trim().slice(0, 60)
    }
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serverMessage = (error as any)?.response?.data?.error?.message
    return {
      success: false,
      latencyMs: Date.now() - started,
      error: describeProviderErrorPlain(
        typeof serverMessage === "string" ? new Error(serverMessage) : error,
        provider
      )
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Listing models                                                            */
/* -------------------------------------------------------------------------- */

interface ListRoute {
  path: string
  parse: (json: unknown) => string[]
}

const names = (items: unknown, key: string): string[] =>
  Array.isArray(items)
    ? items
        .map((item) => (item as Record<string, unknown>)?.[key])
        .filter((name): name is string => typeof name === "string")
    : []

const OLLAMA_TAGS: ListRoute = {
  path: "/api/tags",
  parse: (json) => names((json as { models?: unknown })?.models, "name")
}
const OPENAI_MODELS: ListRoute = {
  path: "/v1/models",
  parse: (json) => names((json as { data?: unknown })?.data, "id")
}
const OPENWEBUI_OLLAMA_TAGS: ListRoute = {
  path: "/ollama/api/tags",
  parse: OLLAMA_TAGS.parse
}
const OPENWEBUI_MODELS: ListRoute = {
  path: "/api/models",
  parse: OPENAI_MODELS.parse
}

/** Which listing routes to try, most likely first. */
const listRoutesFor = (provider: string): ListRoute[] => {
  switch (provider) {
    case API_PROVIDERS.Ollama:
      return [OLLAMA_TAGS, OPENAI_MODELS]
    case API_PROVIDERS.OpenWebUI:
      return [OPENWEBUI_MODELS, OPENWEBUI_OLLAMA_TAGS, OPENAI_MODELS]
    default:
      return [OPENAI_MODELS, OLLAMA_TAGS]
  }
}

const fetchList = async (
  provider: TwinnyProvider,
  route: ListRoute
): Promise<string[]> => {
  const { signal, done } = withTimeout(LIST_TIMEOUT_MS)
  try {
    const response = await fetch(`${getProviderOrigin(provider)}${route.path}`, {
      headers: authHeaders(provider),
      signal
    })
    if (!response.ok) throw await httpError(response)
    return route.parse(await response.json())
  } finally {
    done()
  }
}

const hostedModels = (provider: string): string[] => {
  // The catalogue types `models` as a tuple per provider, or `true` for the
  // open-ended ones (OpenRouter); only the tuples are listable.
  const entry = (
    hostedCatalogue as unknown as Record<string, { models?: unknown }>
  )[provider]
  return Array.isArray(entry?.models)
    ? entry.models.filter((m): m is string => typeof m === "string")
    : []
}

/**
 * Asks the server what it has. Every candidate route is tried at once and
 * the first (by preference) that answers with a list wins, so an Ollama
 * behind a proxy that only speaks `/v1/models` still gets a dropdown.
 */
export const listProviderModels = async (
  provider: TwinnyProvider
): Promise<ProviderModelList> => {
  if (!usesEndpoint(provider.provider, provider.type)) {
    return { models: hostedModels(provider.provider) }
  }
  if (!provider.apiHostname) {
    return { models: [], error: "No hostname set." }
  }

  const routes = listRoutesFor(provider.provider)
  const attempts = await Promise.allSettled(
    routes.map((route) => fetchList(provider, route))
  )
  for (const attempt of attempts) {
    if (attempt.status === "fulfilled" && attempt.value.length > 0) {
      return { models: [...new Set(attempt.value)].sort() }
    }
  }

  const firstFailure = attempts.find(
    (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected"
  )
  const models = isHostedProvider(provider.provider)
    ? hostedModels(provider.provider)
    : []
  return {
    models,
    error: firstFailure
      ? describeProviderErrorPlain(firstFailure.reason, provider)
      : "The server did not list any models."
  }
}

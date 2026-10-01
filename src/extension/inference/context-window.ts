/**
 * How many tokens the model behind a provider can hold, as far as its
 * server will say.
 *
 * A local server decides this when it loads the model, and it is often
 * far less than the model was trained for (Ollama loads 4k to 32k unless
 * told otherwise), so the only honest source is the server itself: Ollama's
 * list of loaded models, llama.cpp's properties, LM Studio's model list, a
 * gateway's own listing. A hosted API does not say and is not asked.
 *
 * Asking is cheap but not free, so an answer is kept for a short while. A
 * server that does not know yet (Ollama before the model's first request)
 * is asked again the next time.
 */
import { API_PROVIDERS } from "../../common/constants"
import { deadline } from "../../common/deadline"
import { getProviderOrigin, HOSTED_PROVIDERS } from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"

import { providerRegistry } from "./registry"

const KEEP_MS = 30_000
const RETRY_UNKNOWN_MS = 3000
const ASK_TIMEOUT_MS = 1500

/** What a hosted model is taken to hold when nothing says: every current one holds at least this. */
const HOSTED_ASSUMED_TOKENS = 128_000
/** What a local server is taken to hold when it will not say. */
const LOCAL_ASSUMED_TOKENS = 32_768

interface Known {
  tokens?: number
  at: number
}

const known = new Map<string, Known>()

const keyOf = (provider: TwinnyProvider) =>
  [provider.provider, provider.apiHostname ?? "", provider.apiPort ?? "", provider.modelName].join("|")

const originOf = (provider: TwinnyProvider) =>
  getProviderOrigin({ ...provider, apiHostname: provider.apiHostname || "localhost" })

const ask = async (provider: TwinnyProvider, url: string, body?: unknown): Promise<unknown> => {
  const { signal, done } = deadline(ASK_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal
    })
    return response.ok ? await response.json() : undefined
  } catch {
    return undefined
  } finally {
    done()
  }
}

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined

/** `llama3` and `llama3:latest` are one model to Ollama. */
const sameOllamaModel = (a: string, b: string) => {
  const tagged = (name: string) => (name.includes(":") ? name : `${name}:latest`)
  return tagged(a) === tagged(b)
}

/**
 * Ollama: the context the model is loaded with; before it is loaded, the
 * `num_ctx` its Modelfile sets, if any. Otherwise Ollama picks when it
 * loads, and there is nothing to know yet.
 */
const fromOllama = async (provider: TwinnyProvider): Promise<number | undefined> => {
  const origin = originOf(provider)
  const loaded = (await ask(provider, `${origin}/api/ps`)) as
    | { models?: { name?: string; model?: string; context_length?: unknown }[] }
    | undefined
  const running = loaded?.models?.find(
    (model) =>
      sameOllamaModel(model.name ?? "", provider.modelName) || sameOllamaModel(model.model ?? "", provider.modelName)
  )
  const now = positive(running?.context_length)
  if (now) return now
  const shown = (await ask(provider, `${origin}/api/show`, { model: provider.modelName })) as
    | { parameters?: unknown }
    | undefined
  const set = typeof shown?.parameters === "string" ? /^\s*num_ctx\s+(\d+)/m.exec(shown.parameters) : null
  return set ? positive(Number(set[1])) : undefined
}

const fromLlamaCpp = async (provider: TwinnyProvider): Promise<number | undefined> => {
  const props = (await ask(provider, `${originOf(provider)}/props`)) as
    | { default_generation_settings?: { n_ctx?: unknown } }
    | undefined
  return positive(props?.default_generation_settings?.n_ctx)
}

const fromLmStudio = async (provider: TwinnyProvider): Promise<number | undefined> => {
  const listing = (await ask(provider, `${originOf(provider)}/api/v0/models`)) as
    | { data?: { id?: string; loaded_context_length?: unknown }[] }
    | undefined
  return positive(listing?.data?.find((model) => model.id === provider.modelName)?.loaded_context_length)
}

/** A gateway lists each model's context when its admin set one. */
const fromListing = async (provider: TwinnyProvider): Promise<number | undefined> => {
  try {
    const models = await providerRegistry.resolve(provider).models()
    return positive(models.find((model) => model.id === provider.modelName)?.contextWindow)
  } catch {
    return undefined
  }
}

const detect = (provider: TwinnyProvider): Promise<number | undefined> => {
  switch (provider.provider) {
    case API_PROVIDERS.Ollama:
      return fromOllama(provider)
    case API_PROVIDERS.LlamaCpp:
      return fromLlamaCpp(provider)
    case API_PROVIDERS.LMStudio:
      return fromLmStudio(provider)
    case API_PROVIDERS.TwinnyRemote:
      return fromListing(provider)
    default:
      return Promise.resolve(undefined)
  }
}

/** The model's context in tokens, when its server says. */
export const contextWindowOf = async (provider: TwinnyProvider): Promise<number | undefined> => {
  const key = keyOf(provider)
  const cached = known.get(key)
  const age = cached ? Date.now() - cached.at : Infinity
  if (cached && age < (cached.tokens ? KEEP_MS : RETRY_UNKNOWN_MS)) return cached.tokens
  const tokens = await detect(provider)
  known.set(key, { tokens, at: Date.now() })
  return tokens
}

/** The last answer for this provider, without asking again: for showing next to a reply. */
export const knownContextWindow = (provider: TwinnyProvider): number | undefined =>
  known.get(keyOf(provider))?.tokens

/** What to plan for when the server will not say. */
export const assumedContextWindow = (provider: TwinnyProvider): number =>
  HOSTED_PROVIDERS.includes(provider.provider) ? HOSTED_ASSUMED_TOKENS : LOCAL_ASSUMED_TOKENS

/** For tests: forget every answer. */
export const forgetContextWindows = () => known.clear()

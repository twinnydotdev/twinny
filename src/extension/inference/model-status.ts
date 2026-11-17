/**
 * Where the chat model runs and what state its server has it in, asked
 * without loading anything: Ollama's list of running models, LM Studio's
 * model list, llama.cpp's properties. A hosted API, a gateway and a peer
 * are not asked; they are always ready as far as the chat can tell.
 */
import { API_PROVIDERS } from "../../common/constants"
import type { ModelPlace, ModelStatus } from "../../common/model-status"
import { HOSTED_PROVIDERS } from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"

import { ask, contextWindowOf, originOf, sameOllamaModel } from "./context-window"
import { LOOPBACK } from "./shield"

export const placeOf = (provider: TwinnyProvider): ModelPlace => {
  if (HOSTED_PROVIDERS.includes(provider.provider) || provider.provider === API_PROVIDERS.ChatGPTPlan) return "hosted"
  if (provider.provider === API_PROVIDERS.TwinnyRemote) return "gateway"
  if (provider.provider === API_PROVIDERS.TwinnyP2P) return "peer"
  return LOOPBACK.test((provider.apiHostname || "localhost").trim()) ? "machine" : "network"
}

const keyOf = (provider: TwinnyProvider) =>
  [provider.provider, provider.apiHostname ?? "", provider.apiPort ?? "", provider.modelName].join("|")

const loadTimes = new Map<string, number>()

/** twinny loaded this model and it took this long; said next to it from then on. */
export const rememberLoad = (provider: TwinnyProvider, ms: number) => loadTimes.set(keyOf(provider), ms)

interface Loaded {
  loaded?: boolean
  gpuShare?: number
}

const share = (part: unknown, whole: unknown): number | undefined =>
  typeof part === "number" && typeof whole === "number" && whole > 0
    ? Math.min(1, Math.max(0, part / whole))
    : undefined

const ollamaLoaded = async (provider: TwinnyProvider): Promise<Loaded> => {
  const running = (await ask(provider, `${originOf(provider)}/api/ps`)) as
    | { models?: { name?: string; model?: string; size?: unknown; size_vram?: unknown }[] }
    | undefined
  if (!running?.models) return {}
  const mine = running.models.find(
    (model) =>
      sameOllamaModel(model.name ?? "", provider.modelName) || sameOllamaModel(model.model ?? "", provider.modelName)
  )
  return mine ? { loaded: true, gpuShare: share(mine.size_vram, mine.size) } : { loaded: false }
}

const lmStudioLoaded = async (provider: TwinnyProvider): Promise<Loaded> => {
  const listing = (await ask(provider, `${originOf(provider)}/api/v0/models`)) as
    | { data?: { id?: string; state?: unknown }[] }
    | undefined
  const mine = listing?.data?.find((model) => model.id === provider.modelName)
  return typeof mine?.state === "string" ? { loaded: mine.state === "loaded" } : {}
}

const loadedOf = (provider: TwinnyProvider): Promise<Loaded> => {
  switch (provider.provider) {
    case API_PROVIDERS.Ollama:
      return ollamaLoaded(provider)
    case API_PROVIDERS.LMStudio:
      return lmStudioLoaded(provider)
    default:
      return Promise.resolve({})
  }
}

export const modelStatusOf = async (provider: TwinnyProvider, canLoad: boolean): Promise<ModelStatus> => {
  const place = placeOf(provider)
  const local = place === "machine" || place === "network"
  const [loaded, contextWindow] = await Promise.all([
    local ? loadedOf(provider) : Promise.resolve<Loaded>({}),
    contextWindowOf(provider)
  ])
  const loadMs = loadTimes.get(keyOf(provider))
  return {
    place,
    ...(place === "network" ? { host: (provider.apiHostname || "").trim() } : {}),
    ...(loaded.loaded === undefined ? {} : { loaded: loaded.loaded }),
    ...(loaded.loaded === false && canLoad ? { canLoad: true } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(loaded.gpuShare === undefined ? {} : { gpuShare: loaded.gpuShare }),
    ...(loadMs === undefined ? {} : { loadMs })
  }
}

/** Native Mistral model discovery, independent of fluency's model catalogue. */
import { API_PROVIDERS } from "../../../common/constants"
import { deadline } from "../../../common/deadline"
import { TwinnyProvider } from "../../../common/types"
import { InferenceCapability, InferenceModel, InferenceOptions } from "../types"

import { hostedModels } from "./fluency"
import { responseError } from "./json-stream"

export const MISTRAL_BASE_URL = "https://api.mistral.ai/v1"
const LIST_TIMEOUT_MS = 6_000

/** Keep the native SDK's environment fallback without borrowing another key. */
export const mistralApiKey = (config: TwinnyProvider): string | undefined =>
  config.apiKey || process.env.MISTRAL_API_KEY || undefined

const throwIfCancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Model listing cancelled.", "AbortError")
}

const modelsFromResponse = (json: unknown, type: string): InferenceModel[] => {
  const data = (json as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) throw new Error("Mistral returned an invalid model list: expected a data array.")
  const found = new Map<string, InferenceModel>()
  for (const item of data) {
    if (!item || typeof item !== "object") continue
    const { id, capabilities: advertised, max_context_length: contextWindow } = item as {
      id?: unknown
      capabilities?: { completion_chat?: unknown; completion_fim?: unknown }
      max_context_length?: unknown
    }
    if (typeof id !== "string" || !id || found.has(id)) continue
    const capabilities: InferenceCapability[] = []
    if (advertised?.completion_chat === true) capabilities.push("chat")
    if (advertised?.completion_fim === true) capabilities.push("fim")
    if (!capabilities.some((capability) => capability === type)) continue
    found.set(id, {
      id,
      name: id,
      capabilities,
      ...(typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
        ? { contextWindow }
        : {})
    })
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * A missing key or temporarily unavailable service leaves the offline chat
 * catalogue available. Its entries never restrict manually supplied IDs.
 * Authentication/other client errors, malformed replies and caller aborts
 * are reported; a successful empty account list remains empty. FIM has no
 * verified offline catalogue, so only the service can advertise FIM models.
 */
export const mistralModels = async (
  config: TwinnyProvider,
  options?: InferenceOptions
): Promise<InferenceModel[]> => {
  const outer = options?.signal
  throwIfCancelled(outer)
  const offline = () => hostedModels(API_PROVIDERS.Mistral)
    .filter((model) => model.capabilities.some((capability) => capability === config.type))
  const apiKey = mistralApiKey(config)
  if (!apiKey) return offline()
  const { signal, done } = deadline(LIST_TIMEOUT_MS, { parent: outer })
  let response: Response | undefined
  try {
    response = await fetch(`${MISTRAL_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal
    })
    throwIfCancelled(outer)
    if (response.status >= 500 && response.status <= 599) {
      await response.body?.cancel().catch(() => undefined)
      throwIfCancelled(outer)
      return offline()
    }
    if (!response.ok) throw await responseError(response)
    const json: unknown = await response.json()
    throwIfCancelled(outer)
    return modelsFromResponse(json, config.type)
  } catch (error) {
    throwIfCancelled(outer)
    // Native fetch reports transport errors as TypeError. A malformed JSON
    // body (SyntaxError) or an HTTP client error must remain visible.
    if ((!response || response.ok) && (signal.aborted || error instanceof TypeError)) return offline()
    throw error
  } finally {
    done()
  }
}

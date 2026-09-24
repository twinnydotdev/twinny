/**
 * Requesty's model list. The router has a fixed address, so the list cannot
 * come from the endpoint fields the way a local server's does.
 * `/v1/models/managed` holds the curated routing policies (short ids such as
 * `claude-sonnet-4-5`) and goes first; the full `vendor/model` catalogue from
 * `/v1/models` follows. Either route answering is enough. The managed list is
 * public, so a wrong key still gets a dropdown; with a good key the catalogue
 * is narrowed to what the organisation has approved, and the Test button is
 * what reports a bad key.
 */
import { TwinnyProvider } from "../../../common/types"
import { InferenceModel, InferenceOptions } from "../types"

import { withTimeout } from "./http"
import { responseError } from "./json-stream"

const REQUESTY_ORIGIN = "https://router.requesty.ai"
const LIST_TIMEOUT_MS = 6_000

/** Requesty lists chat and embedding models together; `api` tells them apart. */
const chatModelIds = (json: unknown): string[] => {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  return data
    .filter((item) => (item as { api?: unknown })?.api === "chat")
    .map((item) => (item as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === "string")
}

const fetchIds = async (
  config: TwinnyProvider,
  path: string,
  outer?: AbortSignal
): Promise<string[]> => {
  const { signal, done } = withTimeout(LIST_TIMEOUT_MS, outer)
  try {
    const response = await fetch(`${REQUESTY_ORIGIN}${path}`, {
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
      },
      signal
    })
    if (!response.ok) throw await responseError(response)
    return chatModelIds(await response.json())
  } finally {
    done()
  }
}

export const requestyModels = async (
  config: TwinnyProvider,
  options?: InferenceOptions
): Promise<InferenceModel[]> => {
  const attempts = await Promise.allSettled([
    fetchIds(config, "/v1/models/managed", options?.signal),
    fetchIds(config, "/v1/models", options?.signal)
  ])
  const listed = (attempt: PromiseSettledResult<string[]>) =>
    attempt.status === "fulfilled" ? [...attempt.value].sort() : []
  const ids = [...new Set(attempts.flatMap(listed))]
  if (ids.length > 0) {
    return ids.map((id) => ({ id, name: id, capabilities: ["chat"] }))
  }
  const failure = attempts.find(
    (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected"
  )
  if (failure) throw failure.reason
  return []
}

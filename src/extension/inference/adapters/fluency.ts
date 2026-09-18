/**
 * Chat through fluency.js, which speaks to the hosted APIs (Anthropic,
 * OpenAI, Gemini…) with their own SDKs and to any OpenAI-compatible server
 * through a base URL. `HostedInferenceProvider` uses this for the hosted
 * kinds and `HttpInferenceProvider` for local servers.
 */
import { models as catalogue, TokenJS } from "fluency.js"
import {
  CompletionNonStreaming,
  CompletionStreaming,
  LLMProvider
} from "fluency.js/dist/chat"

import { API_PROVIDERS } from "../../../common/constants"
import { isOpenAICompatibleProvider } from "../../../common/provider-validation"
import { TwinnyProvider } from "../../../common/types"
import {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  InferenceModel,
  InferenceOptions
} from "../types"

import { StreamResponse, usageFromResponse } from "./fim-dialects"
import { logRequest } from "./json-stream"

/** fluency.js routes every local server through its OpenAI-compatible client. */
export const getFluencyProvider = (provider: TwinnyProvider): LLMProvider =>
  (isOpenAICompatibleProvider(provider.provider)
    ? API_PROVIDERS.OpenAICompatible
    : provider.provider) as LLMProvider

/** Some hosted models refuse `stream: true`; the catalogue says which. */
export const supportsStreaming = (provider: TwinnyProvider): boolean => {
  const entry = catalogue[provider.provider as keyof typeof catalogue]
  const streaming = entry?.supportsStreaming
  return Array.isArray(streaming) ? streaming.includes(provider.modelName) : true
}

/** Only real API parameters: OpenAI rejects unknown ones such as an `id`. */
const requestParameters = (request: Pick<ChatRequest, "maxTokens" | "temperature">) => ({
  ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
  ...(request.temperature !== undefined ? { temperature: request.temperature } : {})
})

/**
 * Everything here is forwarded to the provider as-is, so it must carry only
 * real API parameters.
 */
export const buildStreamingRequest = (
  provider: TwinnyProvider,
  messages: ChatMessage[],
  parameters: Pick<ChatRequest, "maxTokens" | "temperature"> = {}
): CompletionStreaming<LLMProvider> => ({
  messages,
  model: provider.modelName,
  stream: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: getFluencyProvider(provider) as any,
  ...requestParameters(parameters)
})

export const buildBlockingRequest = (
  provider: TwinnyProvider,
  messages: ChatMessage[],
  parameters: Pick<ChatRequest, "maxTokens" | "temperature"> = {}
): CompletionNonStreaming<LLMProvider> => ({
  messages: messages.filter((m) => m.role !== "system"),
  model: provider.modelName,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: getFluencyProvider(provider) as any,
  ...requestParameters(parameters)
})

/**
 * One chat request as a stream of text, whether or not the model streams.
 * The signal is watched between chunks; the layer's `abortable` wrapper
 * ends the wait on a chunk that never comes.
 */
export async function* fluencyChat(
  client: TokenJS,
  config: TwinnyProvider,
  request: ChatRequest,
  options?: InferenceOptions
): AsyncGenerator<ChatChunk> {
  const messages = request.messages
  if (supportsStreaming(config)) {
    const body = buildStreamingRequest(config, messages, request)
    logRequest(`${config.provider}/chat.completions (stream)`, body)
    const parts = await client.chat.completions.create(body)
    for await (const part of parts) {
      if (options?.signal?.aborted) break
      const delta = part.choices[0]?.delta?.content
      const usage = usageFromResponse(part as unknown as { usage?: StreamResponse["usage"] })
      if (usage) yield { content: delta || "", usage }
      else if (delta) yield { content: delta }
    }
    return
  }
  const body = buildBlockingRequest(config, messages, request)
  logRequest(`${config.provider}/chat.completions`, body)
  const result = await client.chat.completions.create(body)
  const content = result.choices[0]?.message?.content
  const usage = usageFromResponse(result as unknown as { usage?: StreamResponse["usage"] })
  if (usage) yield { content: content || "", usage }
  else if (content) yield { content }
}

/** What fluency.js knows a hosted API serves, for the model dropdown. */
export const hostedModels = (providerId: string): InferenceModel[] => {
  // The catalogue types `models` as a tuple per provider, or `true` for the
  // open-ended ones (OpenRouter); only the tuples are listable.
  const entry = (
    catalogue as unknown as Record<string, { models?: unknown }>
  )[providerId]
  const names = Array.isArray(entry?.models)
    ? entry.models.filter((m): m is string => typeof m === "string")
    : []
  return names.map((name) => ({ id: name, name, capabilities: ["chat"] }))
}

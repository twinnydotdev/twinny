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

/**
 * A message whose content is only text parts, as a plain string. The
 * extension builds every message as parts (text, plus images when attached);
 * the SDKs accept that for images, but Mistral rejects a parts list for
 * plain text, and a string is what every provider expects for it anyway.
 * Messages with images keep their parts.
 */
export const flattenTextContent = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map((message) => {
    const content = message.content as unknown
    if (!Array.isArray(content) || !content.length) return message
    const parts = content as Array<{ type?: string; text?: string }>
    if (!parts.every((part) => part && part.type === "text" && typeof part.text === "string")) return message
    return { ...message, content: parts.map((part) => part.text).join("\n") } as ChatMessage
  })

type ChatParameters = Pick<ChatRequest, "maxTokens" | "temperature" | "think">

/**
 * Only real API parameters: OpenAI rejects unknown ones such as an `id`.
 * `think: false` goes to Ollama only, which takes it on its OpenAI-style
 * route too; other servers would refuse an unknown field.
 */
const requestParameters = (provider: TwinnyProvider, request: ChatParameters) => ({
  ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
  ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  ...(request.think === false && provider.provider === API_PROVIDERS.Ollama ? { think: false } : {})
})

/** The thinking a reasoning model streams beside its answer, under whichever name the server uses. */
const reasoningOf = (delta: unknown): string | undefined => {
  if (!delta || typeof delta !== "object") return undefined
  const part = delta as { reasoning?: unknown; reasoning_content?: unknown; thinking?: unknown }
  const text = part.reasoning ?? part.reasoning_content ?? part.thinking
  return typeof text === "string" && text ? text : undefined
}

/**
 * Everything here is forwarded to the provider as-is, so it must carry only
 * real API parameters.
 */
export const buildStreamingRequest = (
  provider: TwinnyProvider,
  messages: ChatMessage[],
  parameters: ChatParameters = {}
): CompletionStreaming<LLMProvider> => ({
  messages: flattenTextContent(messages),
  model: provider.modelName,
  stream: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: getFluencyProvider(provider) as any,
  ...requestParameters(provider, parameters)
})

export const buildBlockingRequest = (
  provider: TwinnyProvider,
  messages: ChatMessage[],
  parameters: ChatParameters = {}
): CompletionNonStreaming<LLMProvider> => ({
  messages: flattenTextContent(messages.filter((m) => m.role !== "system")),
  model: provider.modelName,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: getFluencyProvider(provider) as any,
  ...requestParameters(provider, parameters)
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
      const reasoning = reasoningOf(part.choices[0]?.delta)
      const usage = usageFromResponse(part as unknown as { usage?: StreamResponse["usage"] })
      if (usage) yield { content: delta || "", usage, ...(reasoning ? { reasoning } : {}) }
      else if (delta) yield { content: delta }
      else if (reasoning) yield { content: "", reasoning }
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

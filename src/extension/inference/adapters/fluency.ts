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
  ChatFinishReason,
  ChatMessage,
  ChatRequest,
  ChatToolCall,
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

type ChatParameters = Pick<ChatRequest, "maxTokens" | "temperature" | "think" | "tools" | "reasoningEffort">

/**
 * Only real API parameters: OpenAI rejects unknown ones such as an `id`.
 * `think: false` is sent as OpenAI's own `reasoning_effort: "none"`, which
 * Ollama's OpenAI-style route honours (it ignores a `think` field there,
 * checked against 0.33). Only Ollama gets it for now: OpenAI refuses
 * `none` for models that do not reason, and other servers vary.
 */
const requestParameters = (provider: TwinnyProvider, request: ChatParameters) => ({
  ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
  ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  ...(request.think === false && provider.provider === API_PROVIDERS.Ollama ? { reasoning_effort: "none" as const } : {}),
  ...(request.reasoningEffort && provider.provider === API_PROVIDERS.OpenAI
    ? { reasoning_effort: request.reasoningEffort }
    : {}),
  ...(request.tools?.length
    ? {
        tools: request.tools.map((tool) => ({
          type: "function" as const,
          function: { name: tool.name, description: tool.description, parameters: tool.parameters }
        }))
      }
    : {})
})

type ToolCallDelta = {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

/**
 * Streamed tool calls arrive in pieces keyed by `index`: the id and name
 * once, the arguments as fragments (Ollama sends each call whole; llama.cpp,
 * vLLM and LM Studio split them).
 */
const toolCallCollector = () => {
  const calls: { id: string; name: string; arguments: string }[] = []
  return {
    add(deltas: unknown) {
      if (!Array.isArray(deltas)) return
      for (const delta of deltas as ToolCallDelta[]) {
        const index = delta.index ?? calls.length
        const call = (calls[index] ??= { id: "", name: "", arguments: "" })
        if (delta.id) call.id = delta.id
        if (delta.function?.name) call.name += delta.function.name
        if (delta.function?.arguments) call.arguments += delta.function.arguments
      }
    },
    take(): ChatToolCall[] | undefined {
      const done = calls
        .filter((call) => call?.name)
        .map((call, i) => ({ ...call, id: call.id || `call_${i}` }))
      calls.length = 0
      return done.length ? done : undefined
    }
  }
}

/** The end of an answer, in the generic terms; a server that says nothing leaves it undefined. */
const finishReasonOf = (reason: unknown): ChatFinishReason | undefined =>
  reason === "length" ? "length" : typeof reason === "string" && reason ? "stop" : undefined

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
 * Whether fluency.js passes tools to this kind of hosted provider: it
 * lists tool-capable models for it, or takes tools for any model
 * (OpenRouter). Models it does not list yet are tried as well; the tool
 * loop falls back to text when one refuses.
 */
export const hostedTakesTools = (providerKind: string): boolean => {
  const entry = catalogue[providerKind as keyof typeof catalogue] as
    | { supportsToolCalls?: boolean | readonly string[] }
    | undefined
  const tools = entry?.supportsToolCalls
  return tools === true || (Array.isArray(tools) && tools.length > 0)
}

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
    const toolCalls = toolCallCollector()
    for await (const part of parts) {
      if (options?.signal?.aborted) break
      const delta = part.choices[0]?.delta?.content
      toolCalls.add((part.choices[0]?.delta as { tool_calls?: unknown } | undefined)?.tool_calls)
      const reasoning = reasoningOf(part.choices[0]?.delta)
      const usage = usageFromResponse(part as unknown as { usage?: StreamResponse["usage"] })
      const finishReason = finishReasonOf(part.choices[0]?.finish_reason)
      const calls = finishReason ? toolCalls.take() : undefined
      const extras = {
        ...(reasoning ? { reasoning } : {}),
        ...(finishReason ? { finishReason } : {}),
        ...(calls ? { toolCalls: calls } : {})
      }
      if (usage) yield { content: delta || "", usage, ...extras }
      else if (delta) yield { content: delta, ...extras }
      else if (reasoning || finishReason) yield { content: "", ...extras }
    }
    // A server that ends the stream without a finish reason still made its calls.
    const unfinished = toolCalls.take()
    if (unfinished) yield { content: "", toolCalls: unfinished }
    return
  }
  const body = buildBlockingRequest(config, messages, request)
  logRequest(`${config.provider}/chat.completions`, body)
  const result = await client.chat.completions.create(body)
  const content = result.choices[0]?.message?.content
  const usage = usageFromResponse(result as unknown as { usage?: StreamResponse["usage"] })
  const finishReason = finishReasonOf(result.choices[0]?.finish_reason)
  const toolCalls = toolCallCollector()
  toolCalls.add(
    ((result.choices[0]?.message as { tool_calls?: ToolCallDelta[] } | undefined)?.tool_calls ?? [])
      .map((call, index) => ({ ...call, index }))
  )
  const calls = toolCalls.take()
  const extras = { ...(finishReason ? { finishReason } : {}), ...(calls ? { toolCalls: calls } : {}) }
  if (usage) yield { content: content || "", usage, ...extras }
  else if (content || finishReason || calls) yield { content: content || "", ...extras }
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

/**
 * The completion request and streamed chunk as each server family shapes
 * them. This is the only place a provider name decides a wire format.
 */
import { API_PROVIDERS, USER } from "../../../common/constants"
import { ChatMessage, InferenceUsage } from "../types"

/** OpenAI's completions API rejects more than four stop sequences. */
const MAX_HOSTED_STOP_SEQUENCES = 4

export interface RequestBodyBase {
  stream: boolean
  n_predict?: number
  temperature?: number
  messages?: ChatMessage[]
  stop?: string[]
}

export interface RequestOptionsOllama extends RequestBodyBase {
  model: string
  keep_alive?: string | number
  prompt?: string
  input?: string
  options: Record<string, unknown>
}

export interface StreamBodyOpenAI extends RequestBodyBase {
  max_tokens?: number
}

export type FimRequestBody = RequestBodyBase | RequestOptionsOllama | StreamBodyOpenAI

/** One streamed line, in whichever dialect the server speaks. */
export interface StreamResponse {
  model: string
  created_at: string
  response: string
  content: string
  message: {
    content: string
    role: "assistant"
  }
  done: boolean
  context: number[]
  total_duration: number
  load_duration: number
  prompt_eval_count: number
  prompt_eval_duration: number
  eval_count: number
  eval_duration: number
  type?: string
  system_fingerprint: string
  choices: [
    {
      text: string
      delta: {
        content: string
      }
      index: number
      message: {
        role: "assistant"
        content: string
      }
      finish_reason: "stop"
    }
  ]
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
  /** llama.cpp `/completion` counts. */
  tokens_evaluated?: number
  tokens_predicted?: number
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

/**
 * Token counts a streamed line carries, in whichever dialect: Ollama puts
 * them on its final line, OpenAI-style servers in `usage`, llama.cpp in
 * `tokens_*`. Nothing is estimated; a line without counts gives nothing.
 */
export const usageFromResponse = (
  data: Partial<StreamResponse> | undefined
): InferenceUsage | undefined => {
  if (!data) return undefined
  const promptTokens =
    count(data.usage?.prompt_tokens) ?? count(data.prompt_eval_count) ?? count(data.tokens_evaluated)
  const completionTokens =
    count(data.usage?.completion_tokens) ?? count(data.eval_count) ?? count(data.tokens_predicted)
  if (promptTokens === undefined && completionTokens === undefined) return undefined
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {})
  }
}

export interface FimRequestOptions {
  temperature?: number
  numPredictFim: number
  model: string
  keepAlive?: string | number
  stop?: string[]
}

export function createStreamRequestBodyFim(
  provider: string,
  prompt: string,
  options: FimRequestOptions
): FimRequestBody {
  const stop = options.stop?.length ? options.stop : undefined
  // Ollama and llama.cpp treat -1 as "no limit"; OpenAI-style APIs reject it.
  const maxTokens = options.numPredictFim > 0 ? options.numPredictFim : undefined

  switch (provider) {
    case API_PROVIDERS.OpenAICompatible:
    case API_PROVIDERS.OpenWebUI:
    case API_PROVIDERS.Ollama:
    case API_PROVIDERS.TwinnyP2P:
      return {
        model: options.model,
        prompt,
        stream: true,
        keep_alive: options.keepAlive === "-1" ? -1 : options.keepAlive,
        options: {
          temperature: options.temperature,
          num_predict: options.numPredictFim,
          ...(stop ? { stop } : {})
        }
      }
    case API_PROVIDERS.LMStudio:
      return {
        model: options.model,
        prompt,
        stream: true,
        temperature: options.temperature,
        max_tokens: maxTokens,
        stop
      }
    case API_PROVIDERS.Deepseek:
    case API_PROVIDERS.OpenRouter:
      return {
        model: options.model,
        prompt,
        stream: true,
        temperature: options.temperature,
        max_tokens: maxTokens,
        stop: stop?.slice(0, MAX_HOSTED_STOP_SEQUENCES)
      }
    case API_PROVIDERS.LlamaCpp:
    case API_PROVIDERS.Oobabooga:
      return {
        prompt,
        stream: true,
        temperature: options.temperature,
        max_tokens: maxTokens,
        stop
      }
    case API_PROVIDERS.LiteLLM:
      return {
        messages: [{ content: prompt, role: USER }],
        model: options.model,
        stream: true,
        max_tokens: maxTokens,
        temperature: options.temperature,
        stop: stop?.slice(0, MAX_HOSTED_STOP_SEQUENCES)
      }
    default:
      return {
        prompt,
        stream: true,
        temperature: options.temperature,
        n_predict: options.numPredictFim,
        stop
      }
  }
}

/**
 * Pulls the streamed text out of a chunk. Providers are checked for their
 * native shape first, then every known shape is tried so a misconfigured
 * provider type still works as long as the server speaks a common dialect.
 */
export const getFimDataFromProvider = (
  provider: string,
  data: StreamResponse | undefined
): string | undefined => {
  if (!data) return undefined

  switch (provider) {
    case API_PROVIDERS.OpenAICompatible:
    case API_PROVIDERS.Ollama:
    case API_PROVIDERS.OpenWebUI:
    case API_PROVIDERS.TwinnyP2P:
      if (typeof data.response === "string") return data.response
      break
    case API_PROVIDERS.LlamaCpp:
      if (typeof data.content === "string") return data.content
      break
  }

  const choice = data.choices?.[0]
  if (typeof choice?.text === "string") return choice.text
  if (typeof choice?.delta?.content === "string") return choice.delta.content
  if (typeof choice?.message?.content === "string") return choice.message.content
  if (typeof data.response === "string") return data.response
  if (typeof data.content === "string") return data.content
  return undefined
}

interface EmbeddingResponseBody {
  /** OpenAI-style `usage`, Ollama's `prompt_eval_count`. */
  usage?: { prompt_tokens?: number }
  prompt_eval_count?: number
  /** OpenAI, LM Studio, vLLM, llama.cpp `/v1/embeddings`. */
  data?: Array<{ index?: number; embedding: number[] }>
  /** Ollama `/api/embed`. */
  embeddings?: number[][]
  /** llama.cpp `/embedding` and the legacy Ollama route. */
  embedding?: number[]
}

/** Every vector in a response, in input order, whatever the server's dialect. */
export const vectorsFromResponse = (body: EmbeddingResponseBody): number[][] => {
  if (Array.isArray(body.data)) {
    return [...body.data]
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((item) => item.embedding)
      .filter(Array.isArray)
  }
  if (Array.isArray(body.embeddings)) return body.embeddings.filter(Array.isArray)
  if (Array.isArray(body.embedding)) return [body.embedding]
  return []
}

/** The prompt tokens an embedding reply reports, if any. */
export const usageFromEmbeddingResponse = (
  body: EmbeddingResponseBody
): InferenceUsage | undefined => {
  const promptTokens = count(body.usage?.prompt_tokens) ?? count(body.prompt_eval_count)
  return promptTokens === undefined ? undefined : { promptTokens }
}

/**
 * The contract between twinny's features and whatever serves their models.
 *
 * A feature asks for a capability ("stream me a completion for this prompt",
 * "embed these texts") and an adapter behind `InferenceProvider` turns that
 * into what its server or SDK wants. Nothing above this layer knows a route,
 * a request body or a response shape, so a new backend is a new adapter and
 * nothing else.
 */
import { ChatCompletionMessage } from "../../common/types"

export type InferenceCapability = "fim" | "chat" | "embeddings"

export const INFERENCE_CAPABILITIES: InferenceCapability[] = [
  "fim",
  "chat",
  "embeddings"
]

/** A model as a provider advertises it, in twinny's terms. */
export interface InferenceModel {
  id: string
  name: string
  capabilities: InferenceCapability[]
  contextWindow?: number
}

export interface InferenceOptions {
  /**
   * Aborting stops the request. A stream being read at the time throws a
   * `cancelled` error; one already finished, or one the consumer stopped
   * reading, does nothing.
   */
  signal?: AbortSignal
}

export interface FimRequest {
  model: string
  /** The hole as the model expects it: prefix, suffix and template applied. */
  prompt: string
  /** The raw sides of the hole, for providers with a native FIM endpoint. */
  prefix?: string
  suffix?: string
  stop?: string[]
  /** Cap on generated tokens. Unset or negative means the server's default. */
  maxTokens?: number
  temperature?: number
  /** How long to keep the model loaded afterwards, on servers that ask. */
  keepAlive?: string | number
}

export interface FimChunk {
  text: string
}

/**
 * The conversation shape the webview builds and history stores. It follows
 * the common role/content convention; adapters map it to their own API.
 */
export type ChatMessage = ChatCompletionMessage

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
}

export interface ChatChunk {
  content: string
}

export interface EmbeddingRequest {
  model: string
  input: string | string[]
}

export interface EmbeddingResponse {
  /** One vector per input, in input order. */
  vectors: number[][]
}

/**
 * Every capability streams: a provider that only answers whole yields once.
 * The consumer reads with `for await` either way.
 */
export type InferenceStream<T> = AsyncIterable<T>

/**
 * What an adapter implements. Only `capabilities()` is required; a provider
 * that cannot do a job leaves the method out and the layer refuses the call
 * with an `unsupported-capability` error before anything is sent.
 */
export interface InferenceProvider {
  /** The provider kind being served, e.g. `ollama` or `anthropic`. */
  readonly id: string

  capabilities(): InferenceCapability[]

  models?(options?: InferenceOptions): Promise<InferenceModel[]>

  fim?(request: FimRequest, options?: InferenceOptions): InferenceStream<FimChunk>

  chat?(
    request: ChatRequest,
    options?: InferenceOptions
  ): InferenceStream<ChatChunk>

  embeddings?(
    request: EmbeddingRequest,
    options?: InferenceOptions
  ): Promise<EmbeddingResponse>
}

/**
 * What the registry hands a feature: every method present, so the caller
 * never checks for one. Asking for a capability the provider lacks throws
 * `unsupported-capability`; any other failure arrives as an `InferenceError`.
 */
export type InferenceClient = Required<InferenceProvider>

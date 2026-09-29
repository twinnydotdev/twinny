import { getEndpointDefaults, isRemoteProvider } from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"
import { isInferenceError, resolveInferenceProvider } from "../inference"
import { describeProviderErrorPlain } from "../providers/errors"

/** Texts per request. Ollama, llama.cpp and OpenAI-style servers all take a list. */
const BATCH_SIZE = 16
const EMBED_TIMEOUT_MS = 60_000
/** Files the indexer embeds at once against a server of our own. */
const LOCAL_PARALLEL = 4
/**
 * Waits between attempts when the server says it is busy (a gateway caps
 * requests running at once; hosted APIs meter them). Once these run out
 * the refusal stands and the run stops with its message.
 */
const RATE_LIMIT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000]

export interface EmbedderOptions {
  rateLimitDelaysMs?: number[]
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const isRateLimited = (error: unknown): boolean =>
  (isInferenceError(error) && error.kind === "rate-limited") ||
  (error as { status?: number } | null)?.status === 429

/**
 * Whether a text is being indexed or asked about. Some models are trained
 * with a different prefix for each side and retrieve noticeably better
 * when they get it.
 */
export type EmbedKind = "document" | "query"

const TASK_PREFIXES: Array<{ match: RegExp; document: string; query: string }> = [
  { match: /nomic-embed/i, document: "search_document: ", query: "search_query: " },
  { match: /e5-/i, document: "passage: ", query: "query: " }
]

export const withTaskPrefix = (
  model: string,
  kind: EmbedKind,
  text: string
): string => {
  const prefix = TASK_PREFIXES.find((entry) => entry.match.test(model))
  return prefix ? `${prefix[kind]}${text}` : text
}

/**
 * The route for a provider saved without one: the kind's usual embedding
 * route. A gateway provider's path is a base the protocol routes are
 * added to, so for it the answer is empty; a fixed "/api/embed" there sent
 * embeddings to a route the gateway does not have.
 */
const embeddingPath = (provider: TwinnyProvider): string =>
  getEndpointDefaults(provider.provider, "embedding")?.apiPath ?? ""

/**
 * Turns text into vectors with the active embedding provider. Sends texts
 * in batches, which is the difference between an index run taking minutes
 * and taking most of an hour, and falls back to one request per text for
 * servers that only accept a single string.
 */
export class Embedder {
  private _singleOnly = false

  constructor(
    private readonly _getProvider: () => TwinnyProvider | undefined,
    private readonly _options: EmbedderOptions = {}
  ) {}

  public get provider(): TwinnyProvider | undefined {
    return this._getProvider()
  }

  /**
   * How many files the indexer may embed at once. A gateway is shared
   * with the team and caps requests running at once, so an index run
   * takes one turn at a time there rather than the whole cap.
   */
  public get parallel(): number {
    const provider = this._getProvider()
    return provider && isRemoteProvider(provider.provider) ? 1 : LOCAL_PARALLEL
  }

  /** The active model's name, which the index is stamped with. */
  public get model(): string | undefined {
    return this._getProvider()?.modelName
  }

  public async embed(texts: string[], kind: EmbedKind): Promise<number[][]> {
    const provider = this._getProvider()
    if (!provider) {
      throw new Error("No embedding provider is set. Add one in the providers tab.")
    }
    if (!texts.length) return []

    const inputs = texts.map((text) => withTaskPrefix(provider.modelName, kind, text))
    const vectors: number[][] = []
    for (let offset = 0; offset < inputs.length; offset += BATCH_SIZE) {
      vectors.push(...(await this.embedBatch(provider, inputs.slice(offset, offset + BATCH_SIZE))))
    }
    return vectors
  }

  public async embedOne(text: string, kind: EmbedKind): Promise<number[]> {
    const [vector] = await this.embed([text], kind)
    return vector
  }

  private async embedBatch(
    provider: TwinnyProvider,
    inputs: string[]
  ): Promise<number[][]> {
    if (!this._singleOnly && inputs.length > 1) {
      try {
        const vectors = await this.request(provider, inputs)
        if (vectors.length === inputs.length) return vectors
      } catch (error) {
        // A 4xx on a list is the server saying "one string at a time"; a
        // connection failure, a 5xx or a refusal for being busy is a real
        // problem and must surface.
        const status = (error as { status?: number }).status
        if (!status || status < 400 || status >= 500 || isRateLimited(error)) throw error
      }
      this._singleOnly = true
    }

    const vectors: number[][] = []
    for (const input of inputs) {
      const [vector] = await this.request(provider, input)
      if (!vector) throw new Error("The server answered but returned no embedding vector.")
      vectors.push(vector)
    }
    return vectors
  }

  /** One request, repeated after a pause while the server says it is busy. */
  private async request(
    provider: TwinnyProvider,
    input: string | string[]
  ): Promise<number[][]> {
    const delays = this._options.rateLimitDelaysMs ?? RATE_LIMIT_DELAYS_MS
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(provider, input)
      } catch (error) {
        if (!isRateLimited(error) || attempt >= delays.length) throw error
        await wait(delays[attempt])
      }
    }
  }

  private async once(
    provider: TwinnyProvider,
    input: string | string[]
  ): Promise<number[][]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS)

    try {
      const { vectors } = await resolveInferenceProvider({
        ...provider,
        apiPath: provider.apiPath || embeddingPath(provider)
      }).embeddings(
        { model: provider.modelName, input },
        { signal: controller.signal }
      )
      return vectors
    } catch (error) {
      throw Object.assign(new Error(describeProviderErrorPlain(error, provider)), {
        status: (error as { status?: number }).status
      })
    } finally {
      clearTimeout(timer)
    }
  }
}

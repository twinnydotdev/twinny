import { getProviderOrigin } from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"
import { describeProviderErrorPlain } from "../providers/errors"

/** Texts per request. Ollama, llama.cpp and OpenAI-style servers all take a list. */
const BATCH_SIZE = 16
const EMBED_TIMEOUT_MS = 60_000

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

interface EmbeddingResponse {
  /** OpenAI, LM Studio, vLLM, llama.cpp `/v1/embeddings`. */
  data?: Array<{ index?: number; embedding: number[] }>
  /** Ollama `/api/embed`. */
  embeddings?: number[][]
  /** llama.cpp `/embedding` and the legacy Ollama route. */
  embedding?: number[]
}

/** Every vector in a response, in input order, whatever the server's dialect. */
export const vectorsFromResponse = (body: EmbeddingResponse): number[][] => {
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

/**
 * Turns text into vectors with the active embedding provider. Sends texts
 * in batches, which is the difference between an index run taking minutes
 * and taking most of an hour, and falls back to one request per text for
 * servers that only accept a single string.
 */
export class Embedder {
  private _singleOnly = false

  constructor(
    private readonly _getProvider: () => TwinnyProvider | undefined
  ) {}

  public get provider(): TwinnyProvider | undefined {
    return this._getProvider()
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
        // connection failure or a 5xx is a real problem and must surface.
        const status = (error as { status?: number }).status
        if (!status || status < 400 || status >= 500) throw error
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

  private async request(
    provider: TwinnyProvider,
    input: string | string[]
  ): Promise<number[][]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS)
    const url = `${getProviderOrigin({
      ...provider,
      apiHostname: provider.apiHostname || "localhost"
    })}${provider.apiPath || "/api/embed"}`

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
        },
        body: JSON.stringify({ model: provider.modelName, input, stream: false }),
        signal: controller.signal
      })
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 200)
        throw Object.assign(
          new Error(`${response.status} ${response.statusText} ${detail}`.trim()),
          { status: response.status }
        )
      }
      const vectors = vectorsFromResponse(await response.json())
      if (!vectors.length) {
        throw new Error("The server answered but returned no embedding vector.")
      }
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

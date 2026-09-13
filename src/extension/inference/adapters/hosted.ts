/**
 * A hosted API. Chat goes through its SDK; the jobs it serves at a plain
 * HTTP endpoint (Mistral and OpenRouter completions, OpenAI embeddings)
 * are delegated to the HTTP adapter at the configured address.
 */
import { TokenJS } from "fluency.js"

import {
  getEndpointDefaults,
  supportsType,
  usesEndpoint
} from "../../../common/provider-validation"
import { TwinnyProvider } from "../../../common/types"
import {
  ChatRequest,
  InferenceCapability,
  InferenceModel,
  InferenceOptions,
  InferenceProvider
} from "../types"

import { fluencyChat, hostedModels } from "./fluency"
import { HttpInferenceProvider } from "./http"

export class HostedInferenceProvider implements InferenceProvider {
  public readonly id: string
  private readonly _endpoint: HttpInferenceProvider

  constructor(private readonly _config: TwinnyProvider) {
    this.id = _config.provider
    this._endpoint = new HttpInferenceProvider(_config)
  }

  public capabilities(): InferenceCapability[] {
    const id = this._config.provider
    return [
      "chat",
      ...(supportsType(id, "fim") ? (["fim"] as const) : []),
      ...(getEndpointDefaults(id, "embedding") ? (["embeddings"] as const) : [])
    ]
  }

  public chat(request: ChatRequest, options?: InferenceOptions) {
    const client = new TokenJS({ apiKey: this._config.apiKey || undefined })
    return fluencyChat(client, this._config, request, options)
  }

  public fim(...args: Parameters<HttpInferenceProvider["fim"]>) {
    return this._endpoint.fim(...args)
  }

  public embeddings(...args: Parameters<HttpInferenceProvider["embeddings"]>) {
    return this._endpoint.embeddings(...args)
  }

  public async models(options?: InferenceOptions): Promise<InferenceModel[]> {
    const { provider, type } = this._config
    if (!usesEndpoint(provider, type)) return hostedModels(provider)
    try {
      return await this._endpoint.models(options)
    } catch (error) {
      const known = hostedModels(provider)
      if (known.length) return known
      throw error
    }
  }
}

/**
 * A hosted API. Chat goes through its SDK; the jobs it serves at a plain
 * HTTP endpoint (Mistral and OpenRouter completions, OpenAI embeddings)
 * are delegated to the HTTP adapter at the configured address.
 */
import { TokenJS } from "fluency.js"

import { API_PROVIDERS } from "../../../common/constants"
import {
  getEndpointDefaults,
  getProviderOrigin,
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
import { MISTRAL_BASE_URL, mistralApiKey, mistralModels } from "./mistral"
import { needsResponsesApi, responsesChat } from "./openai-responses"

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
    // Tools on OpenAI go through the Responses API; see openai-responses.ts.
    if (this._config.provider === API_PROVIDERS.OpenAI && needsResponsesApi(request)) {
      return responsesChat(this._config, request, options)
    }
    if (this._config.provider === API_PROVIDERS.Mistral) {
      // The open-ended handler lets Mistral validate newer model IDs. Keep
      // the native address and resolve only Mistral's credentials ourselves.
      const apiKey = mistralApiKey(this._config)
      if (!apiKey) throw new Error("Mistral requires an API key. Set it on the provider or in MISTRAL_API_KEY.")
      const client = new TokenJS({ baseURL: MISTRAL_BASE_URL, apiKey })
      return fluencyChat(client, this._config, request, options)
    }
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
    // FIM can use a custom endpoint; its credentials and discovery must
    // stay at that address. Hosted chat always uses the native service.
    if (provider === API_PROVIDERS.Mistral &&
      (type === "chat" || (type === "fim" &&
        ["https://api.mistral.ai", "https://api.mistral.ai:443"].includes(getProviderOrigin(this._config))))) {
      return mistralModels(this._config, options)
    }
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

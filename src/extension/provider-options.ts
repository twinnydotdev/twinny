import { API_PROVIDERS, USER } from "../common/constants"
import {
  RequestBodyBase,
  RequestOptionsOllama,
  StreamBodyOpenAI
} from "../common/types"

/** OpenAI's completions API rejects more than four stop sequences. */
const MAX_HOSTED_STOP_SEQUENCES = 4

export interface FimRequestOptions {
  temperature: number
  numPredictFim: number
  model: string
  keepAlive?: string | number
  stop?: string[]
}

export function createStreamRequestBodyFim(
  provider: string,
  prompt: string,
  options: FimRequestOptions
): RequestBodyBase | RequestOptionsOllama | StreamBodyOpenAI {
  const stop = options.stop?.length ? options.stop : undefined
  // Ollama and llama.cpp treat -1 as "no limit"; OpenAI-style APIs reject it.
  const maxTokens = options.numPredictFim > 0 ? options.numPredictFim : undefined

  switch (provider) {
    case API_PROVIDERS.OpenAICompatible:
    case API_PROVIDERS.OpenWebUI:
    case API_PROVIDERS.Ollama:
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

import { USER } from "../common/constants"
import {
  apiProviders,
  RequestBodyBase,
  RequestOptionsOllama,
  StreamBodyOpenAI,
} from "../common/types"

export function createStreamRequestBodyFim(
  provider: string,
  prompt: string,
  options: {
    temperature: number
    numPredictFim: number
    model: string
    keepAlive?: string | number
  }
): RequestBodyBase | RequestOptionsOllama | StreamBodyOpenAI {
  switch (provider) {
    case apiProviders.OpenAICompatible:
    case apiProviders.OpenWebUI:
      return {
        model: options.model,
        prompt,
        stream: true,
        keep_alive: options.keepAlive === "-1"
          ? -1
          : options.keepAlive,
        options: {
          temperature: options.temperature,
          num_predict: options.numPredictFim,
        },
      }
    case apiProviders.LMStudio:
      return {
        model: options.model,
        prompt,
        stream: true,
        temperature: options.temperature,
        max_tokens: options.numPredictFim,
      }
    case apiProviders.LlamaCpp:
    case apiProviders.Oobabooga:
      return {
        prompt,
        stream: true,
        temperature: options.temperature,
        max_tokens: options.numPredictFim,
      }
    case apiProviders.LiteLLM:
      return {
        messages: [{ content: prompt, role: USER }],
        model: options.model,
        stream: true,
        max_tokens: options.numPredictFim,
        temperature: options.temperature,
      }
    default:
      return {
        prompt,
        stream: true,
        temperature: options.temperature,
        n_predict: options.numPredictFim,
      }
  }
}

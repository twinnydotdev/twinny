import { USER } from '../common/constants'
import {
  Message,
  ApiProviders,
  StreamBodyBase,
  StreamBodyOpenAI,
  StreamOptionsOllama
} from '../common/types'

export function createStreamRequestBody(
  provider: string,
  prompt: string,
  options: {
    temperature: number
    numPredictChat: number
    model: string
    messages?: Message[]
    keepAlive?: string | number
  }
): StreamBodyBase | StreamOptionsOllama | StreamBodyOpenAI {
  switch (provider) {
    case ApiProviders.Ollama:
    case ApiProviders.OllamaWebUi:
      return {
        model: options.model,
        prompt,
        stream: true,
        messages: options.messages,
        keep_alive: options.keepAlive,
        options: {
          temperature: options.temperature,
          num_predict: options.numPredictChat
        }
      }
    case ApiProviders.LlamaCpp:
      return {
        prompt,
        stream: true,
        temperature: options.temperature,
        n_predict: options.numPredictChat
      }
    case ApiProviders.LiteLLM:
    default:
      return {
        model: options.model,
        stream: true,
        max_tokens: options.numPredictChat,
        messages: options.messages,
        temperature: options.temperature
      }
  }
}

export function createStreamRequestBodyFim(
  provider: string,
  prompt: string,
  options: {
    temperature: number
    numPredictFim: number
    model: string
    keepAlive?: string | number
  }
): StreamBodyBase | StreamOptionsOllama | StreamBodyOpenAI {
  switch (provider) {
    case ApiProviders.Ollama:
    case ApiProviders.OllamaWebUi:
      return {
        model: options.model,
        prompt,
        stream: true,
        keep_alive: options.keepAlive,
        options: {
          temperature: options.temperature,
          num_predict: options.numPredictFim
        }
      }
    case ApiProviders.LMStudio:
      return {
        prompt,
        stream: true,
        temperature: options.temperature,
        n_predict: options.numPredictFim
      }
    case ApiProviders.LlamaCpp:
      return {
        prompt,
        stream: true,
        temperature: options.temperature,
        n_predict: options.numPredictFim
      }
    case ApiProviders.LiteLLM:
    default:
      return {
        messages: [{ content: prompt, role: USER }],
        model: options.model,
        stream: true,
        max_tokens: options.numPredictFim,
        temperature: options.temperature
      }
  }
}

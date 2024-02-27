import {
  MessageRoleContent,
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
    messages?: MessageRoleContent[]
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
    default:
      return {
        model: options.model,
        prompt,
        stream: true,
        max_tokens: options.numPredictChat,
        messages: options.messages,
        temperature: options.temperature
      }
  }
}

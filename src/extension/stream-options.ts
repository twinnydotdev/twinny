import {
  MessageRoleContent,
  ApiProviders,
  StreamOptionsBase,
  StreamOptionsOpenAI,
  StreamOptionsOllama,
} from './types'

export function createStreamRequestBody(
  provider: string,
  prompt: string,
  options: {
    temperature: number
    numPredictChat: number
    model: string
    messages?: MessageRoleContent[]
  }
): StreamOptionsBase | StreamOptionsOllama | StreamOptionsOpenAI {
  switch (provider) {
    case ApiProviders.Ollama:
      return {
        model: options.model,
        prompt,
        stream: true,
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

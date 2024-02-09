import {
  MessageRoleContent,
  ProviderNames,
  StreamOptions,
  StreamOptionsMessages,
  StreamOptionsOllama,
  StreamResponse
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
): StreamOptions | StreamOptionsOllama | StreamOptionsMessages {
  switch (provider) {
    case ProviderNames.Ollama:
      return {
        model: options.model,
        prompt,
        stream: true,
        options: {
          temperature: options.temperature,
          num_predict: options.numPredictChat
        }
      }
    case ProviderNames.LlamaCpp:
      return {
        prompt,
        stream: true,
        temperature: options.temperature,
        n_predict: options.numPredictChat
      }
    default:
      return {
        prompt,
        stream: true,
        max_tokens: options.numPredictChat,
        messages: options.messages,
        temperature: options.temperature
      }
  }
}

export const getChatDataFromProvider = (
  provider: string,
  data: StreamResponse | undefined
) => {
  switch (provider) {
    case ProviderNames.Ollama:
      return data?.response
    case ProviderNames.LlamaCpp:
      return data?.content
    default:
      if (data?.choices[0].delta.content === 'undefined') {
        return ''
      }
      return data?.choices[0].delta?.content
        ? data?.choices[0].delta.content
        : ''
  }
}

export const getFimDataFromProvider = (provider: string, data: StreamResponse | undefined) => {
  switch (provider) {
    case ProviderNames.Ollama:
      return data?.response
    case ProviderNames.LlamaCpp:
      return data?.content
    default:
      if (!data?.choices.length) return
      if (data?.choices[0].delta.content === 'undefined') {
        return ''
      }
      return data?.choices[0].delta?.content
        ? data?.choices[0].delta.content
        : ''
  }
}

import { workspace } from 'vscode'
import {
  MessageRoleContent,
  ApiProviders,
  StreamBodyBase,
  StreamBodyOpenAI,
  StreamOptionsOllama
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
): StreamBodyBase | StreamOptionsOllama | StreamBodyOpenAI {
  const config = workspace.getConfiguration('twinny')

  switch (provider) {
    case ApiProviders.Ollama:
    case ApiProviders.OllamaWebUi:
      var result: StreamOptionsOllama = {
        model: options.model,
        prompt,
        stream: true,
        options: {
          temperature: options.temperature,
          num_predict: options.numPredictChat
        }
      }
      if (config.get('keepModelsInMemory')) {
        result.keep_alive = -1
      }
      return result
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

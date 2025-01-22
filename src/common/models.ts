import { models as baseModels } from "token.js"

export const models = {
  ...baseModels,
  deepseek: {
    models: ["deepseek-chat", "deepseek-reasoner"],
    supportsCompletion: true,
    supportsStreaming: ["deepseek-chat", "deepseek-reasoner"],
    supportsJSON: [],
    supportsImages: [],
    supportsToolCalls: []
  }
}

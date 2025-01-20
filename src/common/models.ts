import { models as baseModels } from "token.js"

export const models = {
  ...baseModels,
  deepseek: {
    models: ["deepseek-chat"],
    supportsCompletion: true,
    supportsStreaming: ["deepseek-chat"],
    supportsJSON: [],
    supportsImages: [],
    supportsToolCalls: []
  }
}

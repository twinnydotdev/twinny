/**
 * Guessing which of a server's models fits a job, from the name alone.
 *
 * Pure, and shared by the provider form (which fills the model box once
 * the server has been listed), the device cards, and first-run discovery.
 */

export const EMBEDDING_MODEL_PATTERN = /embed|minilm|bge|e5|nomic/i

export const FIM_MODEL_PATTERN =
  /code|coder|fim|starcoder|codestral|codegemma|stable-code|qwen2\.5-coder|deepseek-coder/i

export const isEmbeddingModel = (name: string) =>
  EMBEDDING_MODEL_PATTERN.test(name)

export const isCodeModel = (name: string) =>
  FIM_MODEL_PATTERN.test(name) && !isEmbeddingModel(name)

const CHAT_HINT_PATTERN = /instruct|chat|it\b/i

/**
 * For chat, a model built for conversation beats a base code model: an
 * explicitly instruct/chat-tagged one first, then anything that is not a
 * code model, then whatever is left that is not an embedding.
 */
const pickChatModel = (models: string[]): string | undefined => {
  const candidates = models.filter((m) => !isEmbeddingModel(m))
  return (
    candidates.find((m) => CHAT_HINT_PATTERN.test(m)) ||
    candidates.find((m) => !isCodeModel(m)) ||
    candidates[0]
  )
}

/**
 * The first model that fits the job, or failing that the first model that
 * is not obviously wrong for it. Used where something has to be picked
 * (a form), so it only returns nothing when the list is empty.
 */
export const pickModel = (models: string[], type: string): string | undefined => {
  if (type === "embedding") {
    return models.find(isEmbeddingModel) || models[0]
  }
  if (type === "fim") {
    const nonEmbedding = models.filter((m) => !isEmbeddingModel(m))
    return nonEmbedding.find(isCodeModel) || nonEmbedding[0]
  }
  return pickChatModel(models) || models[0]
}

/**
 * Stricter than `pickModel`: only a model that looks right for the job.
 * Used when setting things up unattended, where a wrong guess (an instruct
 * model for autocomplete, a chat model for embeddings) is worse than
 * leaving the job unset and saying so.
 */
export const pickModelStrict = (
  models: string[],
  type: string
): string | undefined => {
  switch (type) {
    case "embedding":
      return models.find(isEmbeddingModel)
    case "fim":
      return models.find(isCodeModel)
    default:
      return pickChatModel(models)
  }
}

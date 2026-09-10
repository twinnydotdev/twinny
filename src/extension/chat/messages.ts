/**
 * Turning the webview's conversation into what fluency.js wants.
 *
 * Pure: the chat composer produces HTML (mentions are `<span>`s, pasted
 * images are `<img>`s) and the model wants plain text plus image parts.
 */
import * as cheerio from "cheerio"
import { LLMProvider } from "fluency.js/dist/chat"

import { API_PROVIDERS } from "../../common/constants"
import { models } from "../../common/models"
import { isOpenAICompatibleProvider } from "../../common/provider-validation"
import {
  ChatCompletionMessage,
  CompletionNonStreamingWithId,
  CompletionStreamingWithId,
  TwinnyProvider
} from "../../common/types"

/** The composer's HTML as the plain text the user meant. */
export const cleanMessageHtml = (html: string): string => {
  const $ = cheerio.load(html)
  $("img").remove()
  return $.html("body")
    .replace(/&lt;/g, "<")
    .replace(/<body>|<\/body>/g, "")
    .replace(/@(problems|workspace|git|terminal)\b/g, "")
    .trim()
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/<span[^>]*data-type="mention"[^>]*>(.*?)<\/span>/g, "$1")
    .trimStart()
}

/**
 * One message as the API sees it: text, plus image parts when the user
 * attached any. Text-only messages keep their content verbatim so the
 * system prompt and template output are not run through an HTML parser.
 */
export const toApiMessage = (
  message: ChatCompletionMessage
): ChatCompletionMessage => {
  const images =
    message.images?.map((img) => ({
      type: "image_url" as const,
      image_url: { url: typeof img === "string" ? img : img.data }
    })) || []

  const textPart = {
    type: "text" as const,
    text: images.length ? cleanMessageHtml(String(message.content)) : message.content
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = {
    role: message.role,
    content: images.length ? [textPart, ...images] : [textPart]
  }
  if (message.role === "function" && message.name) result.name = message.name
  if (message.id) result.id = message.id
  return result as ChatCompletionMessage
}

export const toApiMessages = (conversation: ChatCompletionMessage[]) =>
  conversation.map(toApiMessage)

/** fluency.js routes every local server through its OpenAI-compatible client. */
export const getFluencyProvider = (provider: TwinnyProvider): LLMProvider =>
  (isOpenAICompatibleProvider(provider.provider)
    ? API_PROVIDERS.OpenAICompatible
    : provider.provider) as LLMProvider

/** Some hosted models refuse `stream: true`; the catalogue says which. */
export const supportsStreaming = (provider: TwinnyProvider): boolean => {
  const entry = models[provider.provider as keyof typeof models]
  const streaming = entry?.supportsStreaming
  return Array.isArray(streaming) ? streaming.includes(provider.modelName) : true
}

export const buildStreamingRequest = (
  provider: TwinnyProvider,
  messages: ChatCompletionMessage[],
  conversationId?: string
): CompletionStreamingWithId => ({
  messages,
  model: provider.modelName,
  stream: true,
  id: conversationId,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: getFluencyProvider(provider) as any
})

export const buildBlockingRequest = (
  provider: TwinnyProvider,
  messages: ChatCompletionMessage[]
): CompletionNonStreamingWithId => ({
  messages: messages.filter((m) => m.role !== "system"),
  model: provider.modelName,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: getFluencyProvider(provider) as any
})

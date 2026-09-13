/**
 * Turning the webview's conversation into plain chat messages.
 *
 * Pure: the chat composer produces HTML (mentions are `<span>`s, pasted
 * images are `<img>`s) and the model wants plain text plus image parts.
 */
import * as cheerio from "cheerio"

import { ChatCompletionMessage } from "../../common/types"

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
  return result as ChatCompletionMessage
}

export const toApiMessages = (conversation: ChatCompletionMessage[]) =>
  conversation.map(toApiMessage)

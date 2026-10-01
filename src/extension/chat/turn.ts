/**
 * One chat turn: the webview's conversation in, the messages the model is
 * sent out.
 *
 * The webview keeps user turns as the composer's HTML (`<br>`, mention
 * `<span>`s, escaped `&lt;`) and replies as the model's markdown. Every user
 * turn is turned into the plain text the user meant here, before anything
 * else is added to it, so attached code never passes through an HTML parser
 * and the model never sees composer markup. `@workspace`, `@problems`, `@git`
 * and `@terminal` name sources of context for twinny to fetch; they are read
 * once, here, and are not words for the model.
 */
import * as cheerio from "cheerio"

import { ASSISTANT, SYSTEM, TOP_LEVEL_MENTIONS, USER } from "../../common/constants"
import { ChatCompletionMessage } from "../../common/types"

export type ContextSource = "workspace" | "problems" | "git" | "terminal"

const SOURCE_PATTERN = new RegExp(`@(${[...TOP_LEVEL_MENTIONS].join("|")})\\b`, "g")

/** The context sources a message names. */
export const contextSources = (text: string): Set<ContextSource> =>
  new Set([...text.matchAll(SOURCE_PATTERN)].map((match) => match[1] as ContextSource))

/** A message without the words that name a context source. */
export const withoutSources = (text: string) =>
  text
    .replace(SOURCE_PATTERN, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .trim()

type HtmlNode = { type: string; name?: string; data?: string; children?: HtmlNode[] }

const textOf = (nodes: HtmlNode[] = []): string =>
  nodes
    .map((node) => {
      if (node.type === "text") return node.data ?? ""
      if (node.type !== "tag") return ""
      switch (node.name) {
        case "br":
          return "\n"
        case "img":
          return ""
        case "pre":
          return `\n\`\`\`\n${textOf(node.children).replace(/\n$/, "")}\n\`\`\`\n`
        case "p":
        case "div":
          return `${textOf(node.children)}\n`
        default:
          return textOf(node.children)
      }
    })
    .join("")

/** The composer's HTML as the plain text the user meant. */
export const composerText = (html: string): string => {
  const body = cheerio.load(html)("body").get(0) as unknown as HtmlNode | undefined
  return textOf(body?.children).replace(/\n{3,}/g, "\n\n").trim()
}

/**
 * What the model is sent for one message of the webview's conversation:
 * the prompt a feature recorded for a user turn, a user turn as plain
 * text, a reply as it was shown.
 */
const modelText = (message: ChatCompletionMessage): string => {
  const content = typeof message.content === "string" ? message.content : ""
  if (message.role === ASSISTANT) {
    // A reply goes back as it was shown, whatever else was recorded with
    // it. One stopped before any text (its tools ran, and their notes say
    // what they did) still takes its turn: a blank one is refused by some
    // providers, and a missing one puts two user turns in a row.
    return content.trim() ? content : STOPPED_REPLY
  }
  if (message.prompt !== undefined) return message.prompt
  return message.role === USER ? withoutSources(composerText(content)) : content
}

const STOPPED_REPLY = "(This reply was stopped before any text was written.)"

/** The API shape: text, plus image parts when the user attached any. */
const toApiMessage = (
  message: ChatCompletionMessage,
  text: string
): ChatCompletionMessage => {
  const images =
    message.images?.map((img) => ({
      type: "image_url" as const,
      image_url: { url: typeof img === "string" ? img : img.data }
    })) || []
  const textPart = { type: "text" as const, text }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = {
    role: message.role,
    content: images.length ? [textPart, ...images] : [textPart]
  }
  if (message.role === "function" && message.name) result.name = message.name
  return result as ChatCompletionMessage
}

/** What a turn needs from the editor and the workspace. */
export interface TurnContext {
  systemPrompt(): Promise<string>
  /**
   * Everything besides the user's words: the selection, what the named
   * sources pull in, and attached code. `history` is the conversation so
   * far as the model sees it.
   */
  additionalContext(
    question: string,
    sources: Set<ContextSource>,
    history: ChatCompletionMessage[]
  ): Promise<string>
}

/**
 * What the previous reply's tools were asked and returned comes with the
 * new question, once: as context from the user's side, and not in the
 * reply itself. A model shown a transcript in its own earlier turn writes
 * the next one the same way, tool results and all, without calling a tool
 * (qwen3-coder did, one follow-up in three). Older replies carry only
 * their answers, which already say what they found.
 */
const TOOL_NOTES_HEADER =
  "[For reference: the tool calls and results behind your previous reply. The user did not see them.]"
const NEW_MESSAGE_HEADER = "[The user's new message:]"

/**
 * The messages to send for the webview's conversation, whose last message
 * is the user's new question.
 */
export const buildChatTurn = async (
  messages: ChatCompletionMessage[],
  context: TurnContext
): Promise<ChatCompletionMessage[]> => {
  const history = messages
    .slice(0, -1)
    .map((message) => ({ message, text: modelText(message) }))
  const last = messages[messages.length - 1]
  const said =
    last.prompt ?? composerText(typeof last.content === "string" ? last.content : "")
  const question = withoutSources(said)
  const extra = await context.additionalContext(
    question,
    contextSources(said),
    history.map(({ message, text }) => ({ ...message, content: text }) as ChatCompletionMessage)
  )
  const previous = messages[messages.length - 2]
  const notes = previous?.role === ASSISTANT ? previous.toolNotes?.trim() : undefined
  // The notes go before the question and the question's own context after
  // it: what the user is asking now is what the message should end on.
  const asked = `${question}\n\n${extra.trim()}`.trim()
  return [
    { role: SYSTEM, content: await context.systemPrompt() },
    ...history.map(({ message, text }) => toApiMessage(message, text)),
    toApiMessage(last, notes ? `${TOOL_NOTES_HEADER}\n${notes}\n\n${NEW_MESSAGE_HEADER}\n${asked}` : asked)
  ]
}

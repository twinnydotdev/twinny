import { ASSISTANT, TWINNY, USER, YOU } from "../common/constants"
import { ChatCompletionMessage } from "../common/types"

import { getThinkingMessage } from "./utils"

/** The composer's HTML as markdown: line breaks, `@mentions`, fenced code. */
const composerMarkdown = (html: string): string => {
  const root = document.createElement("div")
  root.innerHTML = html
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ""
    if (!(node instanceof HTMLElement)) return ""
    const inner = () => Array.from(node.childNodes).map(walk).join("")
    switch (node.tagName) {
      case "BR":
        return "\n"
      case "IMG":
        return "[image]"
      case "PRE":
        return `\n\`\`\`\n${(node.textContent ?? "").replace(/\n$/, "")}\n\`\`\`\n`
      case "P":
      case "DIV":
        return `${inner()}\n`
      default:
        return inner()
    }
  }
  return walk(root).replace(/\n{3,}/g, "\n\n").trim()
}

/**
 * A conversation as one markdown document, for keeping or sharing. Replies
 * lose their thinking; user turns lose the composer's markup.
 */
export const conversationMarkdown = (
  title: string | undefined,
  messages: ChatCompletionMessage[]
): string => {
  const turns = messages
    .filter((m) => m.role === USER || m.role === ASSISTANT)
    .map((m) => {
      const content = typeof m.content === "string" ? m.content : ""
      if (m.role === USER) return `## ${YOU}\n\n${composerMarkdown(content)}`
      const model = m.meta?.model ? ` · \`${m.meta.model}\`` : ""
      return `## ${TWINNY}${model}\n\n${getThinkingMessage(content).message.trim()}`
    })
  const heading = title?.trim() ? `# ${composerMarkdown(title)}\n\n` : ""
  return `${heading}${turns.join("\n\n")}\n`
}

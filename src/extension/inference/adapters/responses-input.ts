import { ChatMessage } from "../types"

export type ResponsesInputItem =
  | { role: "user" | "assistant"; content: string | Array<Record<string, unknown>> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }

const textOf = (content: ChatMessage["content"]): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
      : ""

type Part = { type: string; text?: string; image_url?: { url: string } }

/** A user turn's parts in Responses terms; plain text stays a string. */
const userContent = (
  content: ChatMessage["content"]
): string | Array<Record<string, unknown>> => {
  if (!Array.isArray(content)) return textOf(content)
  const parts = content as Part[]
  if (!parts.some((part) => part.type === "image_url")) return textOf(content)
  return parts.map((part) =>
    part.type === "image_url"
      ? { type: "input_image", image_url: part.image_url?.url }
      : { type: "input_text", text: part.text ?? "" }
  )
}

/** Pure message codec shared by Responses adapters; each keeps its own request policy. */
export const toResponsesInput = (messages: ChatMessage[]) => {
  const instructions: string[] = []
  const input: ResponsesInputItem[] = []
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      instructions.push(textOf(message.content))
    } else if (message.role === "user") {
      input.push({ role: "user", content: userContent(message.content) })
    } else if (message.role === "assistant") {
      const text = textOf(message.content)
      if (text.trim()) input.push({ role: "assistant", content: text })
      const calls =
        (message as {
          tool_calls?: {
            id: string
            function: { name: string; arguments: string }
          }[]
        }).tool_calls ?? []
      for (const call of calls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments
        })
      }
    } else if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: (message as { tool_call_id: string }).tool_call_id,
        output: textOf(message.content)
      })
    }
  }
  return {
    instructions: instructions.join("\n\n").trim() || undefined,
    input
  }
}

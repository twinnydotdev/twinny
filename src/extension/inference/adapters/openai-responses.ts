/**
 * Chat through OpenAI's Responses API, for conversations that use tools.
 *
 * OpenAI's reasoning models (gpt-6-astra and its kind) refuse function
 * tools on `/v1/chat/completions` unless reasoning is off, which they do
 * not allow, and asked to write tool calls as text instead they tend to
 * stall there before sending a byte. `/v1/responses` takes tools and
 * reasoning together and answers in seconds, so a request with tools, or
 * a conversation that already holds tool calls, comes here.
 */
import { getProviderOrigin } from "../../../common/provider-validation"
import { TwinnyProvider } from "../../../common/types"
import {
  ChatChunk,
  ChatFinishReason,
  ChatMessage,
  ChatRequest,
  ChatToolCall,
  InferenceOptions,
  InferenceUsage
} from "../types"

import { logRequest, responseError } from "./json-stream"
import { responseEvents } from "./responses-stream"

const DEFAULT_BASE = "https://api.openai.com/v1"

type InputItem =
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
const userContent = (content: ChatMessage["content"]): string | Array<Record<string, unknown>> => {
  if (!Array.isArray(content)) return textOf(content)
  const parts = content as Part[]
  if (!parts.some((part) => part.type === "image_url")) return textOf(content)
  return parts.map((part) =>
    part.type === "image_url"
      ? { type: "input_image", image_url: part.image_url?.url }
      : { type: "input_text", text: part.text ?? "" }
  )
}

/** Whether a conversation needs the Responses API: it offers tools or already holds tool calls. */
export const needsResponsesApi = (request: ChatRequest) =>
  !!request.tools?.length ||
  request.messages.some(
    (message) =>
      message.role === "tool" ||
      !!(message as { tool_calls?: unknown[] }).tool_calls?.length
  )

/** The conversation as Responses input: system turns become instructions. */
export const toResponsesInput = (messages: ChatMessage[]) => {
  const instructions: string[] = []
  const input: InputItem[] = []
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      instructions.push(textOf(message.content))
    } else if (message.role === "user") {
      input.push({ role: "user", content: userContent(message.content) })
    } else if (message.role === "assistant") {
      const text = textOf(message.content)
      if (text.trim()) input.push({ role: "assistant", content: text })
      const calls = (message as { tool_calls?: { id: string; function: { name: string; arguments: string } }[] })
        .tool_calls ?? []
      for (const call of calls) {
        input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments })
      }
    } else if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: (message as { tool_call_id: string }).tool_call_id,
        output: textOf(message.content)
      })
    }
  }
  return { instructions: instructions.join("\n\n").trim() || undefined, input }
}

const baseUrl = (config: TwinnyProvider) =>
  config.apiHostname
    ? `${getProviderOrigin(config)}${config.apiPath || "/v1"}`.replace(/\/$/, "")
    : DEFAULT_BASE

/** One request to `/v1/responses`, streamed as twinny chat chunks. */
export async function* responsesChat(
  config: TwinnyProvider,
  request: ChatRequest,
  options?: InferenceOptions
): AsyncGenerator<ChatChunk> {
  const { instructions, input } = toResponsesInput(request.messages)
  const body = {
    model: request.model || config.modelName,
    input,
    ...(instructions ? { instructions } : {}),
    stream: true,
    store: false,
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }))
        }
      : {}),
    ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
    ...(request.maxTokens !== undefined && request.maxTokens > 0 ? { max_output_tokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {})
  }
  const url = `${baseUrl(config)}/responses`
  logRequest(url, body)
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
    },
    body: JSON.stringify(body),
    signal: options?.signal
  })
  if (!response.ok) throw await responseError(response)
  if (!response.body) throw new Error("The server answered without a body.")

  const calls: ChatToolCall[] = []
  const text: string[] = []
  const reasoning: string[] = []
  for await (const event of responseEvents(response.body)) {
    if (options?.signal?.aborted) return
    switch (event.type) {
      // A refusal is the model's answer too; left out, the reply would be blank.
      case "response.output_text.delta":
      case "response.refusal.delta":
        if (event.delta) text.push(event.delta)
        break
      case "response.reasoning_summary_text.delta":
        if (event.delta) reasoning.push(event.delta)
        break
      case "response.output_item.done":
        if (event.item?.type === "function_call" && event.item.name) {
          calls.push({
            id: event.item.call_id || `call_${calls.length}`,
            name: event.item.name,
            arguments: event.item.arguments ?? ""
          })
        }
        break
      case "response.completed": {
        const usage: InferenceUsage | undefined = event.response?.usage
          ? {
              promptTokens: event.response.usage.input_tokens,
              completionTokens: event.response.usage.output_tokens
            }
          : undefined
        if (text.length) yield { content: text.join("") }
        if (reasoning.length) {
          yield { content: "", reasoning: reasoning.join("") }
        }
        const finishReason: ChatFinishReason = "stop"
        yield {
          content: "",
          finishReason,
          ...(usage ? { usage } : {}),
          ...(calls.length ? { toolCalls: [...calls] } : {})
        }
        return
      }
      case "response.incomplete":
        throw new Error(
          `The response was incomplete${event.response?.incomplete_details?.reason ? `: ${event.response.incomplete_details.reason}` : ""}.`
        )
      case "response.failed":
        throw new Error(
          event.response?.error?.message || "The response failed."
        )
      case "error":
        throw new Error(event.message || event.error?.message || "The server reported an error.")
    }
  }
  throw new Error("The response ended without response.completed.")
}

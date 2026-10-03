/**
 * Recorded requests as training data. Two shapes:
 *
 *   raw       the record as stored, one JSON object per line
 *   training  chat  → {"messages":[…, {"role":"assistant","content":…}]}
 *                     (a tool conversation keeps its calls and results in
 *                     the OpenAI fine-tuning shape, with the `tools` offered)
 *             fim   → {"prompt":…, "suffix":…, "completion":…}
 *             embeddings → {"input":[…]}   (there is no reply worth keeping)
 *
 * Failed and cancelled requests are left out of the training shape: a
 * partial reply teaches the wrong thing.
 */
import type { RecordingRecord } from "./store"

export type ExportFormat = "raw" | "training"

interface ToolCallLine {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

interface ChatMessage {
  role: string
  content: string | null
  tool_calls?: ToolCallLine[]
  tool_call_id?: string
}

/** A recorded message as a training message, or nothing when it has no text and made no calls. */
const trainingMessage = (message: Record<string, unknown>): ChatMessage | undefined => {
  const { role, content } = message
  if (typeof role !== "string") return undefined
  const calls = Array.isArray(message.tool_calls) && message.tool_calls.length ? (message.tool_calls as ToolCallLine[]) : undefined
  if (typeof content !== "string" && !calls) return undefined
  return {
    role,
    content: typeof content === "string" ? content : null,
    ...(calls ? { tool_calls: calls } : {}),
    ...(typeof message.tool_call_id === "string" ? { tool_call_id: message.tool_call_id } : {})
  }
}

/** One export line for a record, or nothing when the record has no training value. */
export const toTrainingLine = (record: RecordingRecord): Record<string, unknown> | undefined => {
  if (record.outcome !== "ok") return undefined
  const request = (record.request ?? {}) as Record<string, unknown>
  const response = (record.response ?? {}) as Record<string, unknown>
  switch (record.route) {
    case "chat": {
      const messages = Array.isArray(request.messages)
        ? (request.messages as Array<Record<string, unknown>>).flatMap((m) => trainingMessage(m) ?? [])
        : []
      const content = typeof response.content === "string" ? response.content : ""
      const calls = Array.isArray(response.toolCalls)
        ? (response.toolCalls as Array<{ id: string; name: string; arguments: string }>).map(
            (call): ToolCallLine => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })
          )
        : []
      if (!messages.length || (!content && !calls.length)) return undefined
      const tools = Array.isArray(request.tools)
        ? (request.tools as Array<Record<string, unknown>>).map((tool) => ({ type: "function", function: tool }))
        : []
      return {
        messages: [...messages, { role: "assistant", content: content || null, ...(calls.length ? { tool_calls: calls } : {}) }],
        ...(tools.length ? { tools } : {}),
        model: record.model ?? record.alias,
        key: record.key,
        at: record.at
      }
    }
    case "fim": {
      const completion = typeof response.text === "string" ? response.text : ""
      // `prefix` is the code as it was; `prompt` is that code inside a
      // model's template. Training wants the code.
      const prompt = typeof request.prefix === "string" ? request.prefix : typeof request.prompt === "string" ? request.prompt : undefined
      if (prompt === undefined || !completion) return undefined
      return {
        prompt,
        suffix: typeof request.suffix === "string" ? request.suffix : "",
        completion,
        model: record.model ?? record.alias,
        key: record.key,
        at: record.at
      }
    }
    case "embeddings": {
      const input = Array.isArray(request.input) ? request.input : request.input !== undefined ? [request.input] : []
      if (!input.length) return undefined
      return { input, model: record.model ?? record.alias, key: record.key, at: record.at }
    }
  }
}

export function* exportLines(records: Iterable<RecordingRecord>, format: ExportFormat): Iterable<string> {
  for (const record of records) {
    if (format === "raw") {
      yield JSON.stringify(record)
      continue
    }
    const line = toTrainingLine(record)
    if (line) yield JSON.stringify(line)
  }
}

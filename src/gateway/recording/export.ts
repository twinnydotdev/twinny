/**
 * Recorded requests as training data. Two shapes:
 *
 *   raw       the record as stored, one JSON object per line
 *   training  chat  → {"messages":[…, {"role":"assistant","content":…}]}
 *             fim   → {"prompt":…, "suffix":…, "completion":…}
 *             embeddings → {"input":[…]}   (there is no reply worth keeping)
 *
 * Failed and cancelled requests are left out of the training shape: a
 * partial reply teaches the wrong thing.
 */
import type { RecordingRecord } from "./store"

export type ExportFormat = "raw" | "training"

interface ChatMessage {
  role: string
  content: string
}

/** One export line for a record, or nothing when the record has no training value. */
export const toTrainingLine = (record: RecordingRecord): Record<string, unknown> | undefined => {
  if (record.outcome !== "ok") return undefined
  const request = (record.request ?? {}) as Record<string, unknown>
  const response = (record.response ?? {}) as Record<string, unknown>
  switch (record.route) {
    case "chat": {
      const messages = Array.isArray(request.messages)
        ? (request.messages as Array<Partial<ChatMessage>>)
            .filter((m) => typeof m.role === "string" && typeof m.content === "string")
            .map((m) => ({ role: m.role as string, content: m.content as string }))
        : []
      const content = typeof response.content === "string" ? response.content : ""
      if (!messages.length || !content) return undefined
      return { messages: [...messages, { role: "assistant", content }], model: record.model ?? record.alias, key: record.key, at: record.at }
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

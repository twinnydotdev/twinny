import { logger } from "../../../common/logger"
import { TwinnyProvider } from "../../../common/types"
import { InferenceError } from "../errors"
import {
  ChatChunk,
  ChatFinishReason,
  ChatRequest,
  FimChunk,
  FimRequest,
  InferenceCapability,
  InferenceModel,
  InferenceOptions,
  InferenceProvider,
  InferenceUsage
} from "../types"

import { responseError } from "./json-stream"
import { toResponsesInput } from "./responses-input"
import { responseEvents } from "./responses-stream"

const MODELS_URL = "https://api.openai.com/v1/models"
const RESPONSES_URL = "https://api.openai.com/v1/responses"

const COMPLETION_INSTRUCTIONS = [
  "You are an inline code completion engine.",
  "Return only code that belongs at the cursor.",
  "Do not explain the answer and do not use Markdown fences.",
  "Do not repeat existing prefix or suffix.",
  "Prefer the smallest useful continuation.",
  "Respect the language, surrounding style, types, imports and repository context."
].join("\n")

export interface ChatGPTPlanAccess {
  getAccessToken(): Promise<string>
}

let accessFactory: (() => ChatGPTPlanAccess) | undefined

/** Installed by the extension host; the headless gateway never owns OAuth state. */
export const setChatGPTPlanAccessFactory = (
  factory: (() => ChatGPTPlanAccess) | undefined
) => {
  accessFactory = factory
}

export interface ChatGPTPlanEndpoints {
  models?: string
  responses?: string
}

const defaultAccess = (): ChatGPTPlanAccess => {
  if (!accessFactory) {
    throw new InferenceError(
      "authentication",
      "Twinny has no ChatGPT Plan authentication session."
    )
  }
  return accessFactory()
}

const authError = (error: unknown) => {
  if (error instanceof InferenceError) return error
  return new InferenceError(
    "authentication",
    error instanceof Error ? error.message : String(error),
    { cause: error }
  )
}

const completionInput = (request: FimRequest): string => {
  const context = request.context
  if (!context) {
    return [
      "PREFIX",
      "--------",
      request.prefix || request.prompt,
      "--------",
      "",
      "SUFFIX",
      "--------",
      request.suffix || "",
      "--------"
    ].join("\n")
  }

  const sections: string[] = []
  if (context.language) sections.push(`Language: ${context.language}`)
  if (context.fileName) sections.push(`File: ${context.fileName}`)
  if (context.repoName) sections.push(`Repository: ${context.repoName}`)
  if (context.files?.length) {
    sections.push(
      "RELATED CONTEXT",
      ...context.files.map(
        (file) => `--- ${file.name} ---\n${file.text.trimEnd()}`
      )
    )
  }
  sections.push(
    "PREFIX",
    "--------",
    context.prefix,
    "--------",
    "",
    "SUFFIX",
    "--------",
    context.suffix,
    "--------"
  )
  return sections.join("\n\n")
}

const failure = (event: {
  code?: string | null
  response?: { error?: { code?: string; message?: string } | null }
  error?: { code?: string; message?: string }
  message?: string
}) => {
  const problem = event.response?.error || event.error
  const code = problem?.code || event.code || undefined
  const message = problem?.message || event.message || "The response failed."
  const error = new Error(code ? `${code}: ${message}` : message) as Error & {
    code?: string
  }
  error.code = code
  return error
}

export class ChatGPTPlanInferenceProvider implements InferenceProvider {
  public readonly id: string

  constructor(
    private readonly _config: TwinnyProvider,
    private readonly _access?: ChatGPTPlanAccess,
    private readonly _endpoints: ChatGPTPlanEndpoints = {}
  ) {
    this.id = _config.provider
  }

  public capabilities(): InferenceCapability[] {
    return ["fim", "chat"]
  }

  public async models(options?: InferenceOptions): Promise<InferenceModel[]> {
    let token: string
    try {
      token = await (this._access || defaultAccess()).getAccessToken()
    } catch (error) {
      throw authError(error)
    }
    const response = await fetch(this._endpoints.models || MODELS_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: options?.signal
    })
    if (!response.ok) throw await responseError(response)
    const payload = (await response.json()) as {
      models?: Array<{
        slug?: string
        display_name?: string
        visibility?: string
      }>
    }
    return (payload.models || [])
      .filter((model) => model.visibility === "list" && !!model.slug)
      .map((model) => ({
        id: model.slug as string,
        name: model.display_name || (model.slug as string),
        capabilities: ["fim", "chat"] as InferenceCapability[]
      }))
  }

  /**
   * Chat through the same plan-sharing Responses route as FIM. Request
   * policy remains deliberately narrower than the API-key adapter: the
   * subscription route has rejected otherwise valid API fields in practice.
   */
  public async *chat(
    request: ChatRequest,
    options?: InferenceOptions
  ): AsyncGenerator<ChatChunk> {
    let token: string
    try {
      token = await (this._access || defaultAccess()).getAccessToken()
    } catch (error) {
      throw authError(error)
    }

    const { instructions, input } = toResponsesInput(request.messages)
    const body = {
      model: request.model || this._config.modelName,
      input,
      ...(instructions ? { instructions } : {}),
      store: false,
      stream: true,
      ...(this._config.reasoningEffort
        ? { reasoning: { effort: this._config.reasoningEffort } }
        : {})
    }
    const response = await fetch(this._endpoints.responses || RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: options?.signal
    })
    if (!response.ok) throw await responseError(response)
    if (!response.body) throw new Error("OpenAI answered without a response stream.")

    // Plan-sharing may report a terminal account or usage failure after
    // sending deltas. Hold everything until response.completed so a failed
    // response cannot become part of the saved conversation.
    const text: string[] = []
    const reasoning: string[] = []
    for await (const event of responseEvents(response.body)) {
      if (options?.signal?.aborted) return
      switch (event.type) {
        case "response.output_text.delta":
        case "response.refusal.delta":
          if (event.delta) text.push(event.delta)
          break
        case "response.reasoning_summary_text.delta":
          if (event.delta) reasoning.push(event.delta)
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
            ...(usage ? { usage } : {})
          }
          return
        }
        case "response.failed":
        case "error":
          throw failure(event)
        case "response.incomplete":
          throw new Error(
            `ChatGPT Plan response was incomplete${event.response?.incomplete_details?.reason ? `: ${event.response.incomplete_details.reason}` : ""}.`
          )
      }
    }
    throw new Error("ChatGPT Plan response ended without response.completed.")
  }

  public async *fim(
    request: FimRequest,
    options?: InferenceOptions
  ): AsyncGenerator<FimChunk> {
    let token: string
    try {
      token = await (this._access || defaultAccess()).getAccessToken()
    } catch (error) {
      throw authError(error)
    }

    const body = {
      model: request.model || this._config.modelName,
      instructions: COMPLETION_INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: completionInput(request)
        }
      ],
      store: false,
      stream: true,
      ...(this._config.reasoningEffort
        ? { reasoning: { effort: this._config.reasoningEffort } }
        : {})
    }

    const started = Date.now()
    let firstDeltaAt: number | undefined
    const response = await fetch(this._endpoints.responses || RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: options?.signal
    })
    if (!response.ok) throw await responseError(response)
    if (!response.body) throw new Error("OpenAI answered without a response stream.")

    const deltas: string[] = []
    for await (const event of responseEvents(response.body)) {
      if (options?.signal?.aborted) return
      switch (event.type) {
        case "response.output_text.delta":
          if (event.delta) {
            if (firstDeltaAt === undefined) {
              firstDeltaAt = Date.now()
              logger.debug(
                `ChatGPT Plan FIM first text in ${firstDeltaAt - started}ms`
              )
            }
            // Plan-sharing streams may emit text before a terminal usage
            // failure. Keep it private until response.completed proves the
            // request succeeded so early consumers cannot accept stale text.
            deltas.push(event.delta)
          }
          break
        case "response.completed": {
          const usage = event.response?.usage
          const text = deltas.join("")
          if (text) yield { text }
          yield {
            text: "",
            ...(usage
              ? {
                  usage: {
                    promptTokens: usage.input_tokens,
                    completionTokens: usage.output_tokens
                  }
                }
              : {})
          }
          logger.debug(
            `ChatGPT Plan FIM completed in ${Date.now() - started}ms`
          )
          return
        }
        case "response.failed":
        case "error":
          throw failure(event)
        case "response.incomplete":
          throw new Error(
            `ChatGPT Plan response was incomplete${event.response?.incomplete_details?.reason ? `: ${event.response.incomplete_details.reason}` : ""}.`
          )
      }
    }
    throw new Error("ChatGPT Plan response ended without response.completed.")
  }
}

import { logger } from "../../../common/logger"
import { TwinnyProvider } from "../../../common/types"
import { getContext } from "../../context"
import {
  ChatGPTPlanSession,
  ChatGPTPlanSessionError
} from "../../chatgpt-plan/session"
import { InferenceError } from "../errors"
import {
  FimChunk,
  FimRequest,
  InferenceCapability,
  InferenceModel,
  InferenceOptions,
  InferenceProvider
} from "../types"

import { responseError } from "./json-stream"
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

const defaultAccess = (): ChatGPTPlanAccess => {
  const context = getContext()
  if (!context) {
    throw new InferenceError(
      "authentication",
      "Twinny has no extension context for ChatGPT Plan authentication."
    )
  }
  return ChatGPTPlanSession.shared(context)
}

const authError = (error: unknown) => {
  if (!(error instanceof ChatGPTPlanSessionError)) return error
  return new InferenceError(
    "authentication",
    error.message,
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
  response?: { error?: { code?: string; message?: string } | null }
  error?: { code?: string; message?: string }
  message?: string
}) => {
  const problem = event.response?.error || event.error
  const code = problem?.code
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
    private readonly _access: ChatGPTPlanAccess = defaultAccess()
  ) {
    this.id = _config.provider
  }

  public capabilities(): InferenceCapability[] {
    return ["fim"]
  }

  public async models(options?: InferenceOptions): Promise<InferenceModel[]> {
    let token: string
    try {
      token = await this._access.getAccessToken()
    } catch (error) {
      throw authError(error)
    }
    const response = await fetch(MODELS_URL, {
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
        capabilities: ["fim"] as InferenceCapability[]
      }))
  }

  public async *fim(
    request: FimRequest,
    options?: InferenceOptions
  ): AsyncGenerator<FimChunk> {
    let token: string
    try {
      token = await this._access.getAccessToken()
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
      stream: true
    }

    const started = Date.now()
    let firstDeltaAt: number | undefined
    const response = await fetch(RESPONSES_URL, {
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

    let completed = false
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
            yield { text: event.delta }
          }
          break
        case "response.completed": {
          completed = true
          const usage = event.response?.usage
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
    if (!completed) {
      throw new Error("ChatGPT Plan response ended without response.completed.")
    }
  }
}

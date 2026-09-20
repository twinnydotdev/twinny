/**
 * What a plugin may ask of the gateway's models: a chat through one of
 * the configured aliases, routed exactly as a developer's request is,
 * and a look at whether developers are using the gateway right now so a
 * background job can stay out of their way. Usage is recorded under the
 * plugin's own principal, so the Usage page shows what plugins cost.
 */
import { toInferenceError } from "../../extension/inference/errors"
import type { ChatMessage } from "../../extension/inference/types"
import type { RouteTable } from "../routes"
import type { UsageRecorder } from "../usage"

export interface PluginChatOptions {
  signal: AbortSignal
  maxTokens?: number
  temperature?: number
  /** `false` asks a reasoning model to answer without thinking first, where the backend allows. */
  think?: boolean
  /** Called with the thinking a reasoning model streams, so a caller can tell "thought" from "silent". */
  onReasoning?: (text: string) => void
}

export interface PluginInference {
  /** The aliases that can chat, as configured right now. */
  chatAliases(): string[]
  /** The aliases that can embed, as configured right now. */
  embeddingAliases(): string[]
  /** One vector per input, through the alias, recorded like any other request. */
  embed(alias: string, inputs: string[], signal: AbortSignal): Promise<number[][]>
  /** Streams the reply's text. Throws an `InferenceError` when the alias cannot answer. */
  chat(
    alias: string,
    messages: ChatMessage[],
    options: PluginChatOptions
  ): AsyncIterable<string>
  /** Developers' requests in flight. Zero means the models are idle. */
  active(): number
}

export interface GatewayInferenceOptions {
  /** The route table in force, read at call time so admin saves apply. */
  routes: () => RouteTable
  active: () => number
  usage?: UsageRecorder
  /** The principal usage is recorded under, e.g. `plugin:github`. */
  principal: string
  /** The gateway's cap on output tokens, when it has one. */
  maxOutputTokens?: () => number | undefined
}

/** The gateway's models, offered to plugins. */
export const gatewayInference = (
  options: GatewayInferenceOptions
): PluginInference => ({
  chatAliases: () =>
    options
      .routes()
      .models()
      .filter((model) => model.capabilities.includes("chat"))
      .map((model) => model.id),
  embeddingAliases: () =>
    options
      .routes()
      .models()
      .filter((model) => model.capabilities.includes("embeddings"))
      .map((model) => model.id),
  active: options.active,
  async embed(alias, inputs, signal) {
    const started = Date.now()
    const target = options.routes().route(alias, "embeddings")
    try {
      const answer = await target.client.embeddings({ model: target.model, input: inputs }, { signal })
      options.usage?.record({
        key: options.principal,
        route: "embeddings",
        alias,
        outcome: "ok",
        status: 200,
        ms: Date.now() - started,
        inputs: inputs.length,
        ...(target.provider ? { peer: target.provider } : {}),
        usage: answer.usage
      })
      return answer.vectors
    } catch (error) {
      const failure = toInferenceError(error)
      options.usage?.record({
        key: options.principal,
        route: "embeddings",
        alias,
        outcome: failure.kind === "cancelled" ? "cancelled" : "error",
        kind: failure.kind,
        status: failure.kind === "cancelled" ? 499 : 502,
        ms: Date.now() - started,
        inputs: inputs.length
      })
      throw failure
    }
  },
  async *chat(alias, messages, chatOptions) {
    const started = Date.now()
    const target = options.routes().route(alias, "chat")
    const cap = options.maxOutputTokens?.()
    const maxTokens =
      cap === undefined
        ? chatOptions.maxTokens
        : Math.min(chatOptions.maxTokens ?? cap, cap)
    let chunks = 0
    let usage: { promptTokens?: number; completionTokens?: number } | undefined
    const record = (
      outcome: "ok" | "error" | "cancelled",
      extra: { kind?: ReturnType<typeof toInferenceError>["kind"]; status: number }
    ) =>
      options.usage?.record({
        key: options.principal,
        route: "chat",
        alias,
        outcome,
        ...(extra.kind ? { kind: extra.kind } : {}),
        status: extra.status,
        ms: Date.now() - started,
        chunks,
        ...(target.provider ? { peer: target.provider } : {}),
        usage
      })
    try {
      const stream = target.client.chat(
        {
          model: target.model,
          messages,
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...(chatOptions.temperature !== undefined
            ? { temperature: chatOptions.temperature }
            : {}),
          ...(chatOptions.think !== undefined ? { think: chatOptions.think } : {})
        },
        { signal: chatOptions.signal }
      )
      for await (const chunk of stream) {
        if (chunk.usage) usage = chunk.usage
        if (chunk.reasoning) chatOptions.onReasoning?.(chunk.reasoning)
        if (!chunk.content) continue
        chunks++
        yield chunk.content
      }
      record("ok", { status: 200 })
    } catch (error) {
      const failure = toInferenceError(error)
      record(failure.kind === "cancelled" ? "cancelled" : "error", {
        kind: failure.kind,
        status: failure.kind === "cancelled" ? 499 : 502
      })
      throw failure
    }
  }
})

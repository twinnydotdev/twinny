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
}

export interface PluginInference {
  /** The aliases that can chat, as configured right now. */
  chatAliases(): string[]
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
  active: options.active,
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
            : {})
        },
        { signal: chatOptions.signal }
      )
      for await (const chunk of stream) {
        if (chunk.usage) usage = chunk.usage
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

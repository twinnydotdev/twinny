/**
 * What a plugin may ask of the gateway's models: a chat through one of
 * the configured aliases, admitted by the same gate as a developer's
 * request (caps, queue, per-key limits, routing rules, output cap,
 * deadline), and a look at whether developers are using the gateway right
 * now so a background job can stay out of their way. Usage is recorded
 * under the plugin's own principal, so the Usage page shows what plugins
 * cost.
 */
import { InferenceError, toInferenceError } from "../../extension/inference/errors"
import type { ChatMessage } from "../../extension/inference/types"
import { type GateRoute, type InferenceGate, refusalError, type Ticket } from "../gate"
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
  /** What the team's routing rules match: the repository's name, as a developer's folder would be. */
  workspace?: string
}

export interface PluginInference {
  /** The aliases that can chat, as configured right now. */
  chatAliases(): string[]
  /** The aliases that can embed, as configured right now. */
  embeddingAliases(): string[]
  /**
   * One vector per input, through the alias, recorded like any other
   * request. `workspace` is what the team's routing rules match.
   */
  embed(alias: string, inputs: string[], signal: AbortSignal, workspace?: string): Promise<number[][]>
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
  /** The gate every model call goes through. */
  gate: () => InferenceGate
  usage?: UsageRecorder
  /** The principal usage is recorded under, e.g. `plugin:github`. */
  principal: string
}

/**
 * What the routing rules match for a repository: its name without the
 * owner or group (`acme/payments-api` → `payments-api`), which is the
 * folder a developer clones it into and so the workspace their own
 * requests name.
 */
export const repoWorkspace = (fullName: string): string =>
  fullName.replace(/\.git$/, "").split("/").filter(Boolean).pop() ?? fullName

/** Aborted when either is; `dispose` lets go of a long-lived caller signal. */
const either = (a: AbortSignal, b: AbortSignal) => {
  const controller = new AbortController()
  const onA = () => controller.abort(a.reason)
  const onB = () => controller.abort(b.reason)
  if (a.aborted) onA()
  else if (b.aborted) onB()
  a.addEventListener("abort", onA)
  b.addEventListener("abort", onB)
  return {
    signal: controller.signal,
    dispose: () => {
      a.removeEventListener("abort", onA)
      b.removeEventListener("abort", onB)
    }
  }
}

/** A ticket from the gate, or the error the plugin's caller sees. */
const admit = async (
  options: GatewayInferenceOptions,
  route: GateRoute,
  signal: AbortSignal,
  workspace: string | undefined
): Promise<Ticket> => {
  const admission = await options.gate().admit({
    principal: options.principal,
    route,
    routes: options.routes(),
    workspace,
    background: true,
    signal
  })
  if (admission.kind === "admitted") return admission.ticket
  if (admission.kind === "gone") throw new InferenceError("cancelled", "The request was cancelled.")
  throw refusalError(admission)
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
  active: () => options.gate().developerActive,
  async embed(alias, inputs, callerSignal, workspace) {
    const started = Date.now()
    const ticket = await admit(options, "embeddings", callerSignal, workspace)
    const { signal, dispose } = either(callerSignal, ticket.signal)
    try {
      const target = ticket.route(alias, "embeddings")
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
    } finally {
      dispose()
      ticket.finish()
    }
  },
  async *chat(alias, messages, chatOptions) {
    const started = Date.now()
    const ticket = await admit(options, "chat", chatOptions.signal, chatOptions.workspace)
    const { signal, dispose } = either(chatOptions.signal, ticket.signal)
    try {
      // The ticket's route applies the routing rules and the output cap.
      const target = ticket.route(alias, "chat")
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
            ...(chatOptions.maxTokens !== undefined ? { maxTokens: chatOptions.maxTokens } : {}),
            ...(chatOptions.temperature !== undefined
              ? { temperature: chatOptions.temperature }
              : {}),
            ...(chatOptions.think !== undefined ? { think: chatOptions.think } : {})
          },
          { signal }
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
    } finally {
      dispose()
      ticket.finish()
    }
  }
})

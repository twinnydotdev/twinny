/**
 * A chat client whose `chat()` lets the model use tools before it answers.
 * Everything above it (the streaming reply, the stop button, error
 * reporting) sees one ordinary stream: the model's prose, a line per tool
 * it used when the host wants those, then the answer.
 *
 * Two ways of calling: `native` sends the tools through the server's own
 * tool-calling, and falls back to `text` when the server or model refuses
 * them; `text` asks for calls written in the reply (see `protocol.ts`) and
 * works through anything that carries chat.
 *
 * The loop also keeps the conversation inside the model's context (see
 * `budget.ts`): each result is held to a share of it, and when a request
 * would not fit, the oldest results are trimmed first.
 *
 * Wrap the client `resolveInferenceProvider` returns, so tool results go
 * through the secret shield like the rest of the conversation.
 */
import { API_PROVIDERS, ASSISTANT, OPEN_AI_COMPATIBLE_PROVIDERS, SYSTEM, USER } from "../../common/constants"
import { HOSTED_PROVIDERS } from "../../common/provider-validation"
import {
  ChatChunk,
  ChatFinishReason,
  ChatMessage,
  ChatRequest,
  ChatToolCall,
  InferenceClient,
  InferenceError,
  InferenceOptions,
  isCancelled
} from "../inference"
import { hostedTakesTools } from "../inference/adapters/fluency"

import { ContextPlan, fitResult, planContext, TokenEstimator, trimmedResult } from "./budget"
import {
  displayableLength,
  FINAL_ANSWER_PROMPT,
  findToolCall,
  FoundCall,
  nameArguments,
  ToolCall,
  toolDefinition,
  toolInstructions,
  toolResultMessage
} from "./protocol"
import { ToolResult, WorkspaceTools } from "./workspace"

export const DEFAULT_MAX_STEPS = 12
/** Calls run from one native reply; a model that fans out wider is told which were left. */
const MAX_CALLS_PER_REPLY = 8

export type ToolMode = "native" | "text"

/**
 * Servers reached through the OpenAI-compatible route, where `tools` goes
 * to the server as sent (a paired device's Ollama included: the request is
 * relayed to it untouched), OpenAI itself, and a team gateway. QVAC's
 * server has no tool-calling, and text-generation-webui's is patchy.
 */
const NATIVE_TOOL_KINDS = new Set<string>([
  ...Object.values(OPEN_AI_COMPATIBLE_PROVIDERS).filter(
    (kind) =>
      kind !== OPEN_AI_COMPATIBLE_PROVIDERS.Qvac &&
      kind !== OPEN_AI_COMPATIBLE_PROVIDERS.Oobabooga
  ),
  API_PROVIDERS.OpenAI,
  // A gateway passes tools on to its backend; one from before it could
  // refuses the field by name, and the loop carries on in text.
  API_PROVIDERS.TwinnyRemote
])

/**
 * How to offer tools to a provider of this kind; `native` falls back to
 * text when refused. Hosted APIs go native when fluency.js can pass tools
 * to them (Anthropic, Gemini, Mistral, Groq, OpenRouter…).
 */
export const toolModeFor = (providerKind: string): ToolMode =>
  NATIVE_TOOL_KINDS.has(providerKind) ||
  (HOSTED_PROVIDERS.includes(providerKind) && hostedTakesTools(providerKind))
    ? "native"
    : "text"

/** One tool the model used, for the chat's steps, logs and the eval. */
export interface ToolStep {
  /** Unique within the reply; the same in `onToolStart` and `onStep`. */
  id: string
  index: number
  mode: ToolMode
  name?: string
  args?: Record<string, string>
  /** Set when the call could not be read. */
  parseError?: string
  summary: string
  /** What the model was given back. */
  output: string
  /** The tool refused or the call went wrong (a bad path, a failing command). */
  failed?: boolean
  /** Characters of conversation sent for the request that asked for this call. */
  promptChars: number
}

/** A call about to run, for hosts that show it while it does. */
export interface ToolStart {
  id: string
  name: string
  args: Record<string, string>
}

/** What a reply's requests cost, as far as the server counted. */
export interface ToolLoopUsage {
  /** The largest prompt of the reply: how much of the context it came to use. */
  promptTokens?: number
  /** Every request's output together. */
  completionTokens?: number
}

export interface ToolLoopOptions {
  mode?: ToolMode
  maxSteps?: number
  /**
   * Tokens the model's context holds, asked before each request: a local
   * server knows only once the model is loaded. Unknown leaves the
   * conversation untrimmed.
   */
  contextWindow?(): Promise<number | undefined> | number | undefined
  /**
   * Whether the reply text carries a `> summary` line per call. On by
   * default; a host that shows the steps itself turns it off.
   */
  stepLines?: boolean
  /**
   * Asked of every request; dropped for the rest of the reply if the model
   * refuses it (models that do not reason).
   */
  reasoningEffort?: ChatRequest["reasoningEffort"]
  /** Called before each call runs. */
  onToolStart?(start: ToolStart): void
  onStep?(step: ToolStep): void
  /** Called once per request with the characters it sends and what they are estimated to be in tokens. */
  onRequest?(promptChars: number, step: number, mode: ToolMode, estimatedTokens: number): void
  /** Called after each request the server counted. */
  onUsage?(usage: ToolLoopUsage): void
  /** Called when native tool-calling, or the reasoning effort, was refused and the loop carried on without it. */
  onFallback?(reason: string, what: "tools" | "reasoning-effort"): void
  /** Called when old results were trimmed so the next request fits. */
  onTrim?(results: number, estimatedTokens: number): void
  /**
   * Called when the reply ends, however it ends, with the calls made and
   * what they returned, cut to size: kept with the reply so the next turn
   * still has them. Undefined when no tool ran.
   */
  onNotes?(notes: string | undefined): void
  /** Called last, when the reply is over or was stopped. */
  onEnd?(): void
}

const clipTo = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}… (cut)` : text

const textOf = (content: ChatMessage["content"]): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
      : ""

type NativeCall = { id: string; type: "function"; function: { name: string; arguments: string } }

const callsOf = (message: ChatMessage): NativeCall[] =>
  (message as { tool_calls?: NativeCall[] }).tool_calls ?? []

const charsOf = (messages: ChatMessage[]) =>
  messages.reduce(
    (sum, m) =>
      sum +
      textOf(m.content).length +
      callsOf(m).reduce((n, c) => n + c.function.name.length + c.function.arguments.length, 0),
    0
  )

/** The conversation with the tool section added to its system prompt. */
const withToolPrompt = (messages: ChatMessage[], section: string): ChatMessage[] => {
  const [first, ...rest] = messages
  if (first?.role === SYSTEM) {
    return [{ role: SYSTEM, content: `${textOf(first.content).trim()}\n\n${section}` }, ...rest]
  }
  return [{ role: SYSTEM, content: section }, ...messages]
}

/**
 * The conversation with the last request's instruction at its end: in the
 * user's turn when that is where it stops (a text-mode result), since
 * some servers refuse two user turns in a row; as a turn of its own after
 * a native tool result.
 */
const withClosingPrompt = (messages: ChatMessage[]): ChatMessage[] => {
  const final = messages[messages.length - 1]
  return final?.role === USER && typeof final.content === "string"
    ? [...messages.slice(0, -1), { ...final, content: `${final.content}\n\n${FINAL_ANSWER_PROMPT}` }]
    : [...messages, { role: USER, content: FINAL_ANSWER_PROMPT }]
}

const stepLine = (summary: string) => `> ${summary}\n\n`

/** What goes between text already shown and a step line, so each line is its own paragraph. */
const gapAfter = (shown: string) =>
  !shown.trim() || shown.endsWith("\n\n") ? "" : shown.endsWith("\n") ? "\n" : "\n\n"

/** A refusal that names tools or function calling, as opposed to any other failure. */
const mentionsTools = (error: unknown) =>
  !isCancelled(error) && error instanceof Error && /\btools?\b|function.?call/i.test(error.message)

/** A model that does not take a reasoning effort, as opposed to one that will not mix it with tools. */
const refusesReasoningEffort = (error: unknown) =>
  !isCancelled(error) &&
  error instanceof Error &&
  /reasoning[._ ]?effort/i.test(error.message) &&
  !/function tools|\btools\b/i.test(error.message)

const cancelled = (reason?: unknown) =>
  new InferenceError("cancelled", "The request was cancelled.", { cause: reason })

/** Native arguments as the tools take them, or why they could not be read. */
const parseArguments = (call: ChatToolCall): ToolCall | string => {
  if (!call.arguments.trim()) return { name: call.name, args: {} }
  try {
    const parsed = JSON.parse(call.arguments)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "the arguments were not an object"
    return {
      name: call.name,
      args: Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])
      )
    }
  } catch {
    return "the arguments were not valid JSON"
  }
}

const parsedOr = (json: string): unknown => {
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

/**
 * A native tool conversation said in plain messages: each call as the
 * text protocol writes it, each result as a user turn. For the one server
 * that will not take tool history without the tools declared beside it.
 */
export const flattenToolHistory = (messages: ChatMessage[]): ChatMessage[] => {
  const names = new Map<string, string>()
  const flat: { role: string; content: ChatMessage["content"]; own: boolean }[] = []
  const add = (role: string, content: string) => {
    const previous = flat[flat.length - 1]
    if (previous?.own && previous.role === role) previous.content = `${previous.content}\n\n${content}`
    else flat.push({ role, content, own: true })
  }
  for (const message of messages) {
    const calls = callsOf(message)
    if (message.role === ASSISTANT && calls.length) {
      for (const call of calls) names.set(call.id, call.function.name)
      add(
        ASSISTANT,
        [
          textOf(message.content).trim(),
          ...calls.map(
            (call) =>
              "```tool\n" +
              JSON.stringify({ name: call.function.name, arguments: parsedOr(call.function.arguments) }) +
              "\n```"
          )
        ]
          .filter(Boolean)
          .join("\n")
      )
    } else if (message.role === "tool") {
      const id = (message as { tool_call_id?: string }).tool_call_id ?? ""
      add(USER, toolResultMessage(names.get(id) ?? "tool", textOf(message.content)))
    } else {
      flat.push({ role: message.role, content: message.content, own: false })
    }
  }
  return flat.map(({ role, content }) => ({ role, content }) as ChatMessage)
}

/** A call the model made, in either mode, with what the conversation records of it. */
interface PendingCall {
  /** The native call as it goes back to the server; absent in text mode. */
  raw?: ChatToolCall
  call?: ToolCall
  error?: string
}

/** A result in the conversation, so it can be trimmed later. */
interface ResultSlot {
  message: number
  step: number
  name: string
  trimmed: boolean
}

class ToolLoop {
  private _mode: ToolMode
  private _effort: ChatRequest["reasoningEffort"]
  private _messages: ChatMessage[] = []
  private _results: ResultSlot[] = []
  /** Everything yielded so far, for spacing the step lines. */
  private _shown = ""
  /** Each call and what it returned, for the next turn's notes. */
  private _record: { name: string; args: Record<string, string>; output: string }[] = []
  private _plan?: ContextPlan
  private readonly _estimator = new TokenEstimator()
  private readonly _usage: ToolLoopUsage = {}
  private _flattened = false

  constructor(
    private readonly _client: InferenceClient,
    private readonly _workspace: WorkspaceTools,
    private readonly _options: ToolLoopOptions
  ) {
    this._mode = _options.mode ?? "text"
    this._effort = _options.reasoningEffort
  }

  async *run(request: ChatRequest, options?: InferenceOptions): AsyncGenerator<ChatChunk> {
    try {
      yield* this.steps(request, options)
    } finally {
      // However the reply ends (answered, stopped, failed), what the tools
      // did is kept for the next turn and the host is told it is over.
      this._options.onNotes?.(this.notes())
      this._options.onEnd?.()
    }
  }

  private prompt(request: ChatRequest) {
    return withToolPrompt(
      request.messages,
      toolInstructions(this._workspace.tools, this._workspace.orientation, this._mode === "native")
    )
  }

  private async *steps(request: ChatRequest, options?: InferenceOptions): AsyncGenerator<ChatChunk> {
    const maxSteps = this._options.maxSteps ?? DEFAULT_MAX_STEPS
    const outer = options?.signal
    const definitions = this._workspace.tools.map(toolDefinition)
    const definitionChars = JSON.stringify(definitions).length
    this._messages = this.prompt(request)

    // Set once a tool's result says to answer now (an edit waits for review).
    let settled = false
    for (let step = 0; ; step++) {
      const last = settled || step >= maxSteps
      const native = this._mode === "native"
      // The last request offers nothing to call, so the model answers.
      const tools = native && !last ? definitions : undefined
      const closing = last && !settled

      await this.fit((tools ? definitionChars : 0) + (closing ? FINAL_ANSWER_PROMPT.length : 0))
      const sent = closing ? withClosingPrompt(this._messages) : this._messages
      const promptChars = charsOf(sent) + (tools ? definitionChars : 0)
      this._options.onRequest?.(promptChars, step, this._mode, this._estimator.tokens(promptChars))

      // A step of our own to cut short when a text call closes, without it
      // looking like the user pressed stop.
      const stepAbort = new AbortController()
      const forward = () => stepAbort.abort(outer?.reason)
      if (outer?.aborted) forward()
      else outer?.addEventListener("abort", forward, { once: true })

      const reply = { text: "", shown: 0, toolCalls: undefined as ChatToolCall[] | undefined }
      let found: FoundCall | undefined
      let finishReason: ChatFinishReason | undefined
      let promptTokens: number | undefined
      let completionTokens: number | undefined
      try {
        const chunks = this._client.chat(
          {
            ...request,
            messages: sent,
            ...(this._effort ? { reasoningEffort: this._effort } : {}),
            ...(tools ? { tools } : {})
          },
          { ...options, signal: stepAbort.signal }
        )
        for await (const chunk of chunks) {
          reply.text += chunk.content
          if (chunk.toolCalls) reply.toolCalls = [...(reply.toolCalls ?? []), ...chunk.toolCalls]
          if (chunk.usage?.promptTokens) promptTokens = chunk.usage.promptTokens
          if (chunk.usage?.completionTokens) completionTokens = chunk.usage.completionTokens
          if (chunk.finishReason) finishReason = chunk.finishReason
          // Native mode reads text calls too: qwen3-coder sometimes writes its
          // own call syntax as prose, and Ollama passes it through untouched.
          if (!last) {
            found = findToolCall(reply.text)
            if (found) break
          }
          // A call's opening is held back in every case; on the last request
          // one may still come, and it is never shown.
          const safe = displayableLength(reply.text)
          if (safe > reply.shown) {
            yield this.show(reply.text.slice(reply.shown, safe))
            reply.shown = safe
          }
        }
      } catch (error) {
        if (outer?.aborted) throw error
        if (this._effort && !reply.text && refusesReasoningEffort(error)) {
          this._options.onFallback?.((error as Error).message, "reasoning-effort")
          this._effort = undefined
          step--
          continue
        }
        if (native && !reply.text && mentionsTools(error)) {
          // Refused before any tool ran: the server or model has no native
          // tool-calling, and the text protocol takes over.
          if (!this._results.length) {
            this._options.onFallback?.((error as Error).message, "tools")
            this._mode = "text"
            this._messages = this.prompt(request)
            step--
            continue
          }
          // Refused on the last request, which carries tool history but no
          // tools: say the history in plain messages instead, once.
          if (last && !this._flattened) {
            this._flattened = true
            this._messages = flattenToolHistory(this._messages)
            this._results = []
            this._mode = "text"
            step--
            continue
          }
        }
        if (!isCancelled(error)) throw error
      } finally {
        outer?.removeEventListener("abort", forward)
        stepAbort.abort()
      }

      this.count(promptChars, promptTokens, completionTokens)

      const nativeCalls = native && !last ? this.nativeCalls(reply.toolCalls) : []
      if (!nativeCalls.length) found ??= findToolCall(reply.text, true)
      const calls = nativeCalls.length ? nativeCalls : last ? [] : this.textCall(found, reply, step)

      if (!calls.length) {
        // The answer. A call written on the last request is never run and
        // never shown; anything else held back was prose after all.
        const end = last && found ? found.start : reply.text.length
        if (end > reply.shown) yield this.show(reply.text.slice(reply.shown, end))
        if (!this._shown.trim() && this._record.length) {
          yield this.show(
            last
              ? "I ran out of tool steps for this reply before I could finish. Ask me to continue and I will carry on from here."
              : "The model finished without writing a reply; the steps above show what it did."
          )
        }
        const usage = this._usage.promptTokens || this._usage.completionTokens ? { ...this._usage } : undefined
        if (usage || finishReason) {
          yield { content: "", ...(usage ? { usage } : {}), ...(finishReason ? { finishReason } : {}) }
        }
        return
      }

      if (found && found.start > reply.shown) {
        yield this.show(reply.text.slice(reply.shown, found.start))
      }
      const results: ToolResult[] = []
      for (const [i, pending] of calls.entries()) {
        const id = `${step}.${i}`
        const name = pending.call?.name ?? pending.raw?.name ?? "unknown"
        this._options.onToolStart?.({ id, name, args: pending.call?.args ?? {} })
        const ran: ToolResult = pending.call
          ? await this.runCall(pending.call, outer)
          : {
              output:
                `Your tool call could not be read: ${pending.error}.` +
                (native
                  ? ""
                  : " Write it exactly like this, as JSON:\n```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"src/index.ts\"}}\n```"),
              summary: `tool call not understood · ${pending.error}`,
              failed: true
            }
        const left = (reply.toolCalls?.length ?? 0) - calls.length
        const note =
          left > 0 && i === calls.length - 1
            ? `\n(${left} more ${left === 1 ? "call" : "calls"} in the same reply ${left === 1 ? "was" : "were"} not run; make ${left === 1 ? "it" : "them"} again if still needed.)`
            : ""
        const result: ToolResult = {
          ...ran,
          output: (this._plan ? fitResult(ran.output, this._plan.resultChars) : ran.output) + note || "(no output)"
        }
        results.push(result)
        this._record.push({ name, args: pending.call?.args ?? {}, output: result.output })
        this._options.onStep?.({
          id,
          index: step,
          mode: this._mode,
          name: pending.call?.name ?? pending.raw?.name,
          args: pending.call?.args,
          parseError: pending.error,
          summary: result.summary,
          output: result.output,
          failed: result.failed,
          promptChars
        })
        if (this._options.stepLines !== false) {
          yield this.show(`${gapAfter(this._shown)}${stepLine(result.summary)}`)
        }
      }
      this.remember(calls, results, reply.text, found, step)
      settled = results.some((result) => result.final)
    }
  }

  /** A tool's result, or a cancellation the moment the user stops the reply: no tool is waited on past that. */
  private async runCall(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const work = this._workspace.run(call, { signal })
    if (!signal) return work
    work.catch(() => undefined)
    if (signal.aborted) throw cancelled(signal.reason)
    let onAbort = () => undefined as void
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(cancelled(signal.reason))
      signal.addEventListener("abort", onAbort, { once: true })
    })
    stopped.catch(() => undefined)
    try {
      return await Promise.race([work, stopped])
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
  }

  /** What the server counted for a request: corrects the estimates and adds to the reply's totals. */
  private count(promptChars: number, promptTokens?: number, completionTokens?: number) {
    this._estimator.observe(promptChars, promptTokens)
    if (!promptTokens && !completionTokens) return
    if (promptTokens) this._usage.promptTokens = Math.max(this._usage.promptTokens ?? 0, promptTokens)
    if (completionTokens) this._usage.completionTokens = (this._usage.completionTokens ?? 0) + completionTokens
    this._options.onUsage?.({ ...this._usage })
  }

  /**
   * Before a request: if it would not fit the model's context, trim tool
   * results out of the conversation, oldest first and the newest step's
   * last, until it is comfortably inside.
   */
  private async fit(extraChars: number) {
    let window: number | undefined
    try {
      window = await this._options.contextWindow?.()
    } catch {
      window = undefined
    }
    this._plan = window && window > 0 ? planContext(window) : undefined
    const plan = this._plan
    if (!plan) return
    const estimate = () => this._estimator.tokens(charsOf(this._messages) + extraChars)
    if (estimate() <= plan.limit) return
    const newest = this._results.length ? this._results[this._results.length - 1].step : 0
    const passes: Array<(slot: ResultSlot) => boolean> = [
      (slot) => slot.step < newest - 1,
      (slot) => slot.step < newest,
      () => true
    ]
    let trimmed = 0
    for (const eligible of passes) {
      for (const slot of this._results) {
        if (slot.trimmed || !eligible(slot)) continue
        if (estimate() <= plan.target) break
        this.trim(slot)
        trimmed++
      }
      if (estimate() <= plan.limit) break
    }
    if (trimmed) this._options.onTrim?.(trimmed, estimate())
  }

  private trim(slot: ResultSlot) {
    const message = this._messages[slot.message]
    if (!message) return
    const text = textOf(message.content)
    this._messages[slot.message] = (
      message.role === "tool"
        ? { ...message, content: trimmedResult(text) }
        : {
            ...message,
            content: toolResultMessage(
              slot.name,
              trimmedResult(text.replace(/^<tool_result[^>]*>\n/, "").replace(/\n<\/tool_result>$/, ""))
            )
          }
    ) as ChatMessage
    slot.trimmed = true
  }

  /** The calls made and what they returned, cut to a size worth carrying into the next turn. */
  private notes(): string | undefined {
    if (!this._record.length) return undefined
    const budget = this._plan?.notesChars ?? 6000
    const each = Math.max(200, Math.min(1200, Math.floor(budget / this._record.length) - 100))
    const blocks = this._record.map(
      ({ name, args, output }) => `${name} ${clipTo(JSON.stringify(args), 240)}\n${clipTo(output, each)}`
    )
    // The latest calls say where the work stands; when not all fit, they stay.
    while (blocks.length > 1 && blocks.join("\n\n").length > budget) blocks.shift()
    return clipTo(blocks.join("\n\n"), budget)
  }

  private show(content: string): ChatChunk {
    this._shown += content
    return { content }
  }

  private nativeCalls(toolCalls: ChatToolCall[] | undefined): PendingCall[] {
    return (toolCalls ?? []).slice(0, MAX_CALLS_PER_REPLY).map((raw) => {
      const call = parseArguments(raw)
      // What goes back to the server must parse there too: fluency.js and
      // Ollama both read the arguments as JSON.
      return typeof call === "string" ? { raw: { ...raw, arguments: "{}" }, error: call } : { raw, call }
    })
  }

  private textCall(found: FoundCall | undefined, reply: { text: string }, step: number): PendingCall[] {
    if (!found) return []
    if (found.call) found.call = nameArguments(found.call, this._workspace.tools)
    if (this._mode === "native") {
      // Carried on as a native call, so the conversation stays in one form.
      reply.text = reply.text.slice(0, found.start).trimEnd()
      const raw = {
        id: `call_text_${step}`,
        name: found.call?.name ?? "unknown",
        arguments: JSON.stringify(found.call?.args ?? {})
      }
      return [{ raw, call: found.call, error: found.error }]
    }
    // Only what the model wrote up to the end of its call goes back to it.
    reply.text = reply.text.slice(0, found.end)
    return [{ call: found.call, error: found.error }]
  }

  /** The reply that made the calls, and their results, join the conversation. */
  private remember(
    calls: PendingCall[],
    results: ToolResult[],
    text: string,
    found: FoundCall | undefined,
    step: number
  ) {
    const slot = (name: string): ResultSlot => ({ message: this._messages.length, step, name, trimmed: false })
    if (this._mode === "native") {
      this._messages.push({
        role: ASSISTANT,
        // A reply that is only calls has no text: null, not "", since
        // Anthropic refuses an empty text block.
        content: text.trim() ? text : null,
        tool_calls: calls.map(({ raw }) => ({
          id: raw!.id,
          type: "function" as const,
          function: { name: raw!.name, arguments: raw!.arguments }
        }))
      } as ChatMessage)
      calls.forEach(({ raw }, i) => {
        this._results.push(slot(raw!.name))
        this._messages.push({ role: "tool", tool_call_id: raw!.id, content: results[i].output } as ChatMessage)
      })
      return
    }
    const name = calls[0].call?.name ?? "error"
    // A call read before its closing marker arrived is recorded closed.
    this._messages.push({ role: ASSISTANT, content: found?.unclosed ? `${text.trimEnd()}\n${found.unclosed}` : text })
    this._results.push(slot(name))
    this._messages.push({ role: USER, content: toolResultMessage(name, results[0].output) })
  }
}

/** `client`, with the workspace's tools available to `chat()`. */
export const withTools = (
  client: InferenceClient,
  workspace: WorkspaceTools,
  options: ToolLoopOptions = {}
): InferenceClient => ({
  id: client.id,
  capabilities: () => client.capabilities(),
  models: (o) => client.models(o),
  fim: (request, o) => client.fim(request, o),
  embeddings: (request, o) => client.embeddings(request, o),
  chat: (request, o) => new ToolLoop(client, workspace, options).run(request, o)
})

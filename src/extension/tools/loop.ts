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
import { API_PROVIDERS, ASSISTANT, DEFAULT_AGENT_STEPS, OPEN_AI_COMPATIBLE_PROVIDERS, SYSTEM, USER } from "../../common/constants"
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
import { instructionsSection } from "./instructions"
import {
  displayableLength,
  FINAL_ANSWER_PROMPT,
  findToolCall,
  FoundCall,
  nameArguments,
  parseLenientJson,
  ToolCall,
  toolDefinition,
  toolInstructions,
  toolResultMessage
} from "./protocol"
import { ToolResult, WorkspaceTools } from "./workspace"

export const DEFAULT_MAX_STEPS = DEFAULT_AGENT_STEPS
/** Calls run from one native reply; a model that fans out wider is told which were left. */
const MAX_CALLS_PER_REPLY = 8
/** A result keeps at least this much of its output, whatever comes ahead of it. */
const MIN_RESULT_CHARS = 1000
/** Calls repeated in one reply, or requests in a row of calls that cannot be read, before the model is asked to answer. */
const MAX_REPEATED_CALLS = 3
const MAX_UNREADABLE_IN_A_ROW = 3

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
   * Asked before each request after the first: messages the user sent
   * while the reply was working, handed over (and so taken) for the
   * model to read before its next step. A message never asked for, because
   * the model answered first, stays the host's to send as a turn of its own.
   */
  steering?(): string[]
  /** Called when the reply ended because it used every tool step it had, with the work maybe unfinished. */
  onOutOfSteps?(): void
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

/** How messages the user sent mid-reply reach the model, in its next request. */
export const steeringMessage = (said: string[]) =>
  [
    `While you were working, the user wrote${said.length > 1 ? " these messages" : ""}:`,
    ...said.map((text) => `\n${text}`),
    "\nTake that into account and carry on."
  ].join("\n")

/**
 * A reply with its tool calls taken out, for the last request, whose
 * calls are never run: the text before the first call, and each piece
 * of prose after one.
 */
const withoutCalls = (text: string): { lead: string; after: string[] } => {
  const pieces: string[] = []
  let rest = text
  for (let found = findToolCall(rest, true); found; found = findToolCall(rest, true)) {
    pieces.push(rest.slice(0, found.start))
    rest = rest.slice(found.end)
  }
  const [lead, ...after] = [...pieces, rest]
  return { lead: lead.trimEnd(), after: after.map((piece) => piece.trim()).filter(Boolean) }
}

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

/**
 * Native arguments as the tools take them, or why they could not be read.
 * A server that passes the model's JSON on as it was written (llama.cpp,
 * vLLM) passes on its slips too, and they are mended the same way as in
 * a text call.
 */
const parseArguments = (call: ChatToolCall): ToolCall | { error: string; detail?: string } => {
  if (!call.arguments.trim()) return { name: call.name, args: {} }
  const parsed = parseLenientJson(call.arguments)
  if ("error" in parsed) return { error: "the arguments were not valid JSON", detail: parsed.error }
  const { value } = parsed
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "the arguments were not an object" }
  return {
    name: call.name,
    args: Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])
    )
  }
}

/** Characters of an unreadable call quoted back to the model, so it can see what went wrong. */
const MAX_QUOTED_CALL = 600

/**
 * What the model is told about a call it wrote that could not be read:
 * why, in the parser's words when it had some, what it wrote, and the
 * form that works.
 */
export const unreadableCallMessage = (pending: { error?: string; detail?: string; written?: string }, native: boolean) => {
  const why = `Your tool call could not be read: ${pending.error}${pending.detail ? ` (${pending.detail})` : ""}.`
  const written = pending.written?.trim()
  const quoted = written
    ? `\nYou wrote:\n~~~\n${written.length > MAX_QUOTED_CALL ? `${written.slice(0, MAX_QUOTED_CALL)}… (${written.length - MAX_QUOTED_CALL} more characters)` : written}\n~~~`
    : ""
  const form = native
    ? ""
    : "\nWrite it exactly like this, as JSON, with line breaks inside strings written as \\n:\n```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"src/index.ts\"}}\n```"
  return `${why}${quoted}${form}`
}

/** Whether `text` is JSON as written, or empty (no arguments). */
const strictJson = (text: string) => {
  if (!text.trim()) return true
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
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
  /** What the parser said, and what the model wrote, when the call could not be read. */
  detail?: string
  written?: string
}

/** A result in the conversation, so it can be trimmed later. */
interface ResultSlot {
  message: number
  step: number
  name: string
  trimmed: boolean
  /** A folder's instructions ahead of the output: kept when the output is trimmed. */
  preface?: string
  /** What follows the result in its message (the user's words mid-reply, in text mode): kept when it is trimmed. */
  after?: string
}

class ToolLoop {
  private _mode: ToolMode
  private _effort: ChatRequest["reasoningEffort"]
  private _messages: ChatMessage[] = []
  private _results: ResultSlot[] = []
  /** Everything yielded so far, for spacing the step lines. */
  private _shown = ""
  /** Each call and what it returned, and what the user said along the way, for the next turn's notes. */
  private _record: ({ name: string; args: Record<string, string>; output: string } | { said: string })[] = []
  private _plan?: ContextPlan
  private readonly _estimator = new TokenEstimator()
  private readonly _usage: ToolLoopUsage = {}
  private _flattened = false
  /**
   * Read-only calls answered so far, by name and arguments, since the
   * workspace last changed: one asked again gets a pointer to its result
   * rather than the same output twice.
   */
  private readonly _answered = new Map<string, { summary: string; slot?: ResultSlot }>()
  /** Calls not run because they repeated one already answered. */
  private _repeats = 0
  /** Requests in a row whose every call could not be read. */
  private _unreadable = 0
  /** Set when the model goes round in circles: the next request asks for its answer. */
  private _stuck = false

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
    const { tools, orientation, instructions } = this._workspace
    return withToolPrompt(
      request.messages,
      [toolInstructions(tools, orientation, this._mode === "native"), ...(instructions ? [instructionsSection(instructions)] : [])].join("\n\n")
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
      if (step > 0) this.steer()
      const last = settled || this._stuck || step >= maxSteps
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
            this._answered.clear()
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
      // What the model wrote, before a text call is cut out of it for the
      // conversation: the prose ahead of the call is shown from this.
      const written = reply.text
      const calls = nativeCalls.length ? nativeCalls : last ? [] : this.textCall(found, reply, step)

      if (!calls.length) {
        // The answer. A call written on the last request is never run and
        // never shown, but what the model wrote after it is; anything else
        // held back was prose after all.
        if (last && found) {
          const { lead, after } = withoutCalls(written.slice(reply.shown))
          if (lead) yield this.show(lead)
          for (const piece of after) yield this.show(`${gapAfter(this._shown)}${piece}`)
        } else if (written.length > reply.shown) {
          yield this.show(written.slice(reply.shown))
        }
        if (!this._shown.trim() && this._record.length) {
          yield this.show(
            settled
              ? "The change is waiting in the editor for you to accept or reject."
              : this._stuck
                ? "I was going round in circles with the same tool calls, so I stopped there; the steps above show what I tried."
                : last
                  ? "I ran out of tool steps for this reply before I could finish. Continue, and I will carry on from here."
                  : "The model finished without writing a reply; the steps above show what it did."
          )
        }
        if (last && !settled && !this._stuck && step >= maxSteps) this._options.onOutOfSteps?.()
        const usage = this._usage.promptTokens || this._usage.completionTokens ? { ...this._usage } : undefined
        if (usage || finishReason) {
          yield { content: "", ...(usage ? { usage } : {}), ...(finishReason ? { finishReason } : {}) }
        }
        return
      }

      // Whatever was held back in case it began a call is prose when the
      // calls came another way (natively), and so is all before a text call.
      // Call markup a server left in the text beside its native calls is not prose.
      const markup = found ?? (nativeCalls.length ? findToolCall(written, true) : undefined)
      const proseEnd = markup ? markup.start : written.length
      if (proseEnd > reply.shown) yield this.show(written.slice(reply.shown, proseEnd))
      const results: ToolResult[] = []
      /** Each call's key among the answered ones, when it is a read worth keeping. */
      const keys: (string | undefined)[] = []
      for (const [i, pending] of calls.entries()) {
        const id = `${step}.${i}`
        const name = pending.call?.name ?? pending.raw?.name ?? "unknown"
        this._options.onToolStart?.({ id, name, args: pending.call?.args ?? {} })
        const key = pending.call ? this.answerKey(pending.call) : undefined
        // Anything that may change the workspace makes every earlier read stale.
        if (pending.call && !key) this._answered.clear()
        const earlier = key ? this._answered.get(key) : undefined
        // A result trimmed out of the context is gone from the model's view, and is run again.
        const repeated = earlier && !earlier.slot?.trimmed ? earlier : undefined
        if (repeated) this._repeats++
        const ran: ToolResult = !pending.call
          ? {
              output: unreadableCallMessage(pending, native),
              summary: `tool call not understood · ${pending.error}`,
              failed: true
            }
          : repeated
            ? {
                output:
                  `You already called ${name} with these same arguments in this reply, and nothing in the workspace has changed since, ` +
                  "so it was not run again: its result is above. Use that, or try something different.",
                summary: `${repeated.summary} · repeated, not run again`
              }
            : await this.runCall(pending.call, outer)
        // A read that failed (a search that ran out of time, a language
        // server still starting) is worth trying again, so it is not kept.
        keys.push(repeated || ran.failed ? undefined : key)
        const left = (reply.toolCalls?.length ?? 0) - calls.length
        const note =
          left > 0 && i === calls.length - 1
            ? `\n(${left} more ${left === 1 ? "call" : "calls"} in the same reply ${left === 1 ? "was" : "were"} not run; make ${left === 1 ? "it" : "them"} again if still needed.)`
            : ""
        const { preface } = ran
        // Calls made together share a result's room, so the next request
        // has all of them rather than trimming the ones just asked for.
        const room = this._plan
          ? Math.max(MIN_RESULT_CHARS, Math.floor(this._plan.resultChars / calls.length) - (preface?.length ?? 0))
          : undefined
        const result: ToolResult = {
          ...ran,
          output: (room ? fitResult(ran.output, room) : ran.output) + note || "(no output)"
        }
        // A folder's instructions go ahead of the output, where a cut to
        // fit the context does not reach them; the step shows the output.
        const sent = preface ? { ...result, output: `${preface}\n\n${result.output}` } : result
        results.push(sent)
        // The next turn's notes keep what the tool returned; the folder's
        // instructions come again when that turn's tools reach the folder.
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
      const slots = this.remember(calls, results, reply.text, found, step)
      keys.forEach((key, i) => {
        if (key) this._answered.set(key, { summary: results[i].summary, slot: slots[i] })
      })
      this._unreadable = calls.every((pending) => !pending.call) ? this._unreadable + 1 : 0
      // A small model that keeps asking for what it has, or keeps writing
      // calls that cannot be read, is not getting anywhere with more steps.
      if (this._repeats >= MAX_REPEATED_CALLS || this._unreadable >= MAX_UNREADABLE_IN_A_ROW) this._stuck = true
      settled = results.some((result) => result.final)
    }
  }

  /** A read-only call by its name and arguments, so the same one asked twice is known; undefined for any other call. */
  private answerKey(call: ToolCall): string | undefined {
    if (!this._workspace.tools.find((tool) => tool.name === call.name)?.readOnly) return undefined
    const args = Object.entries(call.args)
      .map(([name, value]) => [name, value.trim()])
      .filter(([, value]) => value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return JSON.stringify([call.name, args])
  }

  /**
   * What the user sent while the reply worked, put where the model reads
   * it next: a turn of its own after native results, the end of the user
   * turn that carries a text-mode result. It goes in the notes too, so the
   * next turn knows what was asked along the way.
   */
  private steer() {
    const said = (this._options.steering?.() ?? []).map((text) => text.trim()).filter(Boolean)
    if (!said.length) return
    const message = steeringMessage(said)
    const at = this._messages.length - 1
    const final = this._messages[at]
    if (this._mode === "text" && final?.role === USER && typeof final.content === "string") {
      this._messages[at] = { ...final, content: `${final.content}\n\n${message}` }
      // The result it follows may be trimmed later; what the user said is not.
      const slot = this._results.find((result) => result.message === at)
      if (slot) slot.after = `${slot.after ?? ""}\n\n${message}`
    } else {
      this._messages.push({ role: USER, content: message })
    }
    for (const text of said) this._record.push({ said: text })
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
    const whole = textOf(message.content)
    const after = slot.after && whole.endsWith(slot.after) ? slot.after : ""
    const text = whole.slice(0, whole.length - after.length)
    const output = message.role === "tool" ? text : text.replace(/^<tool_result[^>]*>\n/, "").replace(/\n<\/tool_result>$/, "")
    // Instructions hold for the whole reply, so they outlast the output they came with.
    const { preface } = slot
    const kept =
      preface && output.startsWith(preface)
        ? `${preface}\n\n${trimmedResult(output.slice(preface.length).trimStart())}`
        : trimmedResult(output)
    this._messages[slot.message] = (
      message.role === "tool" ? { ...message, content: kept } : { ...message, content: toolResultMessage(slot.name, kept) + after }
    ) as ChatMessage
    slot.trimmed = true
  }

  /** The calls made and what they returned, cut to a size worth carrying into the next turn. */
  private notes(): string | undefined {
    if (!this._record.length) return undefined
    const budget = this._plan?.notesChars ?? 6000
    const each = Math.max(200, Math.min(1200, Math.floor(budget / this._record.length) - 100))
    const blocks = this._record.map((entry) =>
      "said" in entry
        ? `The user, while you worked: ${clipTo(entry.said, each)}`
        : `${entry.name} ${clipTo(JSON.stringify(entry.args), 240)}\n${clipTo(entry.output, each)}`
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
      // Ollama both read the arguments as JSON, so mended ones go back mended.
      if ("error" in call) {
        return { raw: { ...raw, arguments: "{}" }, error: call.error, detail: call.detail, written: raw.arguments }
      }
      return { raw: strictJson(raw.arguments) ? raw : { ...raw, arguments: JSON.stringify(call.args) }, call }
    })
  }

  private textCall(found: FoundCall | undefined, reply: { text: string }, step: number): PendingCall[] {
    if (!found) return []
    if (found.call) found.call = nameArguments(found.call, this._workspace.tools)
    const unread = found.call ? {} : { detail: found.detail, written: reply.text.slice(found.start, found.end) }
    if (this._mode === "native") {
      // Carried on as a native call, so the conversation stays in one form.
      reply.text = reply.text.slice(0, found.start).trimEnd()
      const raw = {
        id: `call_text_${step}`,
        name: found.call?.name ?? "unknown",
        arguments: JSON.stringify(found.call?.args ?? {})
      }
      return [{ raw, call: found.call, error: found.error, ...unread }]
    }
    // Only what the model wrote up to the end of its call goes back to it.
    reply.text = reply.text.slice(0, found.end)
    return [{ call: found.call, error: found.error, ...unread }]
  }

  /** The reply that made the calls, and their results, join the conversation. */
  private remember(
    calls: PendingCall[],
    results: ToolResult[],
    text: string,
    found: FoundCall | undefined,
    step: number
  ): ResultSlot[] {
    const slot = (name: string, preface?: string): ResultSlot => ({
      message: this._messages.length,
      step,
      name,
      trimmed: false,
      ...(preface ? { preface } : {})
    })
    const slots: ResultSlot[] = []
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
        slots.push(slot(raw!.name, results[i].preface))
        this._messages.push({ role: "tool", tool_call_id: raw!.id, content: results[i].output } as ChatMessage)
      })
      this._results.push(...slots)
      return slots
    }
    const name = calls[0].call?.name ?? "error"
    // A call read before its closing marker arrived is recorded closed.
    this._messages.push({ role: ASSISTANT, content: found?.unclosed ? `${text.trimEnd()}\n${found.unclosed}` : text })
    slots.push(slot(name, results[0].preface))
    this._results.push(...slots)
    this._messages.push({ role: USER, content: toolResultMessage(name, results[0].output) })
    return slots
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

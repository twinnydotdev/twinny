/**
 * A chat client whose `chat()` lets the model call read-only tools before
 * it answers. Everything above it (the streaming reply, the stop button,
 * error reporting) sees one ordinary stream: the model's prose, a line per
 * tool it used, then the answer.
 *
 * Two ways of calling: `native` sends the tools through the server's own
 * tool-calling (OpenAI-compatible routes), and falls back to `text` when
 * the server or model refuses them; `text` asks for calls written in the
 * reply (see `protocol.ts`) and works through anything that carries chat.
 *
 * Wrap the client `resolveInferenceProvider` returns, so tool results go
 * through the secret shield like the rest of the conversation.
 */
import { API_PROVIDERS, ASSISTANT, OPEN_AI_COMPATIBLE_PROVIDERS, SYSTEM, USER } from "../../common/constants"
import { HOSTED_PROVIDERS } from "../../common/provider-validation"
import {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatToolCall,
  InferenceClient,
  InferenceOptions,
  isCancelled
} from "../inference"
import { hostedTakesTools } from "../inference/adapters/fluency"

import {
  displayableLength,
  FINAL_ANSWER_PROMPT,
  findToolCall,
  ToolCall,
  toolDefinition,
  toolInstructions,
  toolResultMessage
} from "./protocol"
import { ToolResult, WorkspaceTools } from "./workspace"

export const DEFAULT_MAX_STEPS = 12
/** Calls run from one native reply; models that fan out get the first few. */
const MAX_CALLS_PER_REPLY = 3

export type ToolMode = "native" | "text"

/**
 * Servers reached through the OpenAI-compatible route, where `tools` goes
 * to the server as sent, and OpenAI itself. A peer's machine and QVAC
 * relay through twinny's own protocol, and text-generation-webui's tool
 * support is patchy. OpenAI's reasoning models refuse tools on the chat
 * route; the loop falls back to text for them.
 */
const NATIVE_TOOL_KINDS = new Set<string>([
  ...Object.values(OPEN_AI_COMPATIBLE_PROVIDERS).filter(
    (kind) =>
      kind !== OPEN_AI_COMPATIBLE_PROVIDERS.TwinnyP2P &&
      kind !== OPEN_AI_COMPATIBLE_PROVIDERS.Qvac &&
      kind !== OPEN_AI_COMPATIBLE_PROVIDERS.Oobabooga
  ),
  API_PROVIDERS.OpenAI
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

/** One tool the model used, for logs and the eval. */
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

export interface ToolLoopOptions {
  mode?: ToolMode
  maxSteps?: number
  onStep?(step: ToolStep): void
  /** Called before each call runs. */
  onToolStart?(start: ToolStart): void
  /**
   * Whether the reply text carries a `> summary` line per call. On by
   * default; a host that shows the steps itself turns it off.
   */
  stepLines?: boolean
  /** Called once per request with the characters it sends. */
  onRequest?(promptChars: number, step: number, mode: ToolMode): void
  /** Called when native tool-calling (or the reasoning effort) was refused and the loop carried on without it. */
  onFallback?(reason: string): void
  /**
   * Asked of every request; dropped for the rest of the reply if the model
   * refuses it (models that do not reason).
   */
  reasoningEffort?: ChatRequest["reasoningEffort"]
  /**
   * Called once the answer is complete with what the model looked at and
   * found, then the answer, as text: kept as the reply's `prompt` so a
   * follow-up question still has it.
   */
  onTranscript?(text: string): void
}

/** How much of each tool result a later turn keeps, and of all of them together. */
const TRANSCRIPT_RESULT_CHARS = 1500
const TRANSCRIPT_CHARS = 8000

const clipTo = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}\n… (cut)` : text

const textOf = (content: ChatMessage["content"]): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
      : ""

const charsOf = (messages: ChatMessage[]) =>
  messages.reduce((sum, m) => {
    const calls = (m as { tool_calls?: { function: { arguments: string } }[] }).tool_calls ?? []
    return sum + textOf(m.content).length + calls.reduce((n, c) => n + c.function.arguments.length, 0)
  }, 0)

/** The conversation with the tool section added to its system prompt. */
const withToolPrompt = (messages: ChatMessage[], section: string): ChatMessage[] => {
  const [first, ...rest] = messages
  if (first?.role === SYSTEM) {
    return [{ role: SYSTEM, content: `${textOf(first.content).trim()}\n\n${section}` }, ...rest]
  }
  return [{ role: SYSTEM, content: section }, ...messages]
}

const stepLine = (summary: string) => `> ${summary}\n\n`

/** What goes between text already shown and a step line, so each line is its own paragraph. */
const gapAfter = (shown: string) =>
  !shown.trim() || shown.endsWith("\n\n") ? "" : shown.endsWith("\n") ? "\n" : "\n\n"

/** A refusal of the `tools` field itself, as opposed to any other failure. */
const refusesTools = (error: unknown) =>
  !isCancelled(error) && error instanceof Error && /\btools?\b|function.?call/i.test(error.message)

/** A model that does not take a reasoning effort, as opposed to one that will not mix it with tools. */
const refusesReasoningEffort = (error: unknown) =>
  !isCancelled(error) &&
  error instanceof Error &&
  /reasoning[._ ]?effort/i.test(error.message) &&
  !/function tools|\btools\b/i.test(error.message)

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
          .map(([k, v]) => [k, typeof v === "string" ? v : String(v)])
      )
    }
  } catch {
    return "the arguments were not valid JSON"
  }
}

class ToolLoop {
  private _mode: ToolMode
  private _effort: ChatRequest["reasoningEffort"]
  private _messages: ChatMessage[] = []
  /** Everything yielded so far, for spacing the step lines. */
  private _shown = ""
  /** Each call and what it returned, for the transcript. */
  private _looked: string[] = []

  constructor(
    private readonly _client: InferenceClient,
    private readonly _workspace: WorkspaceTools,
    private readonly _options: ToolLoopOptions
  ) {
    this._mode = _options.mode ?? "text"
    this._effort = _options.reasoningEffort
  }

  async *run(request: ChatRequest, options?: InferenceOptions): AsyncGenerator<ChatChunk> {
    const maxSteps = this._options.maxSteps ?? DEFAULT_MAX_STEPS
    const outer = options?.signal
    const prompt = () =>
      withToolPrompt(
        request.messages,
        toolInstructions(this._workspace.tools, this._workspace.orientation, this._mode === "native")
      )
    this._messages = prompt()

    // Set once a tool's result says to answer now (an edit waits for review).
    let settled = false
    for (let step = 0; ; step++) {
      const last = settled || step >= maxSteps
      const sent =
        last && !settled
          ? [...this._messages, { role: USER, content: FINAL_ANSWER_PROMPT } as ChatMessage]
          : this._messages
      const promptChars = charsOf(sent)
      this._options.onRequest?.(promptChars, step, this._mode)

      // A step of our own to cut short when a text call closes, without it
      // looking like the user pressed stop.
      const stepAbort = new AbortController()
      const forward = () => stepAbort.abort(outer?.reason)
      if (outer?.aborted) forward()
      else outer?.addEventListener("abort", forward, { once: true })

      const native = this._mode === "native"
      const reply = { text: "", shown: 0, toolCalls: undefined as ChatToolCall[] | undefined }
      let found: ReturnType<typeof findToolCall>
      let tail: ChatChunk | undefined
      try {
        const chunks = this._client.chat(
          {
            ...request,
            messages: sent,
            ...(this._effort ? { reasoningEffort: this._effort } : {}),
            // The last request offers nothing to call, so the model answers.
            ...(native && !last ? { tools: this._workspace.tools.map(toolDefinition) } : {})
          },
          { ...options, signal: stepAbort.signal }
        )
        for await (const chunk of chunks) {
          reply.text += chunk.content
          if (chunk.toolCalls) reply.toolCalls = [...(reply.toolCalls ?? []), ...chunk.toolCalls]
          // Native mode reads text calls too: qwen3-coder sometimes writes its
          // own call syntax as prose, and Ollama passes it through untouched.
          if (!last) {
            found = findToolCall(reply.text)
            if (found) break
          }
          const safe = last ? reply.text.length : displayableLength(reply.text)
          if (safe > reply.shown) {
            yield this.show(reply.text.slice(reply.shown, safe))
            reply.shown = safe
          }
          if (chunk.usage || chunk.finishReason) {
            tail = { content: "", usage: chunk.usage, finishReason: chunk.finishReason }
          }
        }
      } catch (error) {
        if (outer?.aborted) throw error
        if (this._effort && !reply.text && refusesReasoningEffort(error)) {
          this._options.onFallback?.((error as Error).message)
          this._effort = undefined
          step--
          continue
        }
        if (native && !reply.text && refusesTools(error)) {
          this._options.onFallback?.((error as Error).message)
          this._mode = "text"
          this._messages = prompt()
          step--
          continue
        }
        if (!isCancelled(error)) throw error
      } finally {
        outer?.removeEventListener("abort", forward)
        stepAbort.abort()
      }

      const nativeCalls = native ? this.nativeCalls(reply.toolCalls) : []
      if (!nativeCalls.length && !last) found ??= findToolCall(reply.text, true)
      const calls = nativeCalls.length ? nativeCalls : this.textCall(found, reply, step)

      if (!calls.length) {
        // The answer. Anything held back as a possible call opener is prose after all.
        if (reply.text.length > reply.shown) yield this.show(reply.text.slice(reply.shown))
        if (tail) yield tail
        this.transcribe(reply.text)
        return
      }

      if (found && found.start > reply.shown) {
        yield this.show(reply.text.slice(reply.shown, found.start))
      }
      const results: ToolResult[] = []
      for (const [i, call] of calls.entries()) {
        const id = `${step}.${i}`
        const name = call.call?.name ?? call.raw?.name ?? "unknown"
        this._options.onToolStart?.({ id, name, args: call.call?.args ?? {} })
        const result: ToolResult = call.call
          ? await this._workspace.run(call.call)
          : {
              output: `Your tool call could not be read: ${call.error}.` +
                (native ? "" : " Write it as a ```tool block holding {\"name\": ..., \"arguments\": {...}}."),
              summary: `tool call not understood · ${call.error}`,
              failed: true
            }
        results.push(result)
        this._looked.push(
          `${call.call?.name ?? call.raw?.name ?? "unreadable call"} ${JSON.stringify(call.call?.args ?? {})}\n` +
            clipTo(result.output, TRANSCRIPT_RESULT_CHARS)
        )
        this._options.onStep?.({
          id,
          index: step,
          mode: this._mode,
          name: call.call?.name ?? call.raw?.name,
          args: call.call?.args,
          parseError: call.error,
          summary: result.summary,
          output: result.output,
          failed: result.failed,
          promptChars
        })
        if (this._options.stepLines !== false) {
          yield this.show(`${gapAfter(this._shown)}${stepLine(result.summary)}`)
        }
      }
      this.remember(calls, results, reply.text)
      settled = results.some((result) => result.final)
    }
  }

  private transcribe(answer: string) {
    if (!this._options.onTranscript) return
    if (!this._looked.length) return this._options.onTranscript(answer.trim())
    const looked = clipTo(this._looked.join("\n\n"), TRANSCRIPT_CHARS)
    this._options.onTranscript(
      `[What I looked at in the workspace before answering]\n${looked}\n\n[My answer]\n${answer.trim()}`
    )
  }

  private show(content: string): ChatChunk {
    this._shown += content
    return { content }
  }

  private nativeCalls(toolCalls: ChatToolCall[] | undefined) {
    return (toolCalls ?? []).slice(0, MAX_CALLS_PER_REPLY).map((raw) => {
      const call = parseArguments(raw)
      return typeof call === "string" ? { raw, error: call } : { raw, call }
    })
  }

  private textCall(found: ReturnType<typeof findToolCall>, reply: { text: string }, step: number) {
    if (!found) return []
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
    return [{ raw: undefined, call: found.call, error: found.error }]
  }

  /** The reply that made the calls, and their results, join the conversation. */
  private remember(
    calls: { raw?: ChatToolCall; call?: ToolCall; error?: string }[],
    results: ToolResult[],
    text: string
  ) {
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
      calls.forEach(({ raw }, i) =>
        this._messages.push({ role: "tool", tool_call_id: raw!.id, content: results[i].output } as ChatMessage)
      )
      return
    }
    this._messages.push(
      { role: ASSISTANT, content: text },
      { role: USER, content: toolResultMessage(calls[0].call?.name ?? "error", results[0].output) }
    )
  }
}

/** `client`, with read-only workspace tools available to `chat()`. */
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

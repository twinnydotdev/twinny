import { ASSISTANT, EVENT_NAME } from "../../common/constants"
import { formatCount, logger } from "../../common/logger"
import { ChatCompletionMessage, ReplyMeta, TwinnyProvider } from "../../common/types"
import { GenerationRun, GenerationTracker } from "../generations"
import { ChatRequest, InferenceClient, isCancelled } from "../inference"
import { ExtensionBridge } from "../messaging/bridge"
import { describeProviderError, describeProviderErrorPlain, isAbortError } from "../providers/errors"

/** Message content is a string, or text parts alongside images. */
const contentText = (content: ChatCompletionMessage["content"]): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      part.type === "text" ? part.text : `[${part.type}]`
    )
    .join("\n")
}

const contentLength = (content: ChatCompletionMessage["content"]) =>
  contentText(content).length

/** What a feature adds to a reply as it ends. */
export interface ReplyExtras {
  /** What the reply's tools were asked and returned, kept with it for the next turn; never shown. */
  toolNotes?(): string | undefined
  /** More about how the reply came about, read once it has ended. */
  meta?(): Partial<ReplyMeta>
  /** True when the reply is worth keeping with no text: its tools ran, and their steps are its record. */
  keepEmpty?(): boolean
}

/**
 * One chat request from start to finish: a run on the generation tracker
 * (which owns the spinner and the stop keybinding), streaming partial text to
 * the webview, and turning a failure into a message the user can act on.
 *
 * `prefix` is text shown (and saved) ahead of the model's reply, e.g. a part
 * heading in a multi-part review.
 */
export class ChatGeneration {
  private _run?: GenerationRun
  private _cancelled = false
  private readonly _stopSubscription: { dispose(): void }

  constructor(
    private readonly _bridge: ExtensionBridge,
    private readonly _generations: GenerationTracker
  ) {
    // The stop command reaches every chat, the panel's as well as the
    // sidebar's, and between the parts of a review as well as during one.
    this._stopSubscription = _generations.onDidStop(() => this.abort())
  }

  public dispose() {
    this._stopSubscription.dispose()
  }

  /** True once the user has stopped generation, until the next request. */
  public get cancelled() {
    return this._cancelled
  }

  public reset() {
    this._cancelled = false
  }

  public abort() {
    this._cancelled = true
    this._run?.abort()
    this._bridge.emit(EVENT_NAME.twinnyStopGeneration)
  }

  /**
   * Run one request against a resolved provider and show the reply as it
   * streams. Whether the provider streams or answers whole is its business.
   */
  public async generate(
    inference: InferenceClient,
    request: ChatRequest,
    provider: TwinnyProvider,
    prefix = "",
    extras: ReplyExtras = {}
  ): Promise<string> {
    if (this._cancelled) return ""
    const run = this._generations.start("chat")
    this._run = run
    let text = prefix
    const elapsed = this.logRequest(request.messages, provider)
    const started = Date.now()
    const meta: ReplyMeta = { model: provider.modelName, provider: provider.label }
    const finish = (): ReplyMeta => ({
      ...meta,
      ...extras.meta?.(),
      durationMs: Date.now() - started,
      ...(run.signal.aborted ? { stopped: true } : {})
    })

    try {
      const chunks = inference.chat(request, {
        signal: run.signal,
        onBackend: (name) => {
          meta.provider = name
        },
        onShield: (report) => {
          meta.withheld = report
        }
      })
      try {
        for await (const chunk of chunks) {
          if (chunk.usage?.completionTokens) {
            meta.completionTokens = chunk.usage.completionTokens
          }
          if (chunk.usage?.promptTokens) {
            meta.promptTokens = chunk.usage.promptTokens
          }
          text += chunk.content
          this._bridge.emit(EVENT_NAME.twinnyOnCompletion, {
            content: text.trimStart() || " ",
            role: ASSISTANT
          })
        }
      } catch (error) {
        // Stopping is not a failure: what arrived is the reply.
        if (!isCancelled(error)) throw error
      }

      const reply = text.trim()
      logger.info(
        `Chat ← ${elapsed()} · ${formatCount(reply.length)} chars` +
          (run.signal.aborted ? " · stopped by the user" : "")
      )
      logger.block("Chat reply", reply)
      if (reply || extras.keepEmpty?.()) this.addMessage(reply, finish(), extras.toolNotes?.())
      return reply
    } catch (error) {
      run.abort()
      // Keep whatever streamed before the failure; it is still useful.
      // A bare heading is not.
      const partial = text.trim() === prefix.trim() ? "" : text.trim()
      if (partial || extras.keepEmpty?.()) this.addMessage(partial, finish(), extras.toolNotes?.())
      this.report(error, provider)
      return partial
    } finally {
      run.finish()
      if (this._run === run) this._run = undefined
      this._bridge.emit(EVENT_NAME.twinnyStopGeneration)
    }
  }

  private addMessage(content: string, meta?: ReplyMeta, toolNotes?: string) {
    this._bridge.emit(EVENT_NAME.twinnyAddMessage, {
      content,
      role: ASSISTANT,
      ...(meta ? { meta } : {}),
      ...(toolNotes ? { toolNotes } : {})
    })
  }

  /**
   * One line saying what is being sent and to whom; the messages
   * themselves at debug level. Returns the stopwatch for the reply line.
   */
  private logRequest(
    messages: ChatCompletionMessage[],
    provider: TwinnyProvider
  ) {
    const chars = messages.reduce((sum, m) => sum + contentLength(m.content), 0)
    logger.info(
      `Chat → ${provider.modelName} (${provider.label}) · ` +
        `${messages.length} message${messages.length === 1 ? "" : "s"}, ` +
        `${formatCount(chars)} chars`
    )
    logger.block(
      "Chat messages",
      messages
        .map((m) => `[${m.role}]\n${contentText(m.content)}`)
        .join("\n\n")
    )
    return logger.timer()
  }

  /** A stopped request is not an error; anything else gets explained. */
  private report(error: unknown, provider: TwinnyProvider) {
    if (isAbortError(error) || this._cancelled) return
    logger.error(`Chat failed: ${describeProviderErrorPlain(error, provider)}`)
    this.addMessage(describeProviderError(error, provider))
  }
}

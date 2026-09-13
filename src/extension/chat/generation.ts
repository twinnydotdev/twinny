import { commands } from "vscode"

import { ASSISTANT, EVENT_NAME, EXTENSION_CONTEXT_NAME } from "../../common/constants"
import { formatCount, logger } from "../../common/logger"
import { ChatCompletionMessage, TwinnyProvider } from "../../common/types"
import { ChatRequest, InferenceClient, isCancelled } from "../inference"
import { ExtensionBridge } from "../messaging/bridge"
import { describeProviderError, describeProviderErrorPlain, isAbortError } from "../providers/errors"
import { TwinnyStatusBar } from "../status-bar"

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

/**
 * One chat request from start to finish: the spinner, the stop keybinding's
 * context flag, streaming partial text to the webview, and turning a failure
 * into a message the user can act on.
 *
 * `prefix` is text shown (and saved) ahead of the model's reply, e.g. a part
 * heading in a multi-part review.
 */
export class ChatGeneration {
  private _controller?: AbortController
  private _cancelled = false

  constructor(
    private readonly _bridge: ExtensionBridge,
    private readonly _statusBar: TwinnyStatusBar
  ) {}

  /** True once the user has stopped generation, until the next request. */
  public get cancelled() {
    return this._cancelled
  }

  public reset() {
    this._cancelled = false
  }

  public abort() {
    this._cancelled = true
    this._controller?.abort()
    this.end()
  }

  /**
   * Run one request against a resolved provider and show the reply as it
   * streams. Whether the provider streams or answers whole is its business.
   */
  public async generate(
    inference: InferenceClient,
    request: ChatRequest,
    provider: TwinnyProvider,
    prefix = ""
  ): Promise<string> {
    if (this._cancelled) return ""
    this.begin()
    let text = prefix
    const elapsed = this.logRequest(request.messages, provider)

    try {
      const chunks = inference.chat(request, { signal: this._controller?.signal })
      try {
        for await (const chunk of chunks) {
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
          (this._controller?.signal.aborted ? " · stopped by the user" : "")
      )
      logger.block("Chat reply", reply)
      if (reply) this.addMessage(reply)
      return reply
    } catch (error) {
      this._controller?.abort()
      // Keep whatever streamed before the failure; it is still useful.
      // A bare heading is not.
      const partial = text.trim() === prefix.trim() ? "" : text.trim()
      if (partial) this.addMessage(partial)
      this.report(error, provider)
      return partial
    } finally {
      this.end()
    }
  }

  private addMessage(content: string) {
    this._bridge.emit(EVENT_NAME.twinnyAddMessage, { content, role: ASSISTANT })
  }

  /**
   * Spinner on, and the `twinnyGeneratingText` context set so the
   * stop-generation keybinding is live for as long as the request runs.
   */
  private begin() {
    this._controller = new AbortController()
    this._statusBar.busy()
    void commands.executeCommand(
      "setContext",
      EXTENSION_CONTEXT_NAME.twinnyGeneratingText,
      true
    )
  }

  private end() {
    this._statusBar.idle()
    void commands.executeCommand(
      "setContext",
      EXTENSION_CONTEXT_NAME.twinnyGeneratingText,
      false
    )
    this._bridge.emit(EVENT_NAME.twinnyStopGeneration)
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

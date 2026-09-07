import { TokenJS } from "fluency.js"
import { commands } from "vscode"

import { ASSISTANT, EVENT_NAME, EXTENSION_CONTEXT_NAME } from "../../common/constants"
import { logger } from "../../common/logger"
import {
  CompletionNonStreamingWithId,
  CompletionStreamingWithId,
  TwinnyProvider
} from "../../common/types"
import { ExtensionBridge } from "../messaging/bridge"
import { describeProviderError, isAbortError } from "../providers/errors"
import { TwinnyStatusBar } from "../status-bar"

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

  public async stream(
    client: TokenJS,
    request: CompletionStreamingWithId,
    provider: TwinnyProvider,
    prefix = ""
  ): Promise<string> {
    if (this._cancelled) return ""
    this.begin()
    let text = prefix

    try {
      logger.log(
        `Chat completion request: ${JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: true
        })}`
      )
      const parts = await client.chat.completions.create(request)

      for await (const part of parts) {
        if (this._controller?.signal.aborted) break
        const delta = part.choices[0]?.delta?.content
        if (!delta) continue
        text += delta
        this._bridge.emit(EVENT_NAME.twinnyOnCompletion, {
          content: text.trimStart() || " ",
          role: ASSISTANT
        })
      }

      const reply = text.trim()
      logger.log(`Chat completion response (${request.model}): ${reply.length} chars`)
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

  public async block(
    client: TokenJS,
    request: CompletionNonStreamingWithId,
    provider: TwinnyProvider,
    prefix = ""
  ): Promise<string> {
    if (this._cancelled) return ""
    this.begin()
    try {
      const result = await client.chat.completions.create(request)
      const content = `${prefix}${result.choices[0].message.content || ""}`
      this.addMessage(content)
      return content
    } catch (error) {
      this._controller?.abort()
      this.report(error, provider)
      return ""
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

  /** A stopped request is not an error; anything else gets explained. */
  private report(error: unknown, provider: TwinnyProvider) {
    if (isAbortError(error) || this._cancelled) return
    logger.error(error instanceof Error ? error : String(error))
    this.addMessage(describeProviderError(error, provider))
  }
}

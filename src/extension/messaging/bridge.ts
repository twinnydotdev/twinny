import { Disposable, Webview } from "vscode"

import { logger } from "../../common/logger"
import { Envelope, isEnvelope } from "../../common/messaging/envelope"
import {
  ClientEventName,
  PayloadOf,
  ReplyOf,
  ServerEventName,
  ServerPayloadOf
} from "../../common/messaging/protocol"

export type Handler<K extends ClientEventName> = (
  payload: PayloadOf<K>
) => ReplyOf<K> | Promise<ReplyOf<K>> | void | Promise<void>

/**
 * Handlers are contravariant in their payload, so a table holding one per
 * channel has no single safe element type. `never` is the honest erasure: it
 * accepts every concrete handler and forces the one unavoidable cast to live
 * here, at the dispatch boundary, instead of at every registration site.
 */
type ErasedHandler = (payload: never) => unknown

/**
 * The extension's half of the message bus.
 *
 * One `onDidReceiveMessage` subscription per webview, one handler table, and
 * one place that knows how a reply gets back to its caller. Services register
 * the channels they own and never touch `webview.postMessage` directly.
 *
 * A handler simply returns its result:
 *
 *   bridge.handle(EVENT_NAME.twinnySendTheme, () => getTheme())
 *
 * If the caller used `request()` the value is routed back to that exact call;
 * otherwise it is broadcast on the same channel, which is what the
 * fire-a-request-then-listen components expect.
 */
export class ExtensionBridge implements Disposable {
  private readonly _handlers = new Map<string, ErasedHandler>()
  private readonly _subscription: Disposable
  private _disposed = false

  constructor(private readonly _webview: Webview) {
    this._subscription = _webview.onDidReceiveMessage((message: unknown) => {
      void this._dispatch(message)
    })
  }

  /**
   * Claim a channel. Each channel has exactly one owner — registering twice is
   * a bug (two services silently answering the same question), so it warns
   * loudly rather than quietly appending another listener.
   */
  public handle<K extends ClientEventName>(type: K, handler: Handler<K>): this {
    if (this._handlers.has(type)) {
      logger.error(new Error(`Duplicate handler registered for "${type}"`))
    }
    this._handlers.set(type, handler as ErasedHandler)
    return this
  }

  /** Register a whole table at once — the common case for a service. */
  public handleAll(handlers: {
    [K in ClientEventName]?: Handler<K>
  }): this {
    for (const [type, handler] of Object.entries(handlers)) {
      if (handler) this.handle(type as ClientEventName, handler as never)
    }
    return this
  }

  /** Push an unsolicited event to the webview. */
  public emit<K extends ServerEventName>(
    type: K,
    data?: ServerPayloadOf<K>
  ): void {
    if (this._disposed) return
    void this._webview.postMessage({ type, data } satisfies Envelope)
  }

  public dispose(): void {
    this._disposed = true
    this._handlers.clear()
    this._subscription.dispose()
  }

  private async _dispatch(message: unknown): Promise<void> {
    if (!isEnvelope(message)) return

    const handler = this._handlers.get(message.type)
    if (!handler) return

    const { id, type } = message

    try {
      const result = await handler(message.data as never)
      if (result === undefined) return
      // A correlated reply goes only to its caller; anything else is a
      // broadcast on the same channel.
      void this._webview.postMessage(
        id ? { type, id, data: result } : { type, data: result }
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      logger.error(new Error(`Handler for "${type}" failed: ${reason}`))
      if (id) void this._webview.postMessage({ type, id, error: reason })
    }
  }
}

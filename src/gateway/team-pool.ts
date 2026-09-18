/* eslint-disable @typescript-eslint/no-this-alias */
/**
 * The `team` provider kind: an alias served by whichever connected
 * teammate has the model. Registered as an ordinary inference adapter so
 * the route table, the handler and the status route treat the pool like
 * any other backend; only this file knows a request may hop to a peer.
 */
import { InferenceError } from "../extension/inference/errors"
import type { InferenceAdapter } from "../extension/inference/registry"
import type {
  ChatChunk,
  ChatRequest,
  EmbeddingRequest,
  EmbeddingResponse,
  FimChunk,
  FimRequest,
  InferenceCapability,
  InferenceModel,
  InferenceOptions,
  InferenceProvider
} from "../extension/inference/types"

import { TEAM_PROVIDER_KIND } from "./config"
import { PeerLostError, PeerRegistry } from "./peers"

/** How the pool is named for admins. */
export const TEAM_PROVIDER_LABEL = "Team members' computers"

const noPeer = (
  model: string,
  offered: number,
  busy: boolean
): InferenceError =>
  busy
    ? new InferenceError(
        "rate-limited",
        `Every teammate sharing ${model} is busy (${offered} online). Try again shortly.`
      )
    : new InferenceError(
        "provider-unavailable",
        `No teammate is sharing ${model} right now.`
      )

export class TeamPoolProvider implements InferenceProvider {
  public readonly id = TEAM_PROVIDER_KIND

  constructor(private readonly _peers: PeerRegistry) {}

  public capabilities(): InferenceCapability[] {
    return ["fim", "chat", "embeddings"]
  }

  /** The union of what connected peers offer; nobody online reads as a backend that is down. */
  public async models(): Promise<InferenceModel[]> {
    if (!this._peers.online()) {
      throw new InferenceError(
        "provider-unavailable",
        "No teammate is sharing a computer right now."
      )
    }
    return this._peers
      .models()
      .map((id) => ({ id, name: id, capabilities: this.capabilities() }))
  }

  public fim(
    request: FimRequest,
    options?: InferenceOptions
  ): AsyncIterable<FimChunk> {
    return this.relay("fim", request, options) as AsyncIterable<FimChunk>
  }

  public chat(
    request: ChatRequest,
    options?: InferenceOptions
  ): AsyncIterable<ChatChunk> {
    return this.relay("chat", request, options) as AsyncIterable<ChatChunk>
  }

  public async embeddings(
    request: EmbeddingRequest,
    options?: InferenceOptions
  ): Promise<EmbeddingResponse> {
    const tried: string[] = []
    let chosen = this.choose(request.model, tried)
    for (;;) {
      tried.push(chosen.id)
      options?.onBackend?.(chosen.label)
      try {
        return await this._peers.embed(chosen.id, request, options?.signal)
      } catch (error) {
        const replacement = this.replacement(
          error,
          request.model,
          tried,
          options
        )
        if (!replacement) throw error
        chosen = replacement
      }
    }
  }

  /* ------------------------------------------------------------------------ */

  private choose(model: string, exclude: string[]) {
    const { peer, offered, busy } = this._peers.pick(model, exclude)
    if (!peer) throw noPeer(model, offered, busy)
    return peer
  }

  /**
   * Another peer to try after a loss, once: only when the first peer went
   * away, nothing was streamed, the requester is still there, and someone
   * else has the model. Otherwise the loss itself is the news.
   */
  private replacement(
    error: unknown,
    model: string,
    tried: string[],
    options?: InferenceOptions
  ) {
    if (
      !(error instanceof PeerLostError) ||
      tried.length !== 1 ||
      options?.signal?.aborted
    )
      return undefined
    return this._peers.pick(model, tried).peer
  }

  /**
   * Streams through one peer. A peer lost before its first chunk is
   * replaced once; after a chunk went out there is nothing to retry into,
   * so the loss reaches the requester.
   */
  private relay(
    capability: "fim" | "chat",
    request: FimRequest | ChatRequest,
    options?: InferenceOptions
  ): AsyncIterable<FimChunk | ChatChunk> {
    const pool = this
    return {
      [Symbol.asyncIterator]: async function* () {
        const tried: string[] = []
        let chosen = pool.choose(request.model, tried)
        for (;;) {
          tried.push(chosen.id)
          options?.onBackend?.(chosen.label)
          let yielded = 0
          try {
            for await (const chunk of pool._peers.stream(
              chosen.id,
              capability,
              request,
              options?.signal
            )) {
              yielded++
              yield chunk
            }
            return
          } catch (error) {
            const replacement =
              yielded === 0
                ? pool.replacement(error, request.model, tried, options)
                : undefined
            if (!replacement) throw error
            chosen = replacement
          }
        }
      }
    }
  }
}

export const teamPoolAdapter = (peers: PeerRegistry): InferenceAdapter => ({
  id: TEAM_PROVIDER_KIND,
  create: () => new TeamPoolProvider(peers)
})

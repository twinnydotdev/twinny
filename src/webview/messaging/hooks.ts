import { useCallback, useEffect, useRef, useState } from "react"

import {
  ClientEventName,
  PayloadOf,
  ReplyOf,
  RequestableEvent,
  ServerEventName,
  ServerPayloadOf,
  VoidPayloadEvent
} from "../../common/messaging/protocol"

import { bridge } from "./bridge"

/**
 * Subscribe to a channel the extension pushes on.
 *
 * The handler is held in a ref so callers can pass an inline arrow function
 * without re-subscribing on every render — the trap that made the old
 * hand-rolled `addEventListener` effects depend on `[]` and then go stale.
 */
export const useServerEvent = <K extends ServerEventName>(
  type: K,
  handler: (data: ServerPayloadOf<K>) => void
): void => {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => bridge.on(type, (data) => handlerRef.current(data)), [type])
}

export interface Query<T> {
  data: T | undefined
  error: Error | undefined
  isLoading: boolean
  refetch: () => void
}

/**
 * Ask the extension for a value once, and expose the usual loading/error
 * triple while it is in flight.
 */
export const useServerQuery = <K extends RequestableEvent & VoidPayloadEvent>(
  type: K,
  initial?: ReplyOf<K>,
  /** When set, the channel is also watched for unsolicited updates. */
  subscribe = false
): Query<ReplyOf<K>> => {
  const [data, setData] = useState<ReplyOf<K> | undefined>(initial)
  const [error, setError] = useState<Error | undefined>()
  const [isLoading, setIsLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!subscribe) return
    return bridge.on(type as unknown as ServerEventName, (value) =>
      setData(value as ReplyOf<K>)
    )
  }, [type, subscribe])

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)

    bridge
      .request(type)
      .then((value) => {
        if (cancelled) return
        setData(value as ReplyOf<K>)
        setError(undefined)
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason)
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [type, nonce])

  return {
    data,
    error,
    isLoading,
    refetch: useCallback(() => setNonce((n) => n + 1), [])
  }
}

/**
 * A query that also stays fresh: the same channel is watched for the
 * unsolicited updates the extension pushes when the value changes — a theme
 * switch, a provider being saved.
 *
 * Only channels declared in *both* directions qualify, which is exactly the
 * "readable and observable" subset the protocol already distinguishes.
 */
export const useServerState = <
  K extends RequestableEvent & VoidPayloadEvent & ServerEventName
>(
  type: K,
  initial?: ReplyOf<K>
): Query<ReplyOf<K>> => useServerQuery(type, initial, true)

/** `bridge.emit`, re-exported so components import one module, not two. */
export const emit: {
  <K extends VoidPayloadEvent>(type: K): void
  <K extends ClientEventName>(type: K, payload: PayloadOf<K>): void
} = bridge.emit.bind(bridge)

export { bridge }

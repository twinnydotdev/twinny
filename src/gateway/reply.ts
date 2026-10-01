/**
 * How the gateway answers over HTTP: JSON with the headers every reply
 * carries, the `{ error: { message } }` shape the admin page and the CLI
 * read, an inference error in the protocol's shape, a plugin's answer
 * (JSON, a page, or a redirect), and a small JSON body read in.
 */
import type http from "node:http"

import { InferenceError, InferenceErrorKind } from "../extension/inference/errors"
import { statusForKind, toErrorBody } from "../protocol/wire"

export type Headers = Record<string, string>

export const sendJson = (
  res: http.ServerResponse,
  status: number,
  value: unknown,
  headers: Headers = {}
): void => {
  const text = JSON.stringify(value)
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    ...headers
  })
  res.end(text)
}

/** A refusal with one line to show: `{ error: { message } }`. */
export const sendMessage = (
  res: http.ServerResponse,
  status: number,
  message: string,
  headers?: Headers
): void => sendJson(res, status, { error: { message } }, headers)

/** 405 with the verbs that would have worked. */
export const sendMethodNotAllowed = (
  res: http.ServerResponse,
  allow: readonly string[],
  message: string
): void => sendMessage(res, 405, message, { Allow: allow.join(", ") })

/** An inference error at the status its kind maps to, in the protocol's shape. */
export const sendError = (
  res: http.ServerResponse,
  error: InferenceError,
  headers?: Headers
): void => sendJson(res, statusForKind(error.kind), toErrorBody(error), headers)

/**
 * An inference error at a status the caller chooses, in the protocol's
 * shape: what a VS Code client reads when the gateway turns it away.
 */
export const sendRefusal = (
  res: http.ServerResponse,
  status: number,
  kind: InferenceErrorKind,
  message: string,
  headers?: Headers
): void =>
  sendJson(res, status, toErrorBody(new InferenceError(kind, message)), headers)

export interface PluginAnswer {
  status: number
  body?: unknown
  headers?: Headers
  html?: string
}

/** A plugin's answer: a page, a redirect with no body, or JSON. */
export const sendPlugin = (
  res: http.ServerResponse,
  answer: PluginAnswer
): void => {
  if (answer.html !== undefined) {
    res.writeHead(answer.status, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(answer.html),
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      ...(answer.headers ?? {})
    })
    res.end(answer.html)
    return
  }
  if (answer.body === null && answer.status >= 300 && answer.status < 400) {
    res.writeHead(answer.status, {
      "Cache-Control": "no-store",
      ...(answer.headers ?? {})
    })
    res.end()
    return
  }
  sendJson(res, answer.status, answer.body, answer.headers)
}

export const MAX_JSON_BODY_BYTES = 16 * 1024

/**
 * How long a small JSON body may take to arrive. The server's own request
 * timeout is off (a stream may be quiet for minutes), and the routes that
 * read these bodies include ones that take no credential (sign-in, join),
 * so without a clock here a caller that sends headers and then nothing
 * would hold a connection for as long as it liked.
 */
export const JSON_BODY_TIMEOUT_MS = 30_000

/** After a body ran out of time: how long the answer gets before the socket goes. */
const CLOSE_AFTER_TIMEOUT_MS = 1_000

/**
 * A small JSON object body, or an error whose message the caller can show.
 *
 * A body over `maxBytes` is refused as soon as it is, not when it ends. A
 * body that has not ended within `timeoutMs` is refused, and the connection
 * is closed a moment later, once the caller has had time to say so.
 */
export const readJsonBody = (
  req: http.IncomingMessage,
  maxBytes = MAX_JSON_BODY_BYTES,
  timeoutMs = JSON_BODY_TIMEOUT_MS
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const timer = setTimeout(() => {
      // Still arriving (or never sent): nothing more is read from it.
      fail(new Error("The request body did not arrive in time."))
      const socket = req.socket
      const closer = setTimeout(() => socket.destroy(), CLOSE_AFTER_TIMEOUT_MS)
      closer.unref()
    }, timeoutMs)
    timer.unref()
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      chunks.length = 0
      reject(error)
    }
    req.on("data", (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        // Refused now; the rest is drained (and dropped) so the answer can
        // be read, and the clock above still bounds how long that takes.
        fail(new Error("The request body is too large."))
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      try {
        const parsed: unknown = JSON.parse(
          Buffer.concat(chunks as Uint8Array[]).toString("utf8") || "{}"
        )
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          reject(new Error("The request body must be a JSON object."))
          return
        }
        resolve(parsed as Record<string, unknown>)
      } catch {
        reject(new Error("The request body is not JSON."))
      }
    })
    req.on("error", (error) => {
      clearTimeout(timer)
      fail(error)
    })
    // A caller that hangs up mid-body: no "end" will come.
    req.on("close", () => {
      clearTimeout(timer)
      fail(new Error("The request was closed before its body arrived."))
    })
  })

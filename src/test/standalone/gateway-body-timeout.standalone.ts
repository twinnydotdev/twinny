/**
 * A small JSON body has a clock: a caller that sends headers and then
 * stalls is refused and its connection closed, instead of holding a socket
 * for as long as it likes. The routes that read these bodies include ones
 * that take no credential (sign-in, join). Run with plain Node
 * (`npm run test:sqlite`).
 */
import * as assert from "node:assert"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import * as net from "node:net"
import { test } from "node:test"

import { readJsonBody, sendJson, sendMessage } from "../../gateway/reply"

const TIMEOUT_MS = 150

const serve = async (maxBytes: number) => {
  const server = http.createServer((req, res) => {
    readJsonBody(req, maxBytes, TIMEOUT_MS).then(
      (body) => sendJson(res, 200, body),
      (error: Error) => sendMessage(res, 400, error.message)
    )
  })
  // As the gateway sets it: the socket itself never times a request out.
  server.requestTimeout = 0
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
        server.close(() => resolve())
      })
  }
}

/** Sends raw bytes and collects what comes back until the server closes the socket. */
const raw = (port: number, payload: string, limitMs = 5_000) =>
  new Promise<{ text: string; closedAfterMs: number }>((resolve, reject) => {
    const started = Date.now()
    let text = ""
    const socket: net.Socket = net.connect(port, "127.0.0.1", () => socket.write(payload))
    const guard = setTimeout(() => {
      socket.destroy()
      reject(new Error(`the server kept the connection open for ${limitMs} ms; got: ${text}`))
    }, limitMs)
    socket.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")))
    socket.on("error", () => undefined)
    socket.on("close", () => {
      clearTimeout(guard)
      resolve({ text, closedAfterMs: Date.now() - started })
    })
  })

const head = (length: number) =>
  `POST /x HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n\r\n`

test("a body that never arrives is refused and the connection closed", async () => {
  const server = await serve(1024)
  try {
    const { text, closedAfterMs } = await raw(server.port, head(64))
    assert.match(text, /^HTTP\/1\.1 400 /)
    assert.ok(text.includes("did not arrive in time"), text)
    assert.ok(closedAfterMs >= TIMEOUT_MS, `closed after ${closedAfterMs} ms`)
  } finally {
    await server.close()
  }
})

test("a body that trickles past the deadline is refused too", async () => {
  const server = await serve(1024)
  try {
    const { text } = await raw(server.port, head(64) + "{\"a\":")
    assert.match(text, /^HTTP\/1\.1 400 /)
    assert.ok(text.includes("did not arrive in time"), text)
  } finally {
    await server.close()
  }
})

test("an oversized body is refused as soon as it is over, and a stalled one still closes", async () => {
  const server = await serve(16)
  try {
    const started = Date.now()
    // Claims 4096 bytes, sends 64 and stalls: over the limit, never ended.
    const { text } = await raw(server.port, head(4096) + "x".repeat(64))
    assert.match(text, /^HTTP\/1\.1 400 /)
    assert.ok(text.includes("too large"), text)
    assert.ok(Date.now() - started < 4_000)
  } finally {
    await server.close()
  }
})

test("a body that arrives in time is read as before", async () => {
  const server = await serve(1024)
  try {
    const answer = await fetch(`http://127.0.0.1:${server.port}/x`, {
      method: "POST",
      body: JSON.stringify({ name: "alice" })
    })
    assert.strictEqual(answer.status, 200)
    assert.deepStrictEqual(await answer.json(), { name: "alice" })
    const bad = await fetch(`http://127.0.0.1:${server.port}/x`, { method: "POST", body: "[1]" })
    assert.strictEqual(bad.status, 400)
    // A finished body leaves nothing behind that would close the socket later.
    await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS * 2))
    const again = await fetch(`http://127.0.0.1:${server.port}/x`, { method: "POST", body: "{}" })
    assert.strictEqual(again.status, 200)
  } finally {
    await server.close()
  }
})

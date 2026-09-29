/**
 * The gateway's HTTP replies, through a real listener: the headers every
 * JSON answer carries, the one-line refusal shape, 405 with Allow, an
 * inference error in the protocol's shape, a plugin's page or redirect,
 * and the bounds on a JSON body read in.
 */
import * as assert from "assert"
import * as http from "http"
import type { AddressInfo } from "net"

import { InferenceError } from "../../extension/inference/errors"
import {
  MAX_JSON_BODY_BYTES,
  readJsonBody,
  sendError,
  sendJson,
  sendMessage,
  sendMethodNotAllowed,
  sendPlugin,
  sendRefusal
} from "../../gateway/reply"

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  text: string
}

const serve = async (handler: Handler, body?: string): Promise<Reply> => {
  const server = http.createServer((req, res) => void handler(req, res))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  try {
    return await new Promise<Reply>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: body === undefined ? "GET" : "POST", path: "/" },
        (res) => {
          let text = ""
          res.setEncoding("utf8")
          res.on("data", (chunk: string) => (text += chunk))
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }))
        }
      )
      req.on("error", reject)
      req.end(body)
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

suite("Gateway replies", () => {
  test("JSON carries its length, no-store, and any headers the caller adds", async () => {
    const reply = await serve((_req, res) => sendJson(res, 201, { ok: true }, { "X-Extra": "1" }))
    assert.strictEqual(reply.status, 201)
    assert.strictEqual(reply.headers["content-type"], "application/json")
    assert.strictEqual(reply.headers["content-length"], String(Buffer.byteLength("{\"ok\":true}")))
    assert.strictEqual(reply.headers["cache-control"], "no-store")
    assert.strictEqual(reply.headers["x-extra"], "1")
    assert.deepStrictEqual(JSON.parse(reply.text), { ok: true })
  })

  test("a message is one line under error, and 405 names the verbs", async () => {
    const refused = await serve((_req, res) => sendMessage(res, 404, "Not found.", { "Retry-After": "5" }))
    assert.strictEqual(refused.status, 404)
    assert.strictEqual(refused.headers["retry-after"], "5")
    assert.deepStrictEqual(JSON.parse(refused.text), { error: { message: "Not found." } })

    const wrongVerb = await serve((_req, res) => sendMethodNotAllowed(res, ["GET", "PUT"], "Use GET or PUT."))
    assert.strictEqual(wrongVerb.status, 405)
    assert.strictEqual(wrongVerb.headers["allow"], "GET, PUT")
    assert.deepStrictEqual(JSON.parse(wrongVerb.text), { error: { message: "Use GET or PUT." } })
  })

  test("an inference error takes its kind's status, or the one the caller picks", async () => {
    const byKind = await serve((_req, res) => sendError(res, new InferenceError("authentication", "Who?")))
    assert.strictEqual(byKind.status, 401)
    const body = JSON.parse(byKind.text) as { error: { kind: string; message: string } }
    assert.strictEqual(body.error.kind, "authentication")
    assert.strictEqual(body.error.message, "Who?")

    const chosen = await serve((_req, res) => sendRefusal(res, 403, "authentication", "Not you.", { "WWW-Authenticate": "Bearer" }))
    assert.strictEqual(chosen.status, 403)
    assert.strictEqual(chosen.headers["www-authenticate"], "Bearer")
    assert.strictEqual((JSON.parse(chosen.text) as { error: { kind: string } }).error.kind, "authentication")
  })

  test("a plugin answers with a page, a redirect, or JSON", async () => {
    const page = await serve((_req, res) => sendPlugin(res, { status: 200, html: "<p>hi</p>" }))
    assert.strictEqual(page.status, 200)
    assert.strictEqual(page.headers["content-type"], "text/html; charset=utf-8")
    assert.match(String(page.headers["content-security-policy"]), /default-src 'none'/)
    assert.strictEqual(page.text, "<p>hi</p>")

    const redirect = await serve((_req, res) => sendPlugin(res, { status: 302, body: null, headers: { Location: "/admin" } }))
    assert.strictEqual(redirect.status, 302)
    assert.strictEqual(redirect.headers["location"], "/admin")
    assert.strictEqual(redirect.text, "")

    const json = await serve((_req, res) => sendPlugin(res, { status: 200, body: { items: [] } }))
    assert.strictEqual(json.headers["content-type"], "application/json")
    assert.deepStrictEqual(JSON.parse(json.text), { items: [] })
  })

  test("a JSON body must be an object within the cap; an empty body is an empty object", async () => {
    const read = (body: string | undefined, maxBytes?: number) =>
      serve(async (req, res) => {
        try {
          sendJson(res, 200, await readJsonBody(req, maxBytes))
        } catch (error) {
          sendMessage(res, 400, error instanceof Error ? error.message : String(error))
        }
      }, body)
    const message = (reply: Reply) => (JSON.parse(reply.text) as { error: { message: string } }).error.message

    assert.deepStrictEqual(JSON.parse((await read("{\"name\":\"ann\"}")).text), { name: "ann" })
    assert.deepStrictEqual(JSON.parse((await read("")).text), {})
    assert.strictEqual(message(await read("[1]")), "The request body must be a JSON object.")
    assert.strictEqual(message(await read("null")), "The request body must be a JSON object.")
    assert.strictEqual(message(await read("{nope")), "The request body is not JSON.")
    assert.strictEqual(message(await read("{\"a\":\"bbbbbbbb\"}", 8)), "The request body is too large.")
    assert.strictEqual(MAX_JSON_BODY_BYTES, 16 * 1024)
  })
})

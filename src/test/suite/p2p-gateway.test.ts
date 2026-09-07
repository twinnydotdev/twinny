import * as assert from "assert"
import http from "node:http"

import { TwinnyProvider } from "../../common/types"
import { resolveProviderEndpoint, setP2pGateway } from "../../extension/p2p/endpoint"
import {
  matchGatewayRoute,
  P2pGateway,
  statusForError
} from "../../extension/p2p/gateway"
import {
  InferenceHandlers,
  P2pClient,
  P2pRequestError,
  RemoteModel
} from "../../p2p"

const TOKEN = "0".repeat(32)
const DEVICE = "a".repeat(64)

/** Only what the gateway touches on a client. */
class FakeClient {
  public connected = true
  public last?: { kind: string; body: Record<string, unknown> }
  public cancelled = false
  public connectError?: Error
  public models: RemoteModel[] = [{ name: "qwen3:8b" }, { name: "codellama:7b-code" }]

  async connect() {
    if (this.connectError) throw this.connectError
  }

  async listModels() {
    return this.models
  }

  infer(kind: string, body: Record<string, unknown>, handlers: InferenceHandlers) {
    this.last = { kind, body }
    const timers: ReturnType<typeof setTimeout>[] = []
    timers.push(
      setTimeout(() => handlers.onHead?.({ id: "x", type: "head", status: 200, contentType: "application/x-ndjson" }), 5),
      setTimeout(() => handlers.onChunk("{\"response\":\"hel\"}\n"), 10),
      setTimeout(() => handlers.onChunk("{\"response\":\"lo\"}\n"), 15),
      setTimeout(() => handlers.onEnd(), 20)
    )
    return {
      cancel: () => {
        this.cancelled = true
        timers.forEach(clearTimeout)
      }
    }
  }
}

const request = (
  port: number,
  method: string,
  path: string,
  body?: string
): Promise<{ status: number; text: string; type?: string }> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { "Content-Type": "application/json" } },
      (res) => {
        let text = ""
        res.on("data", (chunk) => (text += chunk))
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, text, type: res.headers["content-type"] })
        )
      }
    )
    req.on("error", reject)
    if (body) req.write(body)
    req.end()
  })

suite("P2P gateway routing", () => {
  test("matches only the allowed routes with the right method", () => {
    const base = `/p2p/${TOKEN}/${DEVICE}`
    assert.deepStrictEqual(matchGatewayRoute("GET", `${base}/api/tags`), {
      token: TOKEN,
      deviceId: DEVICE,
      route: "tags"
    })
    assert.strictEqual(matchGatewayRoute("POST", `${base}/v1/chat/completions`)?.route, "chat")
    assert.strictEqual(matchGatewayRoute("POST", `${base}/api/generate/`)?.route, "generate")
    assert.strictEqual(matchGatewayRoute("POST", `${base}/api/embed`)?.route, "embed")
    assert.strictEqual(matchGatewayRoute("GET", `${base}/v1/models`)?.route, "models")

    assert.strictEqual(matchGatewayRoute("POST", `${base}/api/tags`), undefined)
    assert.strictEqual(matchGatewayRoute("POST", `${base}/api/pull`), undefined)
    assert.strictEqual(matchGatewayRoute("GET", `${base}/api/../api/tags`), undefined)
    assert.strictEqual(matchGatewayRoute("GET", `/p2p/short/${DEVICE}/api/tags`), undefined)
    assert.strictEqual(matchGatewayRoute("GET", "/api/tags"), undefined)
  })

  test("maps failures onto statuses the provider error text understands", () => {
    assert.strictEqual(statusForError(new P2pRequestError("timeout", "")), 504)
    assert.strictEqual(statusForError(new P2pRequestError("disconnected", "")), 503)
    assert.strictEqual(statusForError(new P2pRequestError("unauthorized", "")), 403)
    assert.strictEqual(statusForError(new P2pRequestError("busy", "")), 429)
    assert.strictEqual(statusForError(new Error("boom")), 502)
  })
})

suite("P2P gateway server", () => {
  let gateway: P2pGateway
  let client: FakeClient
  let port: number

  suiteSetup(async () => {
    client = new FakeClient()
    gateway = new P2pGateway(async (deviceId) => {
      if (deviceId !== DEVICE) {
        throw new P2pRequestError("unauthorized", "That device is no longer paired.")
      }
      return client as unknown as P2pClient
    })
    port = await gateway.start()
    setP2pGateway(gateway)
  })

  suiteTeardown(async () => {
    setP2pGateway(undefined)
    await gateway.stop()
  })

  const base = () => gateway.addressFor(DEVICE)?.basePath || ""

  test("points a P2P provider at itself, per job", () => {
    const p2p: TwinnyProvider = {
      id: "1", label: "Home", modelName: "m", provider: "twinny-p2p", type: "chat", deviceId: DEVICE
    }
    const chat = resolveProviderEndpoint(p2p)
    assert.strictEqual(chat.apiHostname, "127.0.0.1")
    assert.strictEqual(chat.apiPort, port)
    assert.strictEqual(chat.apiPath, `${base()}/v1`)
    const fim = resolveProviderEndpoint({ ...chat, type: "fim" })
    assert.strictEqual(fim.apiPath, `${base()}/api/generate`)
    const embed = resolveProviderEndpoint({ ...chat, type: "embedding" })
    assert.strictEqual(embed.apiPath, `${base()}/api/embed`)
    // Other providers pass straight through.
    const ollama: TwinnyProvider = { id: "2", label: "o", modelName: "m", provider: "ollama", type: "chat", apiHostname: "localhost" }
    assert.strictEqual(resolveProviderEndpoint(ollama), ollama)
  })

  test("lists models in Ollama's and OpenAI's shapes", async () => {
    const tags = await request(port, "GET", `${base()}/api/tags`)
    assert.strictEqual(tags.status, 200)
    assert.deepStrictEqual(
      JSON.parse(tags.text).models.map((m: { name: string }) => m.name),
      ["qwen3:8b", "codellama:7b-code"]
    )
    const models = await request(port, "GET", `${base()}/v1/models`)
    assert.deepStrictEqual(
      JSON.parse(models.text).data.map((m: { id: string }) => m.id),
      ["qwen3:8b", "codellama:7b-code"]
    )
  })

  test("streams an inference reply with the upstream status and type", async () => {
    const reply = await request(
      port,
      "POST",
      `${base()}/api/generate`,
      JSON.stringify({ model: "qwen3:8b", prompt: "hi", stream: true })
    )
    assert.strictEqual(reply.status, 200)
    assert.strictEqual(reply.type, "application/x-ndjson")
    assert.strictEqual(reply.text, "{\"response\":\"hel\"}\n{\"response\":\"lo\"}\n")
    assert.strictEqual(client.last?.kind, "generate")
    assert.strictEqual(client.last?.body.prompt, "hi")
  })

  test("refuses bad tokens, unknown routes and bodies without a model", async () => {
    const wrongToken = await request(port, "GET", `/p2p/${"f".repeat(32)}/${DEVICE}/api/tags`)
    assert.strictEqual(wrongToken.status, 404)
    const pull = await request(port, "POST", `${base()}/api/pull`, "{}")
    assert.strictEqual(pull.status, 404)
    const noModel = await request(port, "POST", `${base()}/api/generate`, JSON.stringify({ prompt: "x" }))
    assert.strictEqual(noModel.status, 400)
    assert.match(JSON.parse(noModel.text).error.message, /model/)
  })

  test("reports an unpaired device and an unreachable one", async () => {
    const unpaired = await request(port, "GET", `/p2p/${gateway.token}/${"b".repeat(64)}/api/tags`)
    assert.strictEqual(unpaired.status, 403)
    assert.match(JSON.parse(unpaired.text).error.message, /no longer paired/)

    client.connectError = new P2pRequestError("timeout", "Could not reach the device.")
    const offline = await request(port, "POST", `${base()}/api/generate`, JSON.stringify({ model: "m" }))
    client.connectError = undefined
    assert.strictEqual(offline.status, 504)
    assert.match(JSON.parse(offline.text).error.message, /Could not reach/)
  })

  test("cancels the remote request when the caller hangs up", async () => {
    client.cancelled = false
    await new Promise<void>((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "POST", path: `${base()}/api/generate` },
        (res) => {
          // Hang up as soon as the first byte arrives.
          res.once("data", () => {
            req.destroy()
            setTimeout(resolve, 50)
          })
        }
      )
      req.on("error", () => undefined)
      req.end(JSON.stringify({ model: "m", prompt: "p" }))
    })
    assert.strictEqual(client.cancelled, true)
  })
})

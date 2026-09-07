/**
 * The node and the client together, over a private DHT on localhost.
 *
 * Covers what the acceptance criteria ask of the transport: pair, list,
 * stream, cancel, refuse strangers, survive a node restart without pairing
 * again, and say so when Ollama is gone.
 */
import * as assert from "assert"
import createTestnet from "hyperdht/testnet"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

import { TrustStore } from "../../node/peers"
import { NODE_EVENT, TwinnyNode } from "../../node/server"
import {
  createSeed,
  decodePairingCode,
  P2pClient,
  P2pRequestError,
  PeerNetwork
} from "../../p2p"

interface Testnet {
  bootstrap: unknown[]
  destroy: () => Promise<void>
}

const startFakeOllama = async () => {
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      if (req.url === "/api/version") {
        res.end(JSON.stringify({ version: "0.0.0" }))
        return
      }
      if (req.url === "/api/tags") {
        res.end(
          JSON.stringify({
            models: [
              { name: "qwen3:8b", size: 1, details: { parameter_size: "8B" } },
              { name: "codellama:7b-code" }
            ]
          })
        )
        return
      }
      if (req.url === "/api/generate") {
        const { prompt } = JSON.parse(body) as { prompt: string }
        res.writeHead(200, { "content-type": "application/x-ndjson" })
        const words = ["hello", " ", "world", ` ${prompt.length}`]
        let i = 0
        const timer = setInterval(() => {
          if (res.destroyed) {
            clearInterval(timer)
            return
          }
          if (i < words.length) {
            res.write(
              JSON.stringify({ response: words[i++], done: false }) + "\n"
            )
          } else {
            clearInterval(timer)
            res.end(JSON.stringify({ response: "", done: true }) + "\n")
          }
        }, 15)
        res.on("close", () => clearInterval(timer))
        return
      }
      res.writeHead(404)
      res.end("nope")
    })
  })
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  )
  const { port } = server.address() as { port: number }
  return { server, url: `http://127.0.0.1:${port}` }
}

const generate = (client: P2pClient, prompt: string) =>
  new Promise<{ text: string; error?: P2pRequestError; status?: number }>(
    (resolve) => {
      const chunks: string[] = []
      let status: number | undefined
      client.infer(
        "generate",
        { model: "qwen3:8b", prompt, stream: true },
        {
          onHead: (head) => (status = head.status),
          onChunk: (chunk) => chunks.push(chunk),
          onEnd: () => resolve({ text: chunks.join(""), status }),
          onError: (error) => resolve({ text: chunks.join(""), error, status })
        }
      )
    }
  )

const tokensOf = (ndjson: string) =>
  ndjson
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { response: string }).response)
    .join("")

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

suite("P2P node and client", function () {
  this.timeout(90_000)

  let testnet: Testnet
  let ollama: { server: http.Server; url: string }
  let trustFile: string
  const nodeSeed = createSeed()
  let node: TwinnyNode
  let network: PeerNetwork
  let strangers: PeerNetwork
  let client: P2pClient

  const startNode = async () => {
    const started = new TwinnyNode({
      seed: nodeSeed,
      name: "test-node",
      ollamaUrl: ollama.url,
      trust: new TrustStore(trustFile),
      bootstrap: testnet.bootstrap
    })
    await started.start()
    return started
  }

  suiteSetup(async () => {
    testnet = (await createTestnet(3)) as Testnet
    ollama = await startFakeOllama()
    trustFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "twinny-p2p-")),
      "trusted.json"
    )
    node = await startNode()
    network = new PeerNetwork(
      { seed: createSeed(), bootstrap: testnet.bootstrap },
      { connectTimeoutMs: 15_000, firstByteTimeoutMs: 10_000 }
    )
    strangers = new PeerNetwork(
      { seed: createSeed(), bootstrap: testnet.bootstrap },
      { connectTimeoutMs: 4_000 }
    )
  })

  suiteTeardown(async () => {
    await network?.destroy()
    await strangers?.destroy()
    await node?.stop()
    ollama?.server.close()
    await testnet?.destroy()
  })

  test("a stranger cannot connect while pairing is closed", async () => {
    const stranger = strangers.client(node.publicKey)
    await assert.rejects(stranger.connect(), (error: P2pRequestError) => {
      assert.strictEqual(error.code, "timeout")
      return true
    })
  })

  test("pairs with the code, once", async () => {
    const code = node.openPairing()
    const { publicKey, secret } = decodePairingCode(code)
    assert.strictEqual(publicKey.toString("hex"), node.publicKeyHex)

    let paired: { name: string } | undefined
    node.once(NODE_EVENT.paired, (event: { name: string }) => (paired = event))

    client = network.client(publicKey)
    await client.connect()
    const info = await client.pair(secret, "laptop")
    assert.strictEqual(info.name, "test-node")
    assert.strictEqual(paired?.name, "laptop")
    assert.strictEqual(node.pairingOpen, false)
    assert.ok(node.trust.has(network.publicKeyHex))
  })

  test("pings and lists the remote models", async () => {
    const pong = await client.ping()
    assert.strictEqual(pong.ollama, true)
    assert.ok(pong.latencyMs >= 0)
    const models = await client.listModels()
    assert.deepStrictEqual(
      models.map((m) => m.name),
      ["qwen3:8b", "codellama:7b-code"]
    )
    assert.strictEqual(models[0].parameterSize, "8B")
  })

  test("streams tokens and relays the upstream status", async () => {
    const result = await generate(client, "hi")
    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.status, 200)
    assert.strictEqual(tokensOf(result.text), "hello world 2")
  })

  test("cancel stops a running generation", async () => {
    let cancelled: P2pRequestError | undefined
    const handle = client.infer(
      "generate",
      { model: "qwen3:8b", prompt: "long", stream: true },
      {
        onChunk: () => handle.cancel(),
        onEnd: () => undefined,
        onError: (error) => (cancelled = error)
      }
    )
    await sleep(300)
    assert.strictEqual(cancelled?.code, "cancelled")
  })

  test("a wrong secret is refused and voids the code", async () => {
    node.openPairing()
    const stranger = strangers.client(node.publicKey)
    await stranger.connect()
    await assert.rejects(
      stranger.pair(Buffer.alloc(8, 7), "intruder"),
      (error: P2pRequestError) => {
        assert.strictEqual(error.code, "pairing-failed")
        return true
      }
    )
    assert.strictEqual(node.pairingOpen, false)
    await sleep(800)
    assert.strictEqual(stranger.connected, false)
    assert.strictEqual(node.trust.has(strangers.publicKeyHex), false)
  })

  test("a stranger who connects during pairing cannot infer", async () => {
    node.openPairing()
    const stranger = strangers.client(node.publicKey)
    await stranger.connect()
    await assert.rejects(stranger.listModels(), (error: P2pRequestError) => {
      assert.strictEqual(error.code, "unauthorized")
      return true
    })
    node.closePairing()
    await sleep(800)
    assert.strictEqual(stranger.connected, false)
  })

  test("reconnects after the node restarts, without pairing again", async () => {
    await node.stop()
    await sleep(300)
    assert.strictEqual(client.connected, false)

    node = await startNode()
    await client.connect()
    const pong = await client.ping()
    assert.strictEqual(pong.node.name, "test-node")
    assert.strictEqual(
      tokensOf((await generate(client, "again")).text),
      "hello world 5"
    )
  })

  test("says when Ollama is down", async () => {
    await new Promise<void>((resolve) => ollama.server.close(() => resolve()))
    const pong = await client.ping()
    assert.strictEqual(pong.ollama, false)
    const result = await generate(client, "x")
    assert.strictEqual(result.error?.code, "upstream")
    assert.match(result.error?.message || "", /could not reach Ollama/)
  })
})

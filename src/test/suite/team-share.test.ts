/**
 * The sharer on its own: reconnecting with backoff when the gateway comes
 * and goes, giving up when told to, and the one-window-per-machine lock.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as http from "http"
import { AddressInfo } from "net"
import * as os from "os"
import * as path from "path"

import { describeHandshakeFailure, Sharer } from "../../extension/team/sharer"
import { WindowLock } from "../../extension/utils/window-lock"
import { encodePeerFrame, parsePeerFrame, PEER_CLOSE } from "../../protocol/peer"
import { acceptUpgrade, refuseUpgrade, WebSocketConnection, WebSocketHandshakeError } from "../../protocol/websocket"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const until = async (check: () => boolean, ms = 4_000, what = "condition") => {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await wait(20)
  assert.ok(check(), `${what} not met in time`)
}

/** A gateway stand-in that speaks just enough of the peer protocol. */
class FakeGateway {
  public server?: http.Server
  public url = ""
  public connections: WebSocketConnection[] = []
  public hellos = 0
  public refuseWith?: number

  async start(port = 0) {
    this.server = http.createServer((_req, res) => res.writeHead(404).end())
    this.server.on("upgrade", (req, socket, head) => {
      if (this.refuseWith) {
        refuseUpgrade(socket as import("net").Socket, this.refuseWith, { error: { kind: "authentication", message: "no" } })
        return
      }
      const connection = acceptUpgrade(req, socket as import("net").Socket, head)
      this.connections.push(connection)
      connection.on("message", (text) => {
        const frame = parsePeerFrame(text)
        if (frame.type === "hello") {
          this.hellos++
          void connection.send(encodePeerFrame({ type: "welcome", protocol: 1, wanted: ["m"], slots: 1 }))
        }
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  get port() {
    return (this.server?.address() as AddressInfo | undefined)?.port ?? 0
  }

  async stop() {
    for (const connection of this.connections.splice(0)) connection.destroy()
    const server = this.server
    this.server = undefined
    if (server) await new Promise((resolve) => server.close(resolve))
  }
}

const sharerFor = (gateway: FakeGateway, session?: () => Promise<{ url: string; token: string } | undefined>) =>
  new Sharer({
    session: session ?? (async () => ({ url: gateway.url, token: "tsk_x" })),
    machine: "box",
    backendKind: "ollama",
    listModels: async () => [{ id: "m", name: "m" }],
    route: () => {
      throw new Error("no jobs in this test")
    },
    reconnect: { minMs: 30, maxMs: 120 },
    silenceMs: 60_000
  })

suite("Team share: sharer lifecycle", function () {
  this.timeout(15_000)
  let gateway: FakeGateway
  let sharer: Sharer | undefined

  setup(async () => {
    gateway = new FakeGateway()
    await gateway.start()
  })

  teardown(async () => {
    sharer?.stop()
    sharer = undefined
    await gateway.stop()
  })

  test("connects, says hello, and reconnects with backoff after the gateway restarts", async () => {
    sharer = sharerFor(gateway)
    const states: string[] = []
    sharer.on("change", (status) => states.push(status.state))
    await sharer.start()
    await until(() => sharer!.state === "online")
    assert.deepStrictEqual(sharer.status().wanted, ["m"])
    assert.strictEqual(gateway.hellos, 1)

    const port = gateway.port
    await gateway.stop()
    await until(() => sharer!.state === "reconnecting")
    await wait(150)
    assert.strictEqual(sharer.state, "reconnecting", "keeps waiting while the gateway is down")

    await gateway.start(port)
    await until(() => sharer!.state === "online", 5_000, "back online")
    assert.strictEqual(gateway.hellos, 2, "one hello per connection, none while the gateway was down")
    assert.ok(states.includes("connecting") && states.includes("reconnecting"))
  })

  test("stops for good when the gateway says the key is revoked or there is no pool", async () => {
    for (const code of [PEER_CLOSE.revoked, PEER_CLOSE.notConfigured]) {
      sharer = sharerFor(gateway)
      await sharer.start()
      await until(() => sharer!.state === "online")
      gateway.connections[gateway.connections.length - 1].close(code, "no")
      await until(() => sharer!.state === "off")
      assert.ok(sharer.status().refused)
      sharer.stop()
    }
    sharer = undefined
  })

  test("a refused handshake with 401 or 404 stops; other statuses retry", async () => {
    gateway.refuseWith = 401
    sharer = sharerFor(gateway)
    await sharer.start()
    assert.strictEqual(sharer.state, "off")
    assert.ok(sharer.status().refused)
    assert.match(sharer.status().error ?? "", /refused your key/)
    sharer.stop()

    gateway.refuseWith = 502
    sharer = sharerFor(gateway)
    await sharer.start()
    assert.strictEqual(sharer.state, "reconnecting")
    assert.match(sharer.status().error ?? "", /HTTP 502.*WebSocket upgrades/)
    gateway.refuseWith = undefined
    await until(() => sharer!.state === "online", 5_000, "online once the proxy behaves")
  })

  test("without a team session there is nothing to share", async () => {
    sharer = sharerFor(gateway, async () => undefined)
    await sharer.start()
    assert.strictEqual(sharer.state, "off")
    assert.match(sharer.status().error ?? "", /Connect to a team/)
  })

  test("handshake failures read as advice", () => {
    assert.match(describeHandshakeFailure(new WebSocketHandshakeError("x", 400)), /enable WebSocket upgrades for \/twinny\/v1\/peers/)
    assert.match(describeHandshakeFailure(new WebSocketHandshakeError("x", 404)), /no team pool/)
    assert.match(describeHandshakeFailure(new Error("ECONNREFUSED")), /ECONNREFUSED/)
  })
})

suite("Team share: window lock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-lock-test-"))

  test("one holder per machine; a dead holder is taken over; a live one is respected", () => {
    const first = new WindowLock({ dir, name: "a.lock" })
    assert.ok(first.acquire())
    assert.ok(first.acquire(), "re-acquiring in the same process is fine")
    const second = new WindowLock({ dir, name: "a.lock" })
    assert.ok(second.acquire(), "the same pid holds it, so a second instance in this process may too")
    first.release()
    assert.ok(!fs.existsSync(first.path))

    fs.writeFileSync(first.path, JSON.stringify({ pid: 2 ** 22 - 7, since: 0 }))
    assert.ok(new WindowLock({ dir, name: "a.lock" }).acquire(), "a dead pid's lock is taken over")

    // The parent process is alive and not us: its lock is respected.
    fs.writeFileSync(first.path, JSON.stringify({ pid: process.ppid, since: 0 }))
    assert.ok(!new WindowLock({ dir, name: "a.lock" }).acquire())
    fs.unlinkSync(first.path)
  })
})

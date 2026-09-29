/**
 * Sign-in requests: the in-memory store on its own (with a fake clock),
 * then an in-process gateway where a client with no credential asks for a
 * code, an admin approves it, and the client collects a working key once.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as http from "http"
import * as os from "os"
import * as path from "path"

import { providerRegistry } from "../../extension/inference/registry"
import { parseGatewayConfig, readGatewaySecrets } from "../../gateway/config"
import { KeyStore } from "../../gateway/keys"
import { LicenseStore } from "../../gateway/license"
import { createGatewayLog } from "../../gateway/log"
import { buildRouteTable } from "../../gateway/routes"
import { GatewayServer } from "../../gateway/server"
import {
  MAX_PENDING_PER_ADDRESS,
  MAX_PENDING_SIGNINS,
  SIGNIN_POLL_INTERVAL_S,
  SIGNIN_TTL_MS,
  SignInRequests
} from "../../gateway/signin"
import { RemoteInferenceProvider } from "../../protocol/client"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-signin-test-"))

suite("Sign-in requests", () => {
  let now: number
  let requests: SignInRequests
  const mint = (name: string) => () => ({ key: `tsk_${name}`, name })

  setup(() => {
    now = 1_000_000
    requests = new SignInRequests(() => now)
  })

  test("a request gets a readable code, is listed for the admin, and hands over its key exactly once", () => {
    const started = requests.start({ name: "alice", machine: "laptop", address: "10.0.0.1" })
    assert.match(started.userCode, /^[BCDFGHJKMNPQRSTVWXYZ23456789]{4}-[BCDFGHJKMNPQRSTVWXYZ23456789]{4}$/)
    assert.match(started.deviceCode, /^[0-9a-f]{64}$/)
    assert.strictEqual(started.interval, SIGNIN_POLL_INTERVAL_S)
    assert.strictEqual(Date.parse(started.expiresAt), now + SIGNIN_TTL_MS)
    const [pending] = requests.pending()
    assert.deepStrictEqual(pending, {
      userCode: started.userCode,
      name: "alice",
      machine: "laptop",
      createdAt: new Date(now).toISOString(),
      expiresAt: started.expiresAt
    })
    assert.ok(!JSON.stringify(requests.pending()).includes(started.deviceCode), "device code shown to the admin")

    assert.deepStrictEqual(requests.poll(started.deviceCode), { status: "pending" })
    assert.deepStrictEqual(requests.poll(started.deviceCode), { status: "slow-down" })
    now += SIGNIN_POLL_INTERVAL_S * 1000
    assert.deepStrictEqual(requests.poll(started.deviceCode), { status: "pending" })

    // Lower-case and padded codes are accepted from a human.
    assert.strictEqual(requests.approve(` ${started.userCode.toLowerCase()} `, mint("alice-key")), "alice-key")
    assert.deepStrictEqual(requests.pending(), [])
    assert.deepStrictEqual(requests.poll(started.deviceCode), { status: "approved", key: "tsk_alice-key", name: "alice-key" })
    assert.deepStrictEqual(requests.poll(started.deviceCode), { status: "expired" }, "a collected key is gone")
    assert.throws(() => requests.approve(started.userCode, mint("again")), /No sign-in request is waiting/)
  })

  test("denied, expired, unknown and malformed codes; a failed mint leaves the request pending", () => {
    const denied = requests.start({ address: "a" })
    requests.deny(denied.userCode)
    assert.deepStrictEqual(requests.poll(denied.deviceCode), { status: "denied" })
    assert.deepStrictEqual(requests.poll(denied.deviceCode), { status: "expired" })

    const late = requests.start({ address: "a" })
    now += SIGNIN_TTL_MS
    assert.deepStrictEqual(requests.poll(late.deviceCode), { status: "expired" })
    assert.throws(() => requests.approve(late.userCode, mint("x")), /expired/)

    assert.deepStrictEqual(requests.poll("nope"), { status: "expired" })
    assert.deepStrictEqual(requests.poll(undefined), { status: "expired" })
    assert.throws(() => requests.approve("ABCD1234", mint("x")), /not a sign-in code/)

    const stuck = requests.start({ address: "a" })
    assert.throws(
      () =>
        requests.approve(stuck.userCode, () => {
          throw new Error("No seat")
        }),
      /No seat/
    )
    assert.strictEqual(requests.pending().length, 1, "a refused mint must keep the request")
    assert.deepStrictEqual(requests.poll(stuck.deviceCode), { status: "pending" })
  })

  test("suggested names are cleaned, one address is capped, and the total is bounded", () => {
    const odd = requests.start({ name: "  bob  ", machine: "<script>", address: "b" })
    const [row] = requests.pending()
    assert.strictEqual(row.name, "bob")
    assert.strictEqual(row.machine, undefined)
    assert.strictEqual(requests.start({ name: 42, address: "b" }).userCode.length, 9)
    requests.deny(odd.userCode)

    for (let i = 0; i < MAX_PENDING_PER_ADDRESS; i++) requests.start({ address: "c" })
    assert.throws(() => requests.start({ address: "c" }), /Too many sign-in requests/)
    assert.strictEqual(requests.start({ address: "d" }).userCode.length, 9)

    const many = new SignInRequests(() => now)
    const first = many.start({ address: "0" })
    for (let i = 1; i < MAX_PENDING_SIGNINS; i++) many.start({ address: String(i) })
    assert.strictEqual(many.size, MAX_PENDING_SIGNINS)
    many.start({ address: "overflow" })
    assert.strictEqual(many.size, MAX_PENDING_SIGNINS)
    assert.deepStrictEqual(many.poll(first.deviceCode), { status: "expired" }, "the oldest request is the one dropped")
  })
})

/* -------------------------------------------------------------------------- */

interface Reply {
  status: number
  body: Record<string, unknown>
}

const request = (url: string, method: string, key: string | undefined, body?: unknown): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const target = new URL(url)
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method,
        headers: {
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let text = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => (text += chunk))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }))
      }
    )
    req.on("error", reject)
    req.end(payload)
  })

const message = (reply: Reply) => String((reply.body.error as { message?: string } | undefined)?.message ?? "")

suite("Gateway sign-in (in process)", function () {
  this.timeout(20_000)
  const dir = path.join(scratch, "gateway")
  let server: GatewayServer
  let url: string
  let keys: KeyStore
  let admin: string
  let developer: string
  let clock = Date.now()
  const signIns = new SignInRequests(() => clock)

  suiteSetup(async () => {
    const config = parseGatewayConfig(
      {
        listen: { host: "127.0.0.1", port: 0 },
        auth: { tokenEnv: null, keysFile: path.join(dir, "keys.json"), licenseFile: path.join(dir, "license") },
        usage: { dir: path.join(dir, "usage") },
        providers: { local: { provider: "ollama", apiHostname: "127.0.0.1", apiPort: 1 } },
        models: [{ alias: "coder", provider: "local", model: "x", capabilities: ["chat"] }]
      },
      providerRegistry.providerIds()
    )
    keys = KeyStore.open(config.auth.keysFile, 0)
    admin = keys.create("operator", { admin: true }).key
    developer = keys.create("dev").key
    const license = LicenseStore.open(config.auth.licenseFile, [], 0)
    const routes = buildRouteTable(config, readGatewaySecrets(config, {}, keys.active().length), providerRegistry)
    server = new GatewayServer({ config, keys, license, routes, log: createGatewayLog(() => undefined), signIns })
    url = (await server.start()).url
  })

  suiteTeardown(async () => {
    await server.stop()
  })

  test("a developer with no key gets a code, the admin approves it, and the key works once collected", async () => {
    const client = new RemoteInferenceProvider({ baseUrl: url })
    const started = await client.startSignIn({ name: "alice", machine: "alice-laptop" })
    assert.match(started.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)

    assert.deepStrictEqual(await client.pollSignIn(started.deviceCode), { status: "pending" })
    assert.deepStrictEqual(await client.pollSignIn(started.deviceCode), { status: "slow-down" })

    // Only admins see or act on requests.
    assert.strictEqual((await request(`${url}/twinny/v1/admin/signin`, "GET", developer)).status, 403)
    assert.strictEqual((await request(`${url}/twinny/v1/admin/signin`, "GET", undefined)).status, 401)
    const listed = await request(`${url}/twinny/v1/admin/signin`, "GET", admin)
    assert.strictEqual(listed.status, 200)
    const rows = listed.body.requests as Array<Record<string, unknown>>
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].userCode, started.userCode)
    assert.strictEqual(rows[0].name, "alice")
    assert.strictEqual(rows[0].machine, "alice-laptop")
    assert.ok(!JSON.stringify(listed.body).includes(started.deviceCode))

    const noName = await request(`${url}/twinny/v1/admin/signin/${started.userCode}/approve`, "POST", admin, { name: "" })
    assert.strictEqual(noName.status, 400)
    assert.match(message(noName), /Give the key a name/)
    const approved = await request(`${url}/twinny/v1/admin/signin/${started.userCode.toLowerCase()}/approve`, "POST", admin, { name: "alice" })
    assert.strictEqual(approved.status, 201, JSON.stringify(approved.body))
    assert.strictEqual(approved.body.name, "alice")
    assert.ok(keys.active().some((k) => k.name === "alice"))

    clock += SIGNIN_POLL_INTERVAL_S * 1000
    const collected = await client.pollSignIn(started.deviceCode)
    assert.strictEqual(collected.status, "approved")
    if (collected.status !== "approved") return
    assert.strictEqual(collected.name, "alice")
    assert.match(collected.key, /^tsk_[0-9a-f]{8}_[0-9a-f]{64}$/)
    assert.deepStrictEqual(await client.pollSignIn(started.deviceCode), { status: "expired" })

    const whoami = await request(`${url}/twinny/v1/whoami`, "GET", collected.key)
    assert.strictEqual(whoami.status, 200)
    assert.strictEqual(whoami.body.key, "alice")
    assert.strictEqual(whoami.body.admin, undefined)
  })

  test("approving a name that already has a key needs replace, which revokes the old key without taking a seat", async () => {
    const client = new RemoteInferenceProvider({ baseUrl: url })
    const before = keys.active().find((k) => k.name === "alice")
    assert.ok(before, "alice was made by the previous test")

    const again = await client.startSignIn({ name: "alice", machine: "alice-new-laptop" })
    const clash = await request(`${url}/twinny/v1/admin/signin/${again.userCode}/approve`, "POST", admin, { name: "alice" })
    assert.strictEqual(clash.status, 400)
    assert.match(message(clash), /already exists.*replace/)
    assert.strictEqual(keys.active().filter((k) => k.name === "alice").length, 1, "nothing changed")

    const self = await request(`${url}/twinny/v1/admin/signin/${again.userCode}/approve`, "POST", admin, { name: "operator", replace: true })
    assert.strictEqual(self.status, 400)
    assert.match(message(self), /signed in with/)
    assert.ok(keys.active().some((k) => k.name === "operator"), "an admin cannot replace their own key by accident")

    // Fill the plan first: replacing must not need a free seat.
    keys.create("d4")
    keys.create("d5")
    try {
      assert.strictEqual(keys.active().length, 5)
      const replaced = await request(`${url}/twinny/v1/admin/signin/${again.userCode}/approve`, "POST", admin, { name: "alice", replace: true })
      assert.strictEqual(replaced.status, 201, JSON.stringify(replaced.body))
      assert.strictEqual(replaced.body.replaced, before.id)
      const after = keys.active().filter((k) => k.name === "alice")
      assert.strictEqual(after.length, 1)
      assert.notStrictEqual(after[0].id, before.id)
      assert.ok(keys.list().find((k) => k.id === before.id)?.revokedAt, "the old key is revoked")
      assert.strictEqual(keys.active().length, 5, "same seat count")

      clock += SIGNIN_POLL_INTERVAL_S * 1000
      const collected = await client.pollSignIn(again.deviceCode)
      assert.strictEqual(collected.status, "approved")
      if (collected.status !== "approved") return
      assert.strictEqual((await request(`${url}/twinny/v1/whoami`, "GET", collected.key)).status, 200)
    } finally {
      keys.revoke("d4")
      keys.revoke("d5")
    }
  })

  test("deny, unknown codes, wrong methods, and a full free plan", async () => {
    const client = new RemoteInferenceProvider({ baseUrl: url })
    const started = await client.startSignIn({})
    const denied = await request(`${url}/twinny/v1/admin/signin/${started.userCode}/deny`, "POST", admin)
    assert.strictEqual(denied.status, 200)
    assert.deepStrictEqual(await client.pollSignIn(started.deviceCode), { status: "denied" })

    const unknown = await request(`${url}/twinny/v1/admin/signin/BCDF-2345/approve`, "POST", admin, { name: "x" })
    assert.strictEqual(unknown.status, 400)
    assert.match(message(unknown), /No sign-in request is waiting/)
    assert.strictEqual((await request(`${url}/twinny/v1/admin/signin/1234-ABCD/approve`, "POST", admin, { name: "x" })).status, 400)
    assert.strictEqual((await request(`${url}/twinny/v1/signin`, "GET", undefined)).status, 405)
    assert.strictEqual((await request(`${url}/twinny/v1/signin/poll`, "POST", undefined, { deviceCode: "zzz" })).status, 200)

    // Fill the free plan: 2 keys exist plus alice = 3; two more, then approval has no seat.
    keys.create("d4")
    keys.create("d5")
    const waiting = await client.startSignIn({ name: "frank" })
    const full = await request(`${url}/twinny/v1/admin/signin/${waiting.userCode}/approve`, "POST", admin, { name: "frank" })
    assert.strictEqual(full.status, 409)
    assert.match(message(full), /free plan allows 5/)
    clock += SIGNIN_POLL_INTERVAL_S * 1000
    assert.deepStrictEqual(await client.pollSignIn(waiting.deviceCode), { status: "pending" }, "the request survives a refused approval")
    assert.ok(!keys.active().some((k) => k.name === "frank"))
  })
})

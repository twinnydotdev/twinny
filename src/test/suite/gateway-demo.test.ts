/**
 * Demo mode: an in-process gateway where the page's visitor reads the admin
 * API and changes nothing, a guest gets a key that holds no seat and
 * expires, and the same routes stay shut on a gateway that is not a demo.
 * Then the serve flags that say where to listen.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as http from "http"
import * as os from "os"
import * as path from "path"

import { providerRegistry } from "../../extension/inference/registry"
import { parseGatewayConfig, readGatewaySecrets } from "../../gateway/config"
import { capOutputTokens, DEFAULT_DEMO, DEMO_VISITOR, DEMO_VISITOR_TOKEN, InviteThrottle, isGuestName } from "../../gateway/demo"
import { invitesFileFor, InviteStore, isInviteCode } from "../../gateway/invites"
import { KeyStore } from "../../gateway/keys"
import { LicenseStore } from "../../gateway/license"
import { createGatewayLog } from "../../gateway/log"
import { buildRouteTable } from "../../gateway/routes"
import { parseServeArgs } from "../../gateway/serve"
import { GatewayServer } from "../../gateway/server"
import type { RemoteRouteTarget } from "../../protocol/handler"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-demo-test-"))

const request = (
  target: string,
  method: string,
  token: string | undefined,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown>; text: string }> =>
  new Promise((resolve, reject) => {
    const url = new URL(target)
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", ...headers }
      },
      (res) => {
        let text = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => (text += chunk))
        res.on("end", () => {
          let parsed: Record<string, unknown> = {}
          try {
            parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}
          } catch {
            // The admin page is HTML.
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, text })
        })
      }
    )
    req.on("error", reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })

const message = (response: { body: Record<string, unknown> }): string =>
  String((response.body.error as { message?: string } | undefined)?.message ?? "")

const build = (dir: string, demo: boolean) => {
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
  const keys = KeyStore.open(config.auth.keysFile, 0)
  const license = LicenseStore.open(config.auth.licenseFile, [], 0)
  const routes = buildRouteTable(config, readGatewaySecrets(config, {}, 1), providerRegistry)
  const invites = InviteStore.open(invitesFileFor(config.auth.keysFile))
  const server = new GatewayServer({
    config,
    keys,
    license,
    routes,
    log: createGatewayLog(() => undefined),
    invites,
    ...(demo ? { demo: { ...DEFAULT_DEMO, invitesPerHour: 3, maxGuests: 4 } } : {})
  })
  return { server, keys, invites }
}

suite("Gateway demo mode (in process)", function () {
  this.timeout(20_000)
  let server: GatewayServer
  let keys: KeyStore
  let url: string

  suiteSetup(async () => {
    const built = build(path.join(scratch, "demo"), true)
    server = built.server
    keys = built.keys
    // The free plan's five seats, all taken by the team.
    keys.create("operator", { admin: true })
    for (const name of ["alice", "bob", "carol", "dan"]) keys.create(name)
    url = (await server.start()).url
  })

  suiteTeardown(async () => {
    await server.stop()
  })

  test("the page is marked as a demo and the visitor is a read-only admin", async () => {
    const page = await request(`${url}/admin`, "GET", undefined)
    assert.match(page.text, /<html[^>]* data-demo="1"/)

    const who = await request(`${url}/twinny/v1/whoami`, "GET", DEMO_VISITOR_TOKEN)
    assert.strictEqual(who.status, 200)
    assert.strictEqual(who.body.key, DEMO_VISITOR)
    assert.strictEqual(who.body.admin, true)

    for (const route of ["keys", "usage", "invites", "config", "license", "peers"]) {
      const read = await request(`${url}/twinny/v1/admin/${route}`, "GET", DEMO_VISITOR_TOKEN)
      assert.notStrictEqual(read.status, 401, route)
      assert.notStrictEqual(read.status, 403, route)
    }
  })

  test("the visitor changes nothing, reads no recorded content and runs no model", async () => {
    const before = keys.list().length
    const attempts: [string, string, unknown?][] = [
      ["POST", "keys", { name: "mallory", admin: true }],
      ["POST", `keys/${keys.list()[1].id}/revoke`],
      ["POST", "invites", { name: "mallory" }],
      ["PUT", "config", {}],
      ["PUT", "license", { token: "x" }],
      ["DELETE", "license"],
      ["POST", "provider-models", { provider: { provider: "ollama", apiHostname: "10.0.0.1" } }]
    ]
    for (const [method, route, body] of attempts) {
      const refused = await request(`${url}/twinny/v1/admin/${route}`, method, DEMO_VISITOR_TOKEN, body)
      assert.strictEqual(refused.status, 403, `${method} ${route}`)
      assert.match(message(refused), /public demo/)
    }
    keys.reload()
    assert.strictEqual(keys.list().length, before)
    assert.strictEqual(keys.active().length, 5)

    assert.strictEqual((await request(`${url}/twinny/v1/admin/recordings`, "GET", DEMO_VISITOR_TOKEN)).status, 403)
    const chat = await request(`${url}/twinny/v1/chat`, "POST", DEMO_VISITOR_TOKEN, { model: "coder", messages: [{ role: "user", content: "hi" }] })
    assert.strictEqual(chat.status, 403)
  })

  test("a guest invite opens into a key that holds no seat, and guests are bounded", async () => {
    const made = await request(`${url}/twinny/v1/demo/invite`, "POST", undefined)
    assert.strictEqual(made.status, 201, JSON.stringify(made.body))
    assert.ok(isInviteCode(made.body.code))
    assert.ok(isGuestName(made.body.name as string))
    // Fifteen minutes to open it, not seven days.
    assert.ok(Date.parse(made.body.expiresAt as string) - Date.now() <= DEFAULT_DEMO.inviteTtlMs)

    // The team's seats are full, and the guest still gets in.
    const joined = await request(`${url}/twinny/v1/join`, "POST", undefined, { code: made.body.code })
    assert.strictEqual(joined.status, 201, JSON.stringify(joined.body))
    const who = await request(`${url}/twinny/v1/whoami`, "GET", joined.body.key as string)
    assert.strictEqual(who.body.key, made.body.name)
    assert.notStrictEqual(who.body.admin, true)
    assert.strictEqual((await request(`${url}/twinny/v1/admin/keys`, "GET", joined.body.key as string)).status, 403)

    // The plan counts the team, not the guest; the team's invite list leaves guests out.
    const plan = await request(`${url}/twinny/v1/admin/license`, "GET", DEMO_VISITOR_TOKEN)
    assert.strictEqual(plan.body.used, 5)
    assert.deepStrictEqual(plan.body.unseated, [])
    await request(`${url}/twinny/v1/demo/invite`, "POST", undefined, undefined, { "X-Forwarded-For": "203.0.113.7" })
    const listed = await request(`${url}/twinny/v1/admin/invites`, "GET", DEMO_VISITOR_TOKEN)
    assert.deepStrictEqual(listed.body.invites, [])

    // Three an hour per address; the proxy's header names the visitor behind loopback.
    assert.strictEqual((await request(`${url}/twinny/v1/demo/invite`, "POST", undefined)).status, 201)
    assert.strictEqual((await request(`${url}/twinny/v1/demo/invite`, "POST", undefined)).status, 201)
    const throttled = await request(`${url}/twinny/v1/demo/invite`, "POST", undefined)
    assert.strictEqual(throttled.status, 429)
    assert.match(message(throttled), /from your address/)
    // One key and three open invites are the four guests this demo takes.
    const full = await request(`${url}/twinny/v1/demo/invite`, "POST", undefined, undefined, { "X-Forwarded-For": "203.0.113.8" })
    assert.strictEqual(full.status, 429)
    assert.match(message(full), /as many guests/)
  })

  test("a guest key stops after its hour", async () => {
    const guest = keys.active().find((key) => isGuestName(key.name))
    assert.ok(guest)
    const sweep = (now: number) => server.seats.sweepGuests(now)
    sweep(Date.now() + DEFAULT_DEMO.guestTtlMs - 60_000)
    keys.reload()
    assert.ok(keys.active().some((key) => key.id === guest.id))
    sweep(Date.now() + DEFAULT_DEMO.guestTtlMs + 1_000)
    keys.reload()
    assert.ok(!keys.active().some((key) => key.id === guest.id))
    assert.strictEqual(keys.active().length, 5)
    // And is gone from the file a day after that.
    sweep(Date.now() + DEFAULT_DEMO.forgetGuestsAfterMs + DEFAULT_DEMO.guestTtlMs)
    keys.reload()
    assert.ok(!keys.list().some((key) => key.id === guest.id))
    assert.strictEqual(keys.list().length, 5)
  })
})

suite("Gateway without demo mode", function () {
  this.timeout(20_000)

  test("the visitor token and the guest route do not exist", async () => {
    const { server } = build(path.join(scratch, "plain"), false)
    const { url } = await server.start()
    try {
      const page = await request(`${url}/admin`, "GET", undefined)
      assert.doesNotMatch(page.text, /data-demo/)
      assert.strictEqual((await request(`${url}/twinny/v1/whoami`, "GET", DEMO_VISITOR_TOKEN)).status, 401)
      assert.strictEqual((await request(`${url}/twinny/v1/admin/keys`, "GET", DEMO_VISITOR_TOKEN)).status, 401)
      assert.strictEqual((await request(`${url}/twinny/v1/demo/invite`, "POST", undefined)).status, 404)
    } finally {
      await server.stop()
    }
  })
})

suite("Demo helpers and serve flags", () => {
  test("the invite throttle counts per address and forgets after an hour", () => {
    const throttle = new InviteThrottle(2)
    const t0 = Date.parse("2026-09-17T10:00:00Z")
    assert.ok(throttle.admit("a", t0))
    assert.ok(throttle.admit("a", t0 + 1))
    assert.ok(!throttle.admit("a", t0 + 2))
    assert.ok(throttle.admit("b", t0 + 3))
    assert.ok(throttle.admit("a", t0 + 60 * 60_000 + 5))
  })

  test("an output cap lowers what a request asks for and fills in what it leaves out", () => {
    const seen: (number | undefined)[] = []
    const client = {
      id: "fake",
      fim: (request: { maxTokens?: number }) => (seen.push(request.maxTokens), undefined),
      chat: (request: { maxTokens?: number }) => (seen.push(request.maxTokens), undefined)
    }
    const capped = capOutputTokens({ client, model: "m" } as unknown as RemoteRouteTarget, 256)
    const call = capped.client as unknown as typeof client
    call.fim({ maxTokens: 4000 })
    call.chat({})
    call.chat({ maxTokens: 64 })
    assert.deepStrictEqual(seen, [256, 256, 64])
    assert.strictEqual(capped.client.id, "fake")
  })

  test("serve takes --port, --host and --demo", () => {
    assert.deepStrictEqual(parseServeArgs(["-c", "x.json", "--port", "8790", "--host", "0.0.0.0", "--demo"]), {
      config: "x.json",
      port: 8790,
      host: "0.0.0.0",
      demo: true
    })
    assert.deepStrictEqual(parseServeArgs(["--config=x.json", "--port=0"]), { config: "x.json", port: 0 })
    assert.throws(() => parseServeArgs(["-c", "x.json", "--port", "http"]), /port number/)
    assert.throws(() => parseServeArgs(["-c", "x.json", "-p", "70000"]), /port number/)
    assert.throws(() => parseServeArgs(["-c", "x.json", "--host"]), /needs an address/)
  })
})

/**
 * Invites: the file-backed store on its own (with a fake clock), then an
 * in-process gateway where an admin makes an invite, a client with no
 * credential opens it and gets a working key once, and the seat rules
 * hold at both ends.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as http from "http"
import * as os from "os"
import * as path from "path"

import { providerRegistry } from "../../extension/inference/registry"
import { parseGatewayConfig, readGatewaySecrets } from "../../gateway/config"
import { INVITE_TTL_MS, InviteError, invitesFileFor, InviteStore, isInviteCode } from "../../gateway/invites"
import { KeyStore } from "../../gateway/keys"
import { LicenseStore } from "../../gateway/license"
import { createGatewayLog } from "../../gateway/log"
import { buildRouteTable } from "../../gateway/routes"
import { GatewayServer } from "../../gateway/server"
import { RemoteInferenceProvider } from "../../protocol/client"
import { inviteLink, teamLink } from "../../protocol/types"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-invites-test-"))

suite("Invite store", () => {
  test("an invite is a one-time code whose hash is all the file keeps", () => {
    let clock = Date.parse("2026-09-16T10:00:00Z")
    const file = path.join(scratch, "store", "invites.json")
    const store = InviteStore.open(file, () => clock)
    const taken = (name: string) => name === "bob"

    const { code, record } = store.create({ name: "alice", createdBy: "operator" }, taken)
    assert.ok(isInviteCode(code))
    assert.strictEqual(record.name, "alice")
    assert.strictEqual(record.createdBy, "operator")
    assert.strictEqual(Date.parse(record.expiresAt) - clock, INVITE_TTL_MS)
    const text = fs.readFileSync(file, "utf8")
    assert.ok(!text.includes(code.split("_")[2]), "the secret is not on disk")
    assert.ok((fs.statSync(file).mode & 0o077) === 0, "owner-only file")

    assert.deepStrictEqual(store.pending().map((invite) => invite.name), ["alice"])
    assert.throws(() => store.create({ name: "bob", createdBy: "operator" }, taken), /already exists/)
    const replacing = store.create({ name: "bob", replace: true, createdBy: "operator" }, taken)
    assert.strictEqual(replacing.record.replace, true)
    assert.throws(() => store.create({ name: "bad name!", createdBy: "operator" }, taken), /not a valid key name/)

    // A fresh store reads the same file: an invite survives a restart.
    const again = InviteStore.open(file, () => clock)
    assert.strictEqual(again.pending().length, 2)
    let minted = 0
    const opened = again.redeem(code, "alice-laptop", (invite) => {
      minted++
      assert.strictEqual(invite.name, "alice")
      return { key: "tsk_key", keyId: "k1" }
    })
    assert.deepStrictEqual(opened, { key: "tsk_key", name: "alice", admin: false })
    assert.strictEqual(minted, 1)
    assert.throws(() => again.redeem(code, undefined, () => ({ key: "x", keyId: "x" })), /already been used/)
    assert.deepStrictEqual(store.pending().map((invite) => invite.name), ["bob"], "the first store sees the redemption")

    // A refused mint leaves the invite open.
    assert.throws(
      () =>
        store.redeem(replacing.code, undefined, () => {
          throw new InviteError("no seat", 409)
        }),
      /no seat/
    )
    assert.strictEqual(store.pending().length, 1)

    // Wrong secret with a real id, unknown id, junk, withdrawn, expired.
    const [prefix, id] = code.split("_")
    assert.throws(() => store.lookup(`${prefix}_${id}_${"0".repeat(64)}`), /not known/)
    assert.throws(() => store.lookup(`${prefix}_${"0".repeat(8)}_${"0".repeat(64)}`), /not known/)
    assert.throws(() => store.lookup("hello"), /not an invite code/)
    assert.ok(store.revoke(replacing.record.id))
    assert.ok(!store.revoke(replacing.record.id), "withdrawing twice does nothing")
    assert.throws(() => store.lookup(replacing.code), /withdrawn/)
    const late = store.create({ name: "carol", createdBy: "operator" }, taken)
    clock += INVITE_TTL_MS + 1
    assert.throws(() => store.lookup(late.code), /expired/)
    assert.strictEqual(store.pending().length, 0)
  })

  test("links carry the gateway address and the code, for VS Code and its forks", () => {
    const link = inviteLink("https://ai.example.com/", "twi_00000000_" + "a".repeat(64))
    const parsed = new URL(link)
    assert.strictEqual(parsed.protocol, "vscode:")
    assert.strictEqual(parsed.host, "rjmacarthy.twinny")
    assert.strictEqual(parsed.pathname, "/join")
    assert.strictEqual(parsed.searchParams.get("url"), "https://ai.example.com")
    assert.strictEqual(parsed.searchParams.get("code"), "twi_00000000_" + "a".repeat(64))
    assert.ok(inviteLink("http://10.0.0.5:8765", "twi_x", "cursor").startsWith("cursor://rjmacarthy.twinny/join?"))
    assert.strictEqual(new URL(teamLink("https://ai.example.com")).pathname, "/team")
    assert.strictEqual(invitesFileFor("/srv/twinny/keys.json"), "/srv/twinny/invites.json")
  })
})

const request = (
  target: string,
  method: string,
  token: string | undefined,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    const url = new URL(target)
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" } },
      (res) => {
        let text = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => (text += chunk))
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} })
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    req.on("error", reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })

const message = (response: { body: Record<string, unknown> }): string =>
  String((response.body.error as { message?: string } | undefined)?.message ?? "")

suite("Gateway invites (in process)", function () {
  this.timeout(20_000)
  const dir = path.join(scratch, "gateway")
  let server: GatewayServer
  let url: string
  let keys: KeyStore
  let admin: string
  let developer: string

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
    const invites = InviteStore.open(invitesFileFor(config.auth.keysFile))
    server = new GatewayServer({ config, keys, license, routes, log: createGatewayLog(() => undefined), invites })
    url = (await server.start()).url
  })

  suiteTeardown(async () => {
    await server.stop()
  })

  test("an admin makes an invite, a developer opens it once and gets a working key", async () => {
    // Only admins make or see invites.
    assert.strictEqual((await request(`${url}/twinny/v1/admin/invites`, "GET", developer)).status, 403)
    assert.strictEqual((await request(`${url}/twinny/v1/admin/invites`, "GET", undefined)).status, 401)
    const noName = await request(`${url}/twinny/v1/admin/invites`, "POST", admin, { name: " " })
    assert.strictEqual(noName.status, 400)
    assert.match(message(noName), /Give the invite a key name/)

    const made = await request(`${url}/twinny/v1/admin/invites`, "POST", admin, { name: "alice" })
    assert.strictEqual(made.status, 201, JSON.stringify(made.body))
    const code = made.body.code as string
    assert.ok(isInviteCode(code))
    const invite = made.body.invite as Record<string, unknown>
    assert.strictEqual(invite.name, "alice")
    assert.strictEqual(invite.createdBy, "operator")
    assert.ok(!keys.active().some((k) => k.name === "alice"), "no key until the invite is opened")

    const listed = await request(`${url}/twinny/v1/admin/invites`, "GET", admin)
    const rows = listed.body.invites as Array<Record<string, unknown>>
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].id, invite.id)
    assert.ok(!JSON.stringify(listed.body).includes(code.split("_")[2]), "the list never carries the secret")

    const client = new RemoteInferenceProvider({ baseUrl: url })
    const opened = await client.join({ code, machine: "alice-laptop" })
    assert.strictEqual(opened.name, "alice")
    assert.strictEqual(opened.admin, false)
    assert.match(opened.key, /^tsk_[0-9a-f]{8}_[0-9a-f]{64}$/)
    assert.ok(keys.active().some((k) => k.name === "alice"))

    const whoami = await request(`${url}/twinny/v1/whoami`, "GET", opened.key)
    assert.strictEqual(whoami.status, 200)
    assert.strictEqual(whoami.body.key, "alice")

    const twice = await request(`${url}/twinny/v1/join`, "POST", undefined, { code })
    assert.strictEqual(twice.status, 410)
    assert.match(message(twice), /already been used/)
    assert.strictEqual(((await request(`${url}/twinny/v1/admin/invites`, "GET", admin)).body.invites as unknown[]).length, 0)
  })

  test("an admin invite makes an admin key; replace revokes the old key; withdrawn and unknown codes fail", async () => {
    const made = await request(`${url}/twinny/v1/admin/invites`, "POST", admin, { name: "alice" })
    assert.strictEqual(made.status, 409, "alice already holds a key")
    assert.match(message(made), /already exists/)

    const replacing = await request(`${url}/twinny/v1/admin/invites`, "POST", admin, { name: "alice", replace: true, admin: true })
    assert.strictEqual(replacing.status, 201)
    const before = keys.active().find((k) => k.name === "alice")?.id
    const client = new RemoteInferenceProvider({ baseUrl: url })
    const opened = await client.join({ code: replacing.body.code as string })
    assert.strictEqual(opened.admin, true)
    const after = keys.active().filter((k) => k.name === "alice")
    assert.strictEqual(after.length, 1, "one alice key holds a seat")
    assert.notStrictEqual(after[0].id, before)
    assert.strictEqual(after[0].admin, true)
    assert.strictEqual((await request(`${url}/twinny/v1/admin/invites`, "GET", opened.key)).status, 200, "the new key opens the admin page")

    const withdrawn = await request(`${url}/twinny/v1/admin/invites`, "POST", admin, { name: "bob" })
    const id = (withdrawn.body.invite as { id: string }).id
    assert.strictEqual((await request(`${url}/twinny/v1/admin/invites/${id}`, "DELETE", admin)).status, 200)
    assert.strictEqual((await request(`${url}/twinny/v1/admin/invites/${id}`, "DELETE", admin)).status, 404)
    const late = await request(`${url}/twinny/v1/join`, "POST", undefined, { code: withdrawn.body.code })
    assert.strictEqual(late.status, 410)
    assert.match(message(late), /withdrawn/)

    assert.strictEqual((await request(`${url}/twinny/v1/join`, "POST", undefined, { code: "nonsense" })).status, 400)
    assert.strictEqual((await request(`${url}/twinny/v1/join`, "GET", undefined)).status, 405)
    await assert.rejects(client.join({ code: `twi_${"0".repeat(8)}_${"0".repeat(64)}` }), /not known/)
  })

  test("a full free plan refuses the invite when made and when opened", async () => {
    // operator, dev, alice exist; two more fill the free plan.
    const open = await request(`${url}/twinny/v1/admin/invites`, "POST", admin, { name: "erin" })
    assert.strictEqual(open.status, 201)
    keys.create("d4")
    keys.create("d5")
    const full = await request(`${url}/twinny/v1/admin/invites`, "POST", admin, { name: "frank" })
    assert.strictEqual(full.status, 409)
    assert.match(message(full), /free plan allows 5/)

    const refused = await request(`${url}/twinny/v1/join`, "POST", undefined, { code: open.body.code })
    assert.strictEqual(refused.status, 409)
    assert.match(message(refused), /free plan allows 5.*Ask your admin/)
    assert.ok(!keys.active().some((k) => k.name === "erin"))
    assert.strictEqual(((await request(`${url}/twinny/v1/admin/invites`, "GET", admin)).body.invites as unknown[]).length, 1, "the invite stays open for when a seat frees up")

    keys.revoke("d5")
    const client = new RemoteInferenceProvider({ baseUrl: url })
    assert.strictEqual((await client.join({ code: open.body.code as string })).name, "erin")
  })
})

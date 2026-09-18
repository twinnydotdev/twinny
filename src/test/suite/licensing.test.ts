/**
 * The seat licence, without spawning anything: the token format and its
 * signature, what a licence entitles a gateway to over time, the licence
 * file, and an in-process gateway that installs a licence signed by a key
 * made here (so no production signing key is involved) and applies it.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as http from "http"
import * as os from "os"
import * as path from "path"

import { providerRegistry } from "../../extension/inference/registry"
import { parseGatewayConfig, readGatewaySecrets } from "../../gateway/config"
import { KeyStore } from "../../gateway/keys"
import { describePlan, LicenseStore, LicenseSummary } from "../../gateway/license"
import { createGatewayLog } from "../../gateway/log"
import { buildRouteTable } from "../../gateway/routes"
import { GatewayServer } from "../../gateway/server"
import {
  decodeLicenseToken,
  entitlementsFor,
  FREE_SEATS,
  GRACE_DAYS,
  LicenseError,
  RENEWAL_NOTICE_DAYS,
  seatedKeyIds,
  seatRefusal,
  verifyLicenseToken
} from "../../licensing"

import { buildClaims, generateSigningKeys, issueLicense, signLicense } from "./support/sign-license"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-license-test-"))
const DAY = 86_400_000
const at = (base: Date, days: number) => new Date(base.getTime() + days * DAY)

const signing = generateSigningKeys()
const other = generateSigningKeys()
const trusted = [signing.publicKeyRaw]

const codeOf = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof LicenseError, `expected a LicenseError, got ${String(error)}`)
    return error.code
  }
  assert.fail("expected a LicenseError")
}

suite("Licence tokens", () => {
  test("a token round-trips, carries its claims, and verifies against the signing key only", () => {
    const { token, claims } = issueLicense({ org: "Acme Ltd", seats: 25, validDays: 365, email: "ops@acme.example" }, signing.privateKeyPem)
    assert.match(token, /^twl1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    assert.match(claims.id, /^lic_[0-9a-f]{16}$/)
    assert.strictEqual(claims.seats, 25)
    assert.strictEqual(claims.email, "ops@acme.example")
    assert.strictEqual(Date.parse(claims.expiresAt) - Date.parse(claims.issuedAt), 365 * DAY)

    const verified = verifyLicenseToken(token, trusted)
    assert.deepStrictEqual(verified.claims, claims)
    assert.deepStrictEqual(verifyLicenseToken(token, [signing.publicKeyPem]).claims, claims)
    assert.deepStrictEqual(verifyLicenseToken(token, [other.publicKeyRaw, signing.publicKeyRaw]).claims, claims)
    assert.strictEqual(codeOf(() => verifyLicenseToken(token, [other.publicKeyRaw])), "bad-signature")
    assert.strictEqual(codeOf(() => verifyLicenseToken(token, [])), "untrusted-key")
  })

  test("a tampered or malformed token is refused before anything is trusted", () => {
    const { token } = issueLicense({ org: "Acme Ltd", seats: 5 }, signing.privateKeyPem)
    const [prefix, payload, signature] = token.split(".")
    const bigger = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), seats: 500 })).toString("base64url")
    assert.strictEqual(codeOf(() => verifyLicenseToken(`${prefix}.${bigger}.${signature}`, trusted)), "bad-signature")
    assert.strictEqual(codeOf(() => verifyLicenseToken(`${prefix}.${payload}.${signature.slice(0, -4)}`, trusted)), "malformed")
    assert.strictEqual(codeOf(() => verifyLicenseToken("twl2.a.b", trusted)), "malformed")
    assert.strictEqual(codeOf(() => verifyLicenseToken("not a token", trusted)), "malformed")
    assert.strictEqual(codeOf(() => verifyLicenseToken(`${prefix}.${payload}!.${signature}`, trusted)), "malformed")
    const notJson = Buffer.from("hello").toString("base64url")
    assert.strictEqual(codeOf(() => decodeLicenseToken(`${prefix}.${notJson}.${signature}`)), "malformed")
  })

  test("claims are checked field by field; unknown features are dropped, unknown fields refused", () => {
    const base = { org: "Acme", seats: 3, issuedAt: new Date("2026-01-01T00:00:00Z"), expiresAt: new Date("2027-01-01T00:00:00Z") }
    const sign = (claims: Record<string, unknown>) =>
      `twl1.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${"A".repeat(86)}`
    const good = buildClaims(base)
    assert.strictEqual(codeOf(() => decodeLicenseToken(sign({ ...good, extra: 1 }))), "bad-claims")
    assert.strictEqual(codeOf(() => decodeLicenseToken(sign({ ...good, seats: 0 }))), "bad-claims")
    assert.strictEqual(codeOf(() => decodeLicenseToken(sign({ ...good, seats: 2.5 }))), "bad-claims")
    assert.strictEqual(codeOf(() => decodeLicenseToken(sign({ ...good, v: 2 }))), "bad-claims")
    assert.strictEqual(codeOf(() => decodeLicenseToken(sign({ ...good, org: " padded" }))), "bad-claims")
    assert.strictEqual(codeOf(() => decodeLicenseToken(sign({ ...good, email: "nope" }))), "bad-claims")
    assert.strictEqual(codeOf(() => decodeLicenseToken(sign({ ...good, expiresAt: good.issuedAt }))), "bad-claims")
    assert.strictEqual(codeOf(() => decodeLicenseToken(sign({ ...good, issuedAt: "2026-01-01" }))), "bad-claims")
    assert.throws(() => buildClaims({ ...base, seats: -1 }), LicenseError)
    const withFeatures = decodeLicenseToken(sign({ ...good, features: ["sso", "made-up"] }))
    assert.deepStrictEqual(withFeatures.claims.features, [])
    // Signing the same claims twice gives the same token: the serialisation is what is signed.
    assert.strictEqual(signLicense(good, signing.privateKeyPem), signLicense(good, signing.privateKeyPem))
  })
})

suite("Entitlements", () => {
  const issued = new Date("2026-03-01T00:00:00Z")
  const claims = buildClaims({ org: "Acme", seats: 20, issuedAt: issued, validDays: 365 })

  test("no licence, an invalid one, or one not yet valid means the free plan", () => {
    const free = entitlementsFor(undefined)
    assert.strictEqual(free.status, "free")
    assert.strictEqual(free.seats, FREE_SEATS)
    const invalid = entitlementsFor({ invalid: "bad signature" })
    assert.strictEqual(invalid.status, "invalid")
    assert.strictEqual(invalid.seats, FREE_SEATS)
    assert.match(invalid.message, /bad signature/)
    const early = entitlementsFor({ claims }, at(issued, -1))
    assert.strictEqual(early.status, "invalid")
    assert.strictEqual(early.seats, FREE_SEATS)
    assert.strictEqual(early.org, "Acme")
  })

  test("a licence only ever adds to the free five: a token for fewer seats never takes a team below them", () => {
    const small = buildClaims({ org: "Solo", seats: 1, issuedAt: issued, validDays: 365 })
    const licensed = entitlementsFor({ claims: small }, at(issued, 10))
    assert.strictEqual(licensed.status, "licensed")
    assert.strictEqual(licensed.seats, FREE_SEATS)
    assert.match(licensed.message, /Licensed to Solo: 5 seats/)
    assert.strictEqual(entitlementsFor({ claims: small }, at(issued, 365 + 1)).seats, FREE_SEATS, "and in grace")
    assert.strictEqual(entitlementsFor({ claims: buildClaims({ org: "Six", seats: 6, issuedAt: issued, validDays: 365 }) }, at(issued, 10)).seats, 6)
  })

  test("a licence is licensed, then expiring, then in grace, then expired", () => {
    const licensed = entitlementsFor({ claims }, at(issued, 10))
    assert.strictEqual(licensed.status, "licensed")
    assert.strictEqual(licensed.seats, 20)
    assert.strictEqual(licensed.org, "Acme")
    assert.strictEqual(licensed.licenseId, claims.id)

    const expiring = entitlementsFor({ claims }, at(issued, 365 - RENEWAL_NOTICE_DAYS + 1))
    assert.strictEqual(expiring.status, "expiring")
    assert.strictEqual(expiring.seats, 20)
    assert.match(expiring.message, /Expires in \d+ day/)

    const grace = entitlementsFor({ claims }, at(issued, 365 + 1))
    assert.strictEqual(grace.status, "grace")
    assert.strictEqual(grace.seats, 20)
    assert.match(grace.message, /expired on 2027-03-01/)

    const lastGraceDay = entitlementsFor({ claims }, at(issued, 365 + GRACE_DAYS - 0.5))
    assert.strictEqual(lastGraceDay.status, "grace")

    const expired = entitlementsFor({ claims }, at(issued, 365 + GRACE_DAYS))
    assert.strictEqual(expired.status, "expired")
    assert.strictEqual(expired.seats, FREE_SEATS)
    assert.strictEqual(expired.org, "Acme")
  })

  test("seats go to the oldest keys and the refusal says which plan is the limit", () => {
    const keys = [
      { id: "c", createdAt: "2026-01-03T00:00:00Z" },
      { id: "a", createdAt: "2026-01-01T00:00:00Z" },
      { id: "b2", createdAt: "2026-01-02T00:00:00Z" },
      { id: "b1", createdAt: "2026-01-02T00:00:00Z" }
    ]
    assert.deepStrictEqual([...seatedKeyIds(keys, 3)], ["a", "b2", "b1"], "ties keep the given order")
    assert.deepStrictEqual([...seatedKeyIds(keys, 10)].sort(), ["a", "b1", "b2", "c"])
    assert.deepStrictEqual([...seatedKeyIds(keys, 0)], [])
    const free = entitlementsFor(undefined)
    assert.strictEqual(seatRefusal(free, FREE_SEATS - 1), undefined)
    assert.match(seatRefusal(free, FREE_SEATS) ?? "", /free plan allows 5/)
    const licensed = entitlementsFor({ claims }, at(issued, 10))
    assert.strictEqual(seatRefusal(licensed, 19), undefined)
    assert.match(seatRefusal(licensed, 20) ?? "", /licence for Acme allows 20/)
  })

  test("paid features apply only during validity and grace, including exact boundaries", () => {
    const paid = buildClaims({ org: "Acme", seats: 20, issuedAt: issued, validDays: 365, features: ["policy", "recording"] })
    for (const day of [-1, 365 + GRACE_DAYS, 400]) {
      const plan = entitlementsFor({ claims: paid }, at(issued, day))
      assert.strictEqual(plan.seats, FREE_SEATS)
      assert.deepStrictEqual(plan.features, [], `paid features must be disabled on day ${day}`)
      assert.strictEqual(plan.licenseId, paid.id, "retain licence details for renewal")
    }
    for (const day of [0, 10, 365 - RENEWAL_NOTICE_DAYS, 365, 365 + GRACE_DAYS - 0.001]) {
      assert.deepStrictEqual(entitlementsFor({ claims: paid }, at(issued, day)).features, ["policy", "recording"])
    }
  })
})

suite("Licence file", () => {
  test("missing means free; a good token installs with mode 600 and is picked up on refresh; a bad one changes nothing", () => {
    const file = path.join(scratch, "store", "license")
    const store = LicenseStore.open(file, trusted, 0)
    assert.strictEqual(store.installed, false)
    assert.strictEqual(store.current().status, "free")

    const { token, claims } = issueLicense({ org: "Acme", seats: 8 }, signing.privateKeyPem)
    const installed = store.install(token)
    assert.strictEqual(installed.status, "licensed")
    assert.strictEqual(installed.seats, 8)
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
    assert.strictEqual(fs.readFileSync(file, "utf8"), `${token}\n`)
    assert.strictEqual(store.claims()?.id, claims.id)

    const forged = issueLicense({ org: "Mallory", seats: 999 }, other.privateKeyPem).token
    assert.throws(() => store.install(forged), LicenseError)
    assert.strictEqual(store.claims()?.id, claims.id, "a refused token replaced the licence")
    assert.strictEqual(fs.readFileSync(file, "utf8"), `${token}\n`)

    // Another process (the CLI) writes the file: the running store notices.
    const bigger = issueLicense({ org: "Acme", seats: 30 }, signing.privateKeyPem).token
    const later = new Date(Date.now() + 5_000)
    fs.writeFileSync(file, `${bigger}\n`)
    fs.utimesSync(file, later, later)
    store.refresh(Date.now() + 10)
    assert.strictEqual(store.current().seats, 30)

    // Garbage on disk is reported, not fatal.
    fs.writeFileSync(file, "garbage\n")
    fs.utimesSync(file, new Date(later.getTime() + 5_000), new Date(later.getTime() + 5_000))
    store.refresh(Date.now() + 20)
    assert.strictEqual(store.current().status, "invalid")
    assert.strictEqual(store.current().seats, FREE_SEATS)

    assert.strictEqual(store.remove(), true)
    assert.strictEqual(store.remove(), false)
    assert.strictEqual(store.current().status, "free")
  })

  test("the summary names the keys without a seat and the plan line reads right", () => {
    const keys = KeyStore.open(path.join(scratch, "summary", "keys.json"))
    const store = LicenseStore.open(path.join(scratch, "summary", "license"), trusted, 0)
    // Seven people on a six-seat licence: one more than it allows, and more than the free five.
    const made = ["ann", "ben", "cat", "dan", "eve", "fay", "gus"].map((name) => keys.create(name).record)
    // Creation happens within the same millisecond; make the order explicit.
    made.forEach((record, i) => {
      record.createdAt = `2026-01-0${i + 1}T00:00:00Z`
    })
    const active = made
    let summary: LicenseSummary = store.summary(active)
    assert.strictEqual(summary.used, 7)
    assert.deepStrictEqual(summary.unseated, ["fay", "gus"], "the free plan seats the five oldest")
    assert.strictEqual(describePlan(summary), "Free plan, 7 of 5 seats used")

    store.install(issueLicense({ org: "Acme", seats: 6, validDays: 400 }, signing.privateKeyPem).token)
    summary = store.summary(active)
    assert.deepStrictEqual(summary.unseated, ["gus"])
    assert.strictEqual(store.seat(made[0], active), undefined)
    assert.match(store.seat(made[6], active) ?? "", /no seat/)
    assert.match(describePlan(summary), /^Acme, 7 of 6 seats used, licence until \d{4}-\d{2}-\d{2}$/)
    assert.match(store.refuseNewKey(active) ?? "", /licence for Acme allows 6/)
  })
})

/* -------------------------------------------------------------------------- */

interface Reply {
  status: number
  body: Record<string, unknown>
}

const request = (url: string, method: string, key: string, body?: unknown): Promise<Reply> =>
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
          Authorization: `Bearer ${key}`,
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

suite("Gateway seats (in process)", function () {
  this.timeout(15_000)
  const dir = path.join(scratch, "gateway")
  let server: GatewayServer
  let url: string
  let keys: KeyStore
  let license: LicenseStore
  const secrets: string[] = []

  suiteSetup(async () => {
    const config = parseGatewayConfig(
      {
        listen: { host: "127.0.0.1", port: 0 },
        auth: { tokenEnv: null, keysFile: path.join(dir, "keys.json"), licenseFile: path.join(dir, "license") },
        usage: { dir: path.join(dir, "usage") },
        providers: { local: { provider: "ollama", apiHostname: "127.0.0.1", apiPort: 1 } },
        models: [{ alias: "coder", provider: "local", model: "x", capabilities: ["chat"] }],
        teamDefaults: { chat: "coder" },
        policy: { teamOnly: true, lockDefaults: true }
      },
      providerRegistry.providerIds()
    )
    keys = KeyStore.open(config.auth.keysFile, 0)
    // Six keys, made directly (the store itself never refuses; the CLI and API do).
    for (const name of ["admin", "b", "c", "d", "e", "f"]) {
      secrets.push(keys.create(name, { admin: name === "admin" }).key)
    }
    license = LicenseStore.open(config.auth.licenseFile, trusted, 0)
    const routes = buildRouteTable(config, readGatewaySecrets(config, {}, keys.active().length), providerRegistry)
    server = new GatewayServer({ config, keys, license, routes, log: createGatewayLog(() => undefined) })
    url = (await server.start()).url
  })

  suiteTeardown(async () => {
    await server.stop()
  })

  test("on the free plan the sixth key has no seat and no more can be made", async () => {
    const plan = await request(`${url}/twinny/v1/admin/license`, "GET", secrets[0])
    assert.strictEqual(plan.status, 200)
    assert.strictEqual(plan.body.status, "free")
    assert.strictEqual(plan.body.used, 6)
    assert.deepStrictEqual(plan.body.unseated, ["f"])

    const fifth = await request(`${url}/twinny/v1/whoami`, "GET", secrets[4])
    assert.strictEqual(fifth.status, 200)
    assert.strictEqual(fifth.body.key, "e")
    const sixth = await request(`${url}/twinny/v1/whoami`, "GET", secrets[5])
    assert.strictEqual(sixth.status, 401)
    assert.match(String((sixth.body.error as { message: string }).message), /no seat/)

    const more = await request(`${url}/twinny/v1/admin/keys`, "POST", secrets[0], { name: "g" })
    assert.strictEqual(more.status, 409)
    assert.match(String((more.body.error as { message: string }).message), /free plan allows 5/)
    assert.strictEqual(keys.active().length, 6)

    const listed = await request(`${url}/twinny/v1/admin/keys`, "GET", secrets[0])
    assert.strictEqual((listed.body.plan as LicenseSummary).status, "free")
  })

  test("installing a licence through the API seats everyone at once; a forged one is refused", async () => {
    const forged = issueLicense({ org: "Mallory", seats: 100 }, other.privateKeyPem).token
    const refused = await request(`${url}/twinny/v1/admin/license`, "PUT", secrets[0], { token: forged })
    assert.strictEqual(refused.status, 400)
    assert.match(String((refused.body.error as { message: string }).message), /signature/)
    assert.strictEqual(license.installed, false)

    const { token } = issueLicense({ org: "Acme", seats: 10, validDays: 90 }, signing.privateKeyPem)
    const installed = await request(`${url}/twinny/v1/admin/license`, "PUT", secrets[0], { token })
    assert.strictEqual(installed.status, 200, JSON.stringify(installed.body))
    assert.strictEqual(installed.body.status, "licensed")
    assert.strictEqual(installed.body.org, "Acme")
    assert.strictEqual(installed.body.seats, 10)
    assert.deepStrictEqual(installed.body.unseated, [])

    const sixth = await request(`${url}/twinny/v1/whoami`, "GET", secrets[5])
    assert.strictEqual(sixth.status, 200)
    assert.strictEqual(sixth.body.key, "f")
    const seventh = await request(`${url}/twinny/v1/admin/keys`, "POST", secrets[0], { name: "g" })
    assert.strictEqual(seventh.status, 201)
    assert.strictEqual(keys.active().length, 7)

    // A developer key cannot read or change the licence.
    const dev = await request(`${url}/twinny/v1/admin/license`, "GET", secrets[1])
    assert.strictEqual(dev.status, 403)
  })

  test("removing the licence puts the newest keys back without a seat, oldest first keep theirs", async () => {
    const removed = await request(`${url}/twinny/v1/admin/license`, "DELETE", secrets[0])
    assert.strictEqual(removed.status, 200)
    assert.strictEqual(removed.body.status, "free")
    assert.deepStrictEqual(removed.body.unseated, ["f", "g"])
    const admin = await request(`${url}/twinny/v1/whoami`, "GET", secrets[0])
    assert.strictEqual(admin.status, 200, "the admin key made first must keep its seat")
    const sixth = await request(`${url}/twinny/v1/whoami`, "GET", secrets[5])
    assert.strictEqual(sixth.status, 401)
  })

  test("the team policy is sent only while the licence carries the policy feature", async () => {
    const team = () => request(`${url}/twinny/v1/team`, "GET", secrets[0])
    assert.strictEqual((await team()).body.policy, undefined, "free plan must not send a policy")
    assert.deepStrictEqual((await team()).body.defaults, { chat: "coder" })

    const plain = issueLicense({ org: "Acme", seats: 10 }, signing.privateKeyPem).token
    assert.strictEqual((await request(`${url}/twinny/v1/admin/license`, "PUT", secrets[0], { token: plain })).status, 200)
    assert.strictEqual((await team()).body.policy, undefined, "a licence without the feature must not send a policy")

    const withPolicy = issueLicense({ org: "Acme", seats: 10, features: ["policy", "made-up"] }, signing.privateKeyPem)
    assert.deepStrictEqual(withPolicy.claims.features, ["policy"], "unknown features are dropped at issue")
    const installed = await request(`${url}/twinny/v1/admin/license`, "PUT", secrets[0], { token: withPolicy.token })
    assert.deepStrictEqual(installed.body.features, ["policy"])
    assert.deepStrictEqual((await team()).body.policy, { teamOnly: true, lockDefaults: true })

    for (const issuedAt of [at(new Date(), -400), at(new Date(), 1)]) {
      const inactive = issueLicense({ org: "Acme", seats: 10, issuedAt, validDays: 365, features: ["policy", "recording"] }, signing.privateKeyPem)
      const result = await request(`${url}/twinny/v1/admin/license`, "PUT", secrets[0], { token: inactive.token })
      assert.strictEqual(result.status, 200)
      assert.deepStrictEqual(result.body.features, [])
      assert.strictEqual((await team()).body.policy, undefined, "inactive licences must not enforce paid policy")
    }

    await request(`${url}/twinny/v1/admin/license`, "DELETE", secrets[0])
    assert.strictEqual((await team()).body.policy, undefined)
  })
})

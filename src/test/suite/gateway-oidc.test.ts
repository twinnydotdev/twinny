/**
 * The OIDC plugin against a stand-in identity provider: discovery, the
 * redirect with PKCE and a nonce, the callback exchanging the code and
 * verifying the id_token against the provider's keys, the invite minted
 * for the verified email, and the refusals.
 */
import * as assert from "assert"
import { createSign, generateKeyPairSync } from "crypto"
import * as fs from "fs"
import * as http from "http"
import * as os from "os"
import * as path from "path"

import { providerRegistry } from "../../extension/inference/registry"
import { parseGatewayConfig, readGatewaySecrets } from "../../gateway/config"
import { invitesFileFor, InviteStore } from "../../gateway/invites"
import { KeyStore } from "../../gateway/keys"
import { LicenseStore } from "../../gateway/license"
import { createGatewayLog } from "../../gateway/log"
import { BUNDLED_PLUGINS, PluginHost, pluginsFileFor, PluginStore } from "../../gateway/plugins"
import { buildRouteTable } from "../../gateway/routes"
import { GatewayServer } from "../../gateway/server"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-oidc-test-"))

const request = (target: string, method: string, token?: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown>; text: string; headers: http.IncomingHttpHeaders }> =>
  new Promise((resolve, reject) => {
    const url = new URL(target)
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", Host: "gateway.test:8765" } },
      (res) => {
        let text = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => (text += chunk))
        res.on("end", () => {
          let parsed: Record<string, unknown> = {}
          try {
            parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}
          } catch {
            // HTML.
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, text, headers: res.headers })
        })
      }
    )
    req.on("error", reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })

/** A provider: discovery, JWKS, a token endpoint that signs whatever the test asks for. */
const fakeProvider = async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "k1", alg: "RS256", use: "sig" }
  const state = { nextClaims: {} as Record<string, unknown>, tokenRequests: [] as URLSearchParams[], issuer: "" }
  const sign = (claims: Record<string, unknown>): string => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" })).toString("base64url")
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
    const signer = createSign("RSA-SHA256")
    signer.update(`${header}.${payload}`)
    return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://idp")
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === "/.well-known/openid-configuration")
      return json(200, { issuer: state.issuer, authorization_endpoint: `${state.issuer}/authorize`, token_endpoint: `${state.issuer}/token`, jwks_uri: `${state.issuer}/jwks` })
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] })
    if (url.pathname === "/token" && req.method === "POST") {
      let text = ""
      for await (const chunk of req) text += chunk
      const form = new URLSearchParams(text)
      state.tokenRequests.push(form)
      if (form.get("code") !== "good-code") return json(400, { error: "invalid_grant", error_description: "bad code" })
      const now = Math.floor(Date.now() / 1000)
      return json(200, { id_token: sign({ iss: state.issuer, aud: "twinny-client", exp: now + 300, iat: now, nonce: state.nextClaims.nonce ?? "?", ...state.nextClaims }), access_token: "at", token_type: "Bearer" })
    }
    json(404, {})
    return undefined
  })
  const url = await new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)))
  state.issuer = url
  return { url, state, close: () => server.close() }
}

suite("OIDC plugin", function () {
  this.timeout(30_000)
  let server: GatewayServer
  let plugins: PluginHost
  let url: string
  let admin: string
  let idp: Awaited<ReturnType<typeof fakeProvider>>
  let invites: InviteStore
  const api = "/twinny/v1/admin/plugins/oidc/api"

  suiteSetup(async () => {
    const dir = path.join(scratch, "server")
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
    const log = createGatewayLog(() => undefined)
    invites = InviteStore.open(invitesFileFor(config.auth.keysFile))
    plugins = new PluginHost({
      plugins: BUNDLED_PLUGINS,
      store: PluginStore.open(pluginsFileFor(config.auth.keysFile)),
      dataDir: dir,
      log,
      invites: { create: (input) => server.inviteFor(input) }
    })
    server = new GatewayServer({ config, keys, license, routes: buildRouteTable(config, readGatewaySecrets(config, {}, 1), providerRegistry), log, plugins, invites })
    admin = keys.create("operator", { admin: true }).key
    url = (await server.start()).url
    idp = await fakeProvider()
  })

  suiteTeardown(async () => {
    await plugins.stop()
    await server.stop()
    idp.close()
  })

  test("public routes exist only while the plugin is on; settings hold the secret and discovery is checked", async () => {
    const off = await request(`${url}/twinny/v1/plugins/oidc/start`, "GET")
    assert.strictEqual(off.status, 409)
    assert.strictEqual((await request(`${url}/twinny/v1/admin/plugins/oidc/enable`, "POST", admin)).status, 200)
    const notSetUp = await request(`${url}/twinny/v1/plugins/oidc/start`, "GET")
    assert.strictEqual(notSetUp.status, 503)
    assert.match(notSetUp.text, /not set up SSO/)

    const saved = await request(`${url}${api}/settings`, "PUT", admin, { issuer: idp.url, clientId: "twinny-client", clientSecret: "shh", allowedDomains: "example.com", adminEmails: "boss@example.com" })
    assert.strictEqual(saved.status, 200, saved.text)
    assert.ok(!saved.text.includes("shh"))
    const settings = saved.body.settings as { clientSecretSet: boolean; allowedDomains: string[]; scopes: string }
    assert.strictEqual(settings.clientSecretSet, true)
    assert.deepStrictEqual(settings.allowedDomains, ["example.com"])
    assert.strictEqual(settings.scopes, "openid email profile")
    assert.deepStrictEqual(saved.body.discovery, { issuer: idp.url, authorization: `${idp.url}/authorize` })
    assert.strictEqual((await request(`${url}${api}/check`, "POST", admin)).status, 200)
  })

  test("start redirects with PKCE and a nonce; the callback verifies the id_token and mints a key through an invite", async () => {
    const started = await request(`${url}/twinny/v1/plugins/oidc/start`, "GET")
    assert.strictEqual(started.status, 302)
    const location = new URL(String(started.headers.location))
    assert.strictEqual(location.origin + location.pathname, `${idp.url}/authorize`)
    assert.strictEqual(location.searchParams.get("client_id"), "twinny-client")
    assert.strictEqual(location.searchParams.get("redirect_uri"), "https://gateway.test:8765/twinny/v1/plugins/oidc/callback")
    assert.strictEqual(location.searchParams.get("code_challenge_method"), "S256")
    const state = location.searchParams.get("state") as string
    const nonce = location.searchParams.get("nonce") as string
    assert.ok(state && nonce)

    idp.state.nextClaims = { email: "Alice@Example.com", email_verified: true, nonce }
    const back = await request(`${url}/twinny/v1/plugins/oidc/callback?code=good-code&state=${state}`, "GET")
    assert.strictEqual(back.status, 200, back.text)
    assert.match(back.headers["content-type"] ?? "", /text\/html/)
    assert.match(back.text, /Welcome, <b>alice@example.com<\/b>/)
    const link = /href="(vscode:\/\/[^"]+)"/.exec(back.text)?.[1]
    assert.ok(link, "the page opens VS Code")
    const opened = new URL(link as string)
    assert.strictEqual(opened.searchParams.get("url"), "https://gateway.test:8765")
    const code = opened.searchParams.get("code") as string
    assert.match(code, /^twi_/)
    // The token exchange carried the verifier and the secret; the invite is a replace so a second sign-in refreshes the key.
    const exchange = idp.state.tokenRequests[idp.state.tokenRequests.length - 1]
    assert.ok(exchange.get("code_verifier"))
    assert.strictEqual(exchange.get("client_secret"), "shh")
    const pending = invites.pending().find((invite) => invite.name === "alice@example.com")
    assert.ok(pending?.replace, "sign-in invites replace the previous key")
    assert.strictEqual(pending?.admin, undefined)

    // Opening the invite (what VS Code does) yields the key.
    const joined = await request(`${url}/twinny/v1/join`, "POST", undefined, { code, machine: "laptop" })
    assert.strictEqual(joined.status, 201, joined.text)
    assert.strictEqual(joined.body.name, "alice@example.com")
    const overview = await request(`${url}${api}/`, "GET", admin)
    const signIns = overview.body.signIns as Array<{ name: string; ok: boolean; admin: boolean }>
    assert.deepStrictEqual(signIns[0], { ...signIns[0], name: "alice@example.com", ok: true, admin: false })
  })

  test("an admin email gets an admin key; a wrong domain, a stale state, a bad code and an unverified address are refused", async () => {
    const go = async (claims: Record<string, unknown>, code = "good-code", useState?: string) => {
      const started = await request(`${url}/twinny/v1/plugins/oidc/start`, "GET")
      const location = new URL(String(started.headers.location))
      idp.state.nextClaims = { ...claims, nonce: location.searchParams.get("nonce") }
      return request(`${url}/twinny/v1/plugins/oidc/callback?code=${code}&state=${useState ?? location.searchParams.get("state")}`, "GET")
    }
    const boss = await go({ email: "boss@example.com", email_verified: true })
    assert.strictEqual(boss.status, 200)
    assert.match(boss.text, /as an admin/)
    assert.strictEqual(invites.pending().find((invite) => invite.name === "boss@example.com")?.admin, true)

    const outsider = await go({ email: "eve@evil.example", email_verified: true })
    assert.strictEqual(outsider.status, 400)
    assert.match(outsider.text, /not in a domain this gateway allows/)
    const unverified = await go({ email: "carol@example.com", email_verified: false })
    assert.match(unverified.text, /not a verified address/)
    const badCode = await go({ email: "dan@example.com" }, "bad-code")
    assert.match(badCode.text, /would not exchange the code: invalid_grant/)
    const stale = await go({ email: "dan@example.com" }, "good-code", "nope")
    assert.match(stale.text, /unknown or took longer/)

    // A token signed for another client is refused even with a good code and state.
    const started = await request(`${url}/twinny/v1/plugins/oidc/start`, "GET")
    const location = new URL(String(started.headers.location))
    idp.state.nextClaims = { email: "dan@example.com", email_verified: true, nonce: location.searchParams.get("nonce"), aud: "someone-else" }
    const wrongAud = await request(`${url}/twinny/v1/plugins/oidc/callback?code=good-code&state=${location.searchParams.get("state")}`, "GET")
    assert.match(wrongAud.text, /for another client/)
    const overview = await request(`${url}${api}/`, "GET", admin)
    assert.ok((overview.body.signIns as Array<{ ok: boolean }>).filter((s) => !s.ok).length >= 5)
  })
})

/**
 * Page links: the in-memory store on its own (with a fake clock), then an
 * in-process gateway where VS Code asks for a code with a developer's key
 * and the page trades it for that key, once.
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
import { MAX_PAGE_LINKS, MAX_PAGE_LINKS_PER_NAME, PAGE_LINK_TTL_MS, PageLinks } from "../../gateway/page-links"
import { buildRouteTable } from "../../gateway/routes"
import { GatewayServer } from "../../gateway/server"
import { RemoteInferenceProvider } from "../../protocol/client"
import { signedInPageLink } from "../../protocol/types"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-page-links-test-"))

suite("Page links", () => {
  test("a code opens once, for the key that asked", () => {
    const links = new PageLinks()
    const made = links.mint("tsk_key", "alice")
    assert.match(made.code, /^[0-9a-f]{64}$/)
    assert.deepStrictEqual(links.open(made.code), { key: "tsk_key", name: "alice" })
    assert.strictEqual(links.open(made.code), undefined)
    assert.strictEqual(links.size, 0)
  })

  test("a code is gone after a minute; a malformed or unknown one opens nothing", () => {
    let clock = 1_000_000
    const links = new PageLinks(() => clock)
    const made = links.mint("tsk_key", "alice")
    assert.strictEqual(new Date(made.expiresAt).getTime(), clock + PAGE_LINK_TTL_MS)
    clock += PAGE_LINK_TTL_MS
    assert.strictEqual(links.open(made.code), undefined)
    for (const code of [undefined, 7, "", "not-hex", "a".repeat(63), "A".repeat(64), "a".repeat(64)]) {
      assert.strictEqual(links.open(code), undefined, String(code))
    }
  })

  test("one name keeps a handful of codes, and the whole store stays bounded", () => {
    let clock = 1_000_000
    const links = new PageLinks(() => clock++)
    const alice = Array.from({ length: MAX_PAGE_LINKS_PER_NAME + 1 }, () => links.mint("tsk_a", "alice").code)
    assert.strictEqual(links.size, MAX_PAGE_LINKS_PER_NAME)
    assert.strictEqual(links.open(alice[0]), undefined, "the oldest gave way")
    assert.ok(links.open(alice[alice.length - 1]))
    for (let i = 0; i < MAX_PAGE_LINKS + 10; i++) links.mint(`tsk_${i}`, `dev${i}`)
    assert.strictEqual(links.size, MAX_PAGE_LINKS)
  })

  test("the link puts the code in the fragment, with a view only when it looks like one", () => {
    assert.strictEqual(signedInPageLink("https://gw.example/", "abc"), "https://gw.example/admin#link=abc")
    assert.strictEqual(signedInPageLink("https://gw.example", "abc", "plugin:github"), "https://gw.example/admin#link=abc&view=plugin%3Agithub")
    assert.strictEqual(signedInPageLink("https://gw.example", "abc", "plugin:../x"), "https://gw.example/admin#link=abc")
    assert.strictEqual(signedInPageLink("https://gw.example", "abc", undefined, { github: "rj-macarthy" }), "https://gw.example/admin#link=abc&github=rj-macarthy")
    for (const bad of ["-lead", "trail-", "two--hyphens", "has space", "a".repeat(40)]) {
      assert.strictEqual(signedInPageLink("https://gw.example", "abc", undefined, { github: bad }), "https://gw.example/admin#link=abc", bad)
    }
  })
})

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

suite("Gateway page links (in process)", function () {
  this.timeout(20_000)
  const dir = path.join(scratch, "gateway")
  const token = "shared-token-for-the-team"
  const lines: string[] = []
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
    server = new GatewayServer({ config, keys, license, routes, token, log: createGatewayLog((line) => lines.push(line)) })
    url = (await server.start()).url
  })

  suiteTeardown(async () => {
    await server.stop()
  })

  test("VS Code asks with the developer's key; the page trades the code for that key, once", async () => {
    const link = await new RemoteInferenceProvider({ baseUrl: url, token: developer }).pageLink()
    assert.match(link.code, /^[0-9a-f]{64}$/)
    const opened = await request(`${url}/twinny/v1/page-link/open`, "POST", undefined, { code: link.code })
    assert.strictEqual(opened.status, 200, message(opened))
    assert.deepStrictEqual(opened.body, { key: developer, name: "dev" })
    const again = await request(`${url}/twinny/v1/page-link/open`, "POST", undefined, { code: link.code })
    assert.strictEqual(again.status, 410)
    assert.match(message(again), /used already or has expired/)
    const joined = lines.join("\n")
    assert.match(joined, /event=page-link\.made .*key=dev/)
    assert.match(joined, /event=page-link\.opened .*key=dev/)
    assert.ok(!joined.includes(link.code), "the code is not logged")
    assert.ok(!joined.includes(developer.split("_")[2]), "the key is not logged")
  })

  test("an admin's key gets a link too", async () => {
    const link = await new RemoteInferenceProvider({ baseUrl: url, token: admin }).pageLink()
    const opened = await request(`${url}/twinny/v1/page-link/open`, "POST", undefined, { code: link.code })
    assert.deepStrictEqual(opened.body, { key: admin, name: "operator" })
  })

  test("no key, a wrong key or the shared token gets no link", async () => {
    assert.strictEqual((await request(`${url}/twinny/v1/page-link`, "POST", undefined, {})).status, 401)
    assert.strictEqual((await request(`${url}/twinny/v1/page-link`, "POST", "tsk_00000000_" + "0".repeat(64), {})).status, 401)
    const shared = await request(`${url}/twinny/v1/page-link`, "POST", token, {})
    assert.strictEqual(shared.status, 403)
    assert.match(message(shared), /shared token does not open the gateway's page/)
  })

  test("both routes are POST only, and a garbage code opens nothing", async () => {
    assert.strictEqual((await request(`${url}/twinny/v1/page-link`, "GET", developer)).status, 405)
    assert.strictEqual((await request(`${url}/twinny/v1/page-link/open`, "GET", undefined)).status, 405)
    assert.strictEqual((await request(`${url}/twinny/v1/page-link/open`, "POST", undefined, { code: "nope" })).status, 410)
    assert.strictEqual((await request(`${url}/twinny/v1/page-link/open`, "POST", undefined, {})).status, 410)
  })

  test("a key revoked between asking and opening is refused with the reason", async () => {
    const made = keys.create("leaver")
    const link = await new RemoteInferenceProvider({ baseUrl: url, token: made.key }).pageLink()
    keys.revoke(made.record.id)
    const opened = await request(`${url}/twinny/v1/page-link/open`, "POST", undefined, { code: link.code })
    assert.strictEqual(opened.status, 401)
    assert.match(message(opened), /revoked/)
  })
})

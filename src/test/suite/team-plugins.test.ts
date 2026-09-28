/**
 * The team plugins service in VS Code against an in-process gateway: what
 * it lists for a developer and an admin, announcing a share once, and
 * opening the page signed in with a link the page can trade for the key.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as http from "http"
import * as os from "os"
import * as path from "path"
import type { ExtensionContext } from "vscode"
import { Memento, Uri } from "vscode"

import { providerRegistry } from "../../extension/inference/registry"
import { listNames, TeamPlugins, TeamPluginsUi } from "../../extension/team/plugins-page"
import { parseGatewayConfig, readGatewaySecrets } from "../../gateway/config"
import { KeyStore } from "../../gateway/keys"
import { LicenseStore } from "../../gateway/license"
import { createGatewayLog } from "../../gateway/log"
import { BUNDLED_PLUGINS, PluginHost, pluginsFileFor, PluginStore } from "../../gateway/plugins"
import { buildRouteTable } from "../../gateway/routes"
import { GatewayServer } from "../../gateway/server"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-team-plugins-test-"))

class MemoryMemento implements Memento {
  private readonly _values = new Map<string, unknown>()
  keys() {
    return [...this._values.keys()]
  }
  get<T>(key: string, fallback?: T): T | undefined {
    return this._values.has(key) ? (this._values.get(key) as T) : fallback
  }
  async update(key: string, value: unknown) {
    this._values.set(key, value)
  }
}

class RecordingUi implements TeamPluginsUi {
  public opened: string[] = []
  public notices: string[] = []
  public answer: string | undefined
  public github: string | undefined = "rj-macarthy"
  openExternal(target: Uri) {
    this.opened.push(target.toString(true))
    return Promise.resolve(true)
  }
  notify(message: string) {
    this.notices.push(message)
    return Promise.resolve(this.answer)
  }
  names() {
    return Promise.resolve(this.github ? { github: this.github } : {})
  }
}

const post = (url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    const target = new URL(url)
    const payload = JSON.stringify(body)
    const req = http.request(
      { host: target.hostname, port: target.port, path: target.pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
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

suite("Team plugins in VS Code", function () {
  this.timeout(20_000)
  const dir = path.join(scratch, "gateway")
  let server: GatewayServer
  let plugins: PluginHost
  let url: string
  let admin: string
  let alice: string
  const services: TeamPlugins[] = []

  const serviceFor = (token: string | undefined, state = new MemoryMemento(), ui = new RecordingUi()) => {
    const context = { globalState: state } as unknown as ExtensionContext
    const service = new TeamPlugins(context, async () => (token ? { url, token } : undefined), ui)
    services.push(service)
    return { service, ui, state }
  }

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
    const keys = KeyStore.open(config.auth.keysFile, 0)
    admin = keys.create("operator", { admin: true }).key
    alice = keys.create("alice").key
    const log = createGatewayLog(() => undefined)
    plugins = new PluginHost({ plugins: BUNDLED_PLUGINS, store: PluginStore.open(pluginsFileFor(config.auth.keysFile)), dataDir: dir, log })
    const license = LicenseStore.open(config.auth.licenseFile, [], 0)
    const routes = buildRouteTable(config, readGatewaySecrets(config, {}, keys.active().length), providerRegistry)
    server = new GatewayServer({ config, keys, license, routes, log, plugins, token: "shared-token" })
    url = (await server.start()).url
    plugins.enable("github")
  })

  suiteTeardown(async () => {
    for (const service of services) service.dispose()
    await plugins.stop()
    await server.stop()
  })

  test("names read as a sentence", () => {
    assert.strictEqual(listNames(["GitHub"]), "GitHub")
    assert.strictEqual(listNames(["GitHub", "GitLab"]), "GitHub and GitLab")
    assert.strictEqual(listNames(["GitHub", "GitLab", "Gitea"]), "GitHub, GitLab and Gitea")
  })

  test("nothing shared: an empty list and no notice; shared: listed and announced once", async () => {
    const { service, ui, state } = serviceFor(alice)
    await service.refresh(true)
    assert.deepStrictEqual(service.status(), { available: true, sharedToken: false, admin: false, gateway: url, plugins: [] })
    assert.deepStrictEqual(ui.notices, [])

    plugins.setAccess("github", { people: ["alice"] })
    await service.refresh(true)
    assert.deepStrictEqual(service.status().plugins.map((plugin) => plugin.id), ["github"])
    assert.strictEqual(ui.notices.length, 1)
    assert.match(ui.notices[0], /shared GitHub with you/)

    await service.refresh(true)
    assert.strictEqual(ui.notices.length, 1, "announced once")
    // A new window with the same global state does not announce it again either.
    const again = serviceFor(alice, state)
    await again.service.refresh(true)
    assert.deepStrictEqual(again.ui.notices, [])
    plugins.setAccess("github", { people: [] })
  })

  test("the notice's Open lands on the plugin, signed in, and the link opens once", async () => {
    plugins.setAccess("github", { everyone: true })
    const ui = new RecordingUi()
    ui.answer = "Open"
    const { service } = serviceFor(alice, new MemoryMemento(), ui)
    await service.refresh(true)
    const deadline = Date.now() + 3_000
    while (!ui.opened.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.strictEqual(ui.opened.length, 1)
    const opened = new URL(ui.opened[0])
    assert.strictEqual(`${opened.origin}${opened.pathname}`, `${url}/admin`)
    assert.strictEqual(opened.search, "", "nothing the server logs")
    const fragment = new URLSearchParams(opened.hash.slice(1))
    assert.strictEqual(fragment.get("view"), "plugin:github")
    assert.strictEqual(fragment.get("github"), "rj-macarthy", "the page can fill in who they are on GitHub")
    assert.ok(!ui.opened[0].includes(alice), "the key never rides in the URL")

    const traded = await post(`${url}/twinny/v1/page-link/open`, { code: fragment.get("link") })
    assert.deepStrictEqual(traded.body, { key: alice, name: "alice" })
    assert.strictEqual((await post(`${url}/twinny/v1/page-link/open`, { code: fragment.get("link") })).status, 410)
    plugins.setAccess("github", { people: [] })
  })

  test("an admin sees the running plugins and is never announced to", async () => {
    const { service, ui } = serviceFor(admin)
    await service.refresh(true)
    assert.strictEqual(service.status().admin, true)
    assert.deepStrictEqual(service.status().plugins.map((plugin) => plugin.id), ["github"])
    assert.deepStrictEqual(ui.notices, [])
    ui.github = "not a login!"
    assert.strictEqual(await service.open(), true, "says it opened, so the card's button comes back")
    assert.match(ui.opened[0], /\/admin#link=[0-9a-f]{64}$/, "a name that could not be a login is left out")
  })

  test("no team, or the shared token: nothing to open and nothing asked of the gateway", async () => {
    const none = serviceFor(undefined)
    await none.service.refresh(true)
    assert.strictEqual(none.service.status().available, false)
    const shared = serviceFor("shared-token")
    await shared.service.refresh(true)
    assert.deepStrictEqual(shared.service.status(), { available: false, sharedToken: true, admin: false, gateway: url, plugins: [] })
    assert.strictEqual(await shared.service.open(), false)
    assert.deepStrictEqual(shared.ui.opened, [])
  })
})

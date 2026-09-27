/**
 * Sharing plugins with developers, below the server: the access record
 * and its parser, the route rule, what plugins.json keeps, what the host
 * lists for whom, and which pull-request routes a developer reaches.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { createGatewayLog } from "../../gateway/log"
import {
  BUNDLED_PLUGINS,
  GatewayPlugin,
  grants,
  MAX_PEOPLE,
  memberMay,
  parseAccess,
  PluginError,
  PluginHost,
  PluginStore
} from "../../gateway/plugins"
import { MEMBER_ROUTES } from "../../gateway/plugins/pulls"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-plugin-access-test-"))

const fileIn = (name: string): string => {
  const dir = path.join(scratch, name)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, "plugins.json")
}

/** A plugin that answers every request with who asked and how. */
const echo = (id: string, shareable: boolean): GatewayPlugin => ({
  id,
  name: id.toUpperCase(),
  description: `The ${id} plugin.`,
  ...(shareable ? { memberRoutes: [{ method: "GET" as const, path: /^things(?:\/[a-z]+)?$/ }] } : {}),
  create: () => ({
    handle: async (request) => ({ status: 200, body: { principal: request.principal, member: request.member === true } })
  })
})

const hostWith = (file: string) =>
  new PluginHost({
    plugins: [echo("shared", true), echo("private", false)],
    store: PluginStore.open(file),
    dataDir: path.dirname(file),
    log: createGatewayLog(() => undefined)
  })

suite("Plugin access records", () => {
  test("names are trimmed, deduplicated and sorted; everyone is a plain switch", () => {
    assert.deepStrictEqual(parseAccess({ people: [" bob", "alice", "bob "] }), { everyone: false, people: ["alice", "bob"] })
    assert.deepStrictEqual(parseAccess({ everyone: true }), { everyone: true, people: [] })
    assert.deepStrictEqual(parseAccess({}), { everyone: false, people: [] })
    assert.deepStrictEqual(parseAccess({ people: ["ci-bot@acme.dev", "j.doe_2"] }).people, ["ci-bot@acme.dev", "j.doe_2"])
  })

  test("anything that could not be a key name, or is not the shape, is refused with a reason", () => {
    for (const [value, reason] of [
      [null, /everyone, people/],
      [[], /everyone, people/],
      [{ everyone: "yes" }, /true or false/],
      [{ people: "alice" }, /list of key names/],
      [{ people: ["two words"] }, /"two words" is not a key name/],
      [{ people: [""] }, /not a key name/],
      [{ people: [7] }, /"7" is not a key name/],
      [{ people: ["-leading"] }, /not a key name/]
    ] as const) {
      assert.throws(() => parseAccess(value), reason, JSON.stringify(value))
    }
    const many = Array.from({ length: MAX_PEOPLE + 1 }, (_, i) => `dev${i}`)
    assert.throws(() => parseAccess({ people: many }), /share with everyone instead/)
    assert.strictEqual(parseAccess({ people: many.slice(1) }).people.length, MAX_PEOPLE)
  })

  test("a record lets in everyone, or exactly the people it names", () => {
    assert.ok(grants({ everyone: true, people: [] }, "anyone"))
    assert.ok(grants({ everyone: false, people: ["alice"] }, "alice"))
    assert.ok(!grants({ everyone: false, people: ["alice"] }, "Alice"), "names are exact")
    assert.ok(!grants({ everyone: false, people: [] }, "alice"))
  })

  test("a route must match both method and the whole path", () => {
    const routes = [{ method: "GET" as const, path: /^things$/ }]
    assert.ok(memberMay(routes, "GET", "things"))
    assert.ok(!memberMay(routes, "POST", "things"))
    assert.ok(!memberMay(routes, "GET", "things/more"))
    assert.ok(!memberMay([], "GET", ""))
  })
})

suite("Plugin access in plugins.json", () => {
  test("a grant survives a reopen; shared with nobody, the plugin has no entry at all", () => {
    const file = fileIn("store")
    const store = PluginStore.open(file)
    store.setEnabled("github", true)
    store.setAccess("github", { everyone: false, people: ["alice"] })
    store.setAccess("gitlab", { everyone: true, people: [] })
    const reopened = PluginStore.open(file)
    assert.deepStrictEqual(reopened.access("github"), { everyone: false, people: ["alice"] })
    assert.deepStrictEqual(reopened.access("gitlab"), { everyone: true, people: [] })
    assert.deepStrictEqual(reopened.access("gitea"), { everyone: false, people: [] })
    assert.deepStrictEqual(reopened.enabled(), ["github"], "the switches are untouched")

    reopened.setAccess("github", { everyone: false, people: [] })
    reopened.setAccess("gitlab", { everyone: false, people: [] })
    const written = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
    assert.deepStrictEqual(written, { version: 1, enabled: ["github"] })
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
  })

  test("a file from before sharing reads as shared with nobody; a malformed access section is refused", () => {
    const file = fileIn("older")
    fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: ["github"] }))
    assert.deepStrictEqual(PluginStore.open(file).access("github"), { everyone: false, people: [] })

    fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: [], access: [] }))
    assert.throws(() => PluginStore.open(file), /malformed access section/)
    fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: [], access: { github: { people: ["no spaces allowed"] } } }))
    assert.throws(() => PluginStore.open(file), /access entry for "github"/)
  })
})

suite("Plugin host and developers", () => {
  test("the admin listing says what can be shared and with whom; a developer's lists only what they may open", () => {
    const host = hostWith(fileIn("host-list"))
    host.enable("shared")
    host.enable("private")
    const admin = host.list()
    assert.deepStrictEqual(
      admin.map((plugin) => [plugin.id, plugin.shareable, plugin.access]),
      [
        ["shared", true, { everyone: false, people: [] }],
        ["private", false, undefined]
      ]
    )
    assert.deepStrictEqual(host.listFor("alice"), [])
    host.setAccess("shared", { people: ["alice"] })
    assert.deepStrictEqual(host.listFor("alice"), [{ id: "shared", name: "SHARED", description: "The shared plugin.", enabled: true, shareable: true }])
    assert.deepStrictEqual(host.listFor("bob"), [])
  })

  test("sharing is refused for a plugin that names no developer routes, and bad records say why", () => {
    const host = hostWith(fileIn("host-refuse"))
    assert.throws(() => host.setAccess("private", { everyone: true }), (error: unknown) => error instanceof PluginError && error.status === 400 && /cannot be shared/.test(error.message))
    assert.throws(() => host.access("private"), (error: unknown) => error instanceof PluginError && error.status === 404)
    assert.throws(() => host.setAccess("shared", { everyone: 1 }), (error: unknown) => error instanceof PluginError && error.status === 400)
    assert.throws(() => host.setAccess("nope", {}), (error: unknown) => error instanceof PluginError && error.status === 404)
  })

  test("a developer is told whether the plugin is not theirs or the route is an admin's", async () => {
    const host = hostWith(fileIn("host-refuse-member"))
    host.enable("shared")
    assert.match(host.refuseMember("shared", "alice", "GET", "things") ?? "", /not shared with alice/)
    host.setAccess("shared", { everyone: true })
    assert.strictEqual(host.refuseMember("shared", "alice", "GET", "things"), undefined)
    assert.strictEqual(host.refuseMember("shared", "alice", "GET", "things/one"), undefined)
    assert.match(host.refuseMember("shared", "alice", "POST", "things") ?? "", /Only an admin/)
    assert.match(host.refuseMember("private", "alice", "GET", "things") ?? "", /not shared/)
    // What reaches the plugin says it is a developer.
    const answer = await host.handle("shared", { method: "GET", path: "things", query: new URLSearchParams(), body: async () => ({}), principal: "alice", member: true })
    assert.deepStrictEqual(answer.body, { principal: "alice", member: true })
    await host.stop()
  })
})

suite("Pull-request routes a developer reaches", () => {
  const repo = "repos/0a1b2c3d"
  const reaches = (method: string, route: string) => memberMay(MEMBER_ROUTES, method, route)

  test("reading, syncing, reviewing, posting, asking, triaging and naming themselves", () => {
    for (const [method, route] of [
      ["GET", ""],
      ["POST", "sync"],
      ["PUT", "me"],
      ["POST", `${repo}/sync`],
      ["GET", `${repo}/pulls/7`],
      ["POST", `${repo}/pulls/7/review`],
      ["POST", `${repo}/pulls/7/review/post`],
      ["POST", `${repo}/pulls/7/review/ask`],
      ["GET", `${repo}/issues/12`],
      ["POST", `${repo}/issues/12/triage`],
      ["POST", `${repo}/issues/12/triage/post`]
    ]) {
      assert.ok(reaches(method, route), `${method} ${route}`)
    }
  })

  test("never the repositories, their tokens, the host, the App or the review model", () => {
    for (const [method, route] of [
      ["POST", "repos"],
      ["PUT", repo],
      ["DELETE", repo],
      ["PUT", "settings"],
      ["PUT", "app"],
      ["DELETE", "app"],
      ["GET", "app/repositories"],
      ["GET", "sync"],
      ["DELETE", `${repo}/pulls/7/review`],
      ["GET", `${repo}/pulls/07`],
      ["GET", `${repo}/pulls/7/extra`],
      ["GET", "repos/ZZZZZZZZ/pulls/7"],
      ["POST", `${repo}/issues/12/triage/post/again`]
    ]) {
      assert.ok(!reaches(method, route), `${method} ${route}`)
    }
  })

  test("the forges share the one table; nothing else bundled can be shared", () => {
    const shareable = BUNDLED_PLUGINS.filter((plugin) => plugin.memberRoutes)
    assert.deepStrictEqual(shareable.map((plugin) => plugin.id), ["github", "gitlab", "gitea", "bitbucket"])
    for (const plugin of shareable) assert.strictEqual(plugin.memberRoutes, MEMBER_ROUTES)
  })
})

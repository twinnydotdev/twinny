/**
 * Plugins: the store switches bundled plugins on and off and routes their
 * admin requests; the GitHub and GitLab plugins watch repositories with a
 * token or (GitHub) an App, list open pulls the same shape for both hosts,
 * open one with its files, and never let a token out.
 */
import * as assert from "assert"
import { createVerify, generateKeyPairSync } from "crypto"
import * as fs from "fs"
import * as http from "http"
import * as os from "os"
import * as path from "path"

import { providerRegistry } from "../../extension/inference/registry"
import type { ChatMessage } from "../../extension/inference/types"
import { parseGatewayConfig, readGatewaySecrets } from "../../gateway/config"
import { KeyStore } from "../../gateway/keys"
import { LicenseStore } from "../../gateway/license"
import { createGatewayLog } from "../../gateway/log"
import { BUNDLED_PLUGINS, PluginContext, PluginError, PluginHost, PluginInstance, pluginsFileFor, PluginStore } from "../../gateway/plugins"
import { PluginEventBus } from "../../gateway/plugins/events"
import { PullPage, RepoStore } from "../../gateway/plugins/forge"
import { appJwt } from "../../gateway/plugins/github"
import { PullsPlugin } from "../../gateway/plugins/pulls"
import { REVIEW_PROMPT_BUDGET, reviewMessages, ReviewRecord, ReviewStore, stripThinking } from "../../gateway/plugins/reviews"
import { parseTriage, TriageRecord } from "../../gateway/plugins/triage"
import { buildRouteTable } from "../../gateway/routes"
import { GatewayServer } from "../../gateway/server"

import { generateSigningKeys, issueLicense } from "./support/sign-license"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-plugins-test-"))

const request = (
  target: string,
  method: string,
  token: string | undefined,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown>; text: string }> =>
  new Promise((resolve, reject) => {
    const url = new URL(target)
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }
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
            // Not JSON.
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

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let text = ""
    req.setEncoding("utf8")
    req.on("data", (chunk: string) => (text += chunk))
    req.on("end", () => resolve(text))
  })

const answer = (res: http.ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(text)
}

const listen = (server: http.Server): Promise<string> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number }
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })

const build = (dir: string) => {
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
  const log = createGatewayLog(() => undefined)
  const plugins = new PluginHost({
    plugins: BUNDLED_PLUGINS,
    store: PluginStore.open(pluginsFileFor(config.auth.keysFile)),
    dataDir: dir,
    log
  })
  const server = new GatewayServer({ config, keys, license, routes, log, plugins })
  return { server, keys, plugins, dir }
}

/* -------------------------------------------------------------------------- */
/*  A stand-in GitHub: REST under /api/v3, GraphQL at /api/graphql            */
/* -------------------------------------------------------------------------- */

interface FakeGitHub {
  url: string
  publicKey: string
  appId: string
  /** Every Authorization header seen, in order. */
  auths: string[]
  /** GraphQL queries seen, in order. */
  queries: string[]
  /** When set, a query asking for reviewer detail is refused the way a token short of scopes is. */
  refuseDetail: { on: boolean }
  close: () => void
}

const PULL_NODE = {
  number: 7,
  title: "Add retries to the fetcher",
  url: "https://github.com/acme/widgets/pull/7",
  isDraft: false,
  createdAt: "2026-09-18T10:00:00Z",
  updatedAt: "2026-09-19T12:00:00Z",
  additions: 40,
  deletions: 12,
  changedFiles: 2,
  mergeable: "MERGEABLE",
  reviewDecision: "REVIEW_REQUIRED",
  author: { login: "alice" },
  headRefName: "fetch-retries",
  baseRefName: "main",
  headRefOid: "abc123",
  latestOpinionatedReviews: { nodes: [{ state: "APPROVED", author: { login: "bob" } }, { state: "CHANGES_REQUESTED", author: { login: "carol" } }] },
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "dave" } }, { requestedReviewer: { __typename: "Team", slug: "core" } }] },
  baseRef: { branchProtectionRule: { requiredApprovingReviewCount: 2 } },
  labels: { nodes: [{ name: "bug" }] },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state: "FAILURE",
            contexts: {
              nodes: [
                { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/build" },
                { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/test" },
                { __typename: "StatusContext", context: "lint", state: "PENDING", targetUrl: null }
              ]
            }
          }
        }
      }
    ]
  }
}

const DRAFT_NODE = {
  ...PULL_NODE,
  number: 9,
  title: "WIP: docs",
  isDraft: true,
  updatedAt: "2026-09-17T12:00:00Z",
  mergeable: "CONFLICTING",
  reviewDecision: null,
  latestOpinionatedReviews: { nodes: [] },
  reviewRequests: { nodes: [] },
  baseRef: { branchProtectionRule: null },
  labels: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: null } }] }
}

const fakeGitHub = async (): Promise<FakeGitHub> => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string
  const appId = "4242"
  const auths: string[] = []
  const queries: string[] = []
  const refuseDetail = { on: false }
  const verifyJwt = (auth: string): boolean => {
    const [, jwt] = auth.split(" ")
    const [header, payload, signature] = jwt.split(".")
    const verifier = createVerify("RSA-SHA256")
    verifier.update(`${header}.${payload}`)
    if (!verifier.verify(publicPem, signature, "base64url")) return false
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iss: string; exp: number }
    return claims.iss === appId && claims.exp > Date.now() / 1000
  }
  const server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization ?? ""
    auths.push(auth)
    const url = new URL(req.url ?? "/", "http://fake")
    const route = `${req.method} ${url.pathname}`
    // App routes take the JWT; everything else a token or an installation token.
    if (route === "GET /api/v3/app") {
      return verifyJwt(auth) ? answer(res, 200, { id: 4242, slug: "acme-reviewer", name: "Acme Reviewer" }) : answer(res, 401, { message: "Bad credentials" })
    }
    if (route === "GET /api/v3/repos/acme/widgets/installation") {
      return verifyJwt(auth) ? answer(res, 200, { id: 99 }) : answer(res, 401, { message: "Bad credentials" })
    }
    if (route === "POST /api/v3/app/installations/99/access_tokens") {
      return verifyJwt(auth) ? answer(res, 201, { token: "ghs_installation", expires_at: new Date(Date.now() + 3_600_000).toISOString() }) : answer(res, 401, { message: "Bad credentials" })
    }
    if (route === "GET /api/v3/app/installations") {
      return verifyJwt(auth) ? answer(res, 200, [{ id: 99, account: { login: "acme" } }]) : answer(res, 401, { message: "Bad credentials" })
    }
    if (route === "GET /api/v3/installation/repositories") {
      return auth === "Bearer ghs_installation" ? answer(res, 200, { repositories: [{ full_name: "acme/widgets" }, { full_name: "acme/gadgets" }] }) : answer(res, 401, { message: "Bad credentials" })
    }
    const readable = auth === "Bearer ghp_secret" || auth === "Bearer ghs_installation"
    if (!readable) return answer(res, 401, { message: "Bad credentials" })
    if (route === "GET /api/v3/repos/acme/widgets") return answer(res, 200, { full_name: "acme/widgets" })
    if (route === "GET /api/v3/user") return auth === "Bearer ghp_secret" ? answer(res, 200, { login: "alice" }) : answer(res, 403, { message: "Resource not accessible by integration" })
    if (route === "GET /api/v3/repos/acme/nothere") return answer(res, 404, { message: "Not Found" })
    if (route === "POST /api/graphql") {
      const body = JSON.parse(await readBody(req)) as { query: string; variables: { owner: string; name: string } }
      queries.push(body.query)
      if (refuseDetail.on && body.query.includes("latestOpinionatedReviews"))
        return answer(res, 200, { data: null, errors: [{ type: "INSUFFICIENT_SCOPES", message: "Your token has not been granted the required scopes to execute this query." }] })
      if (body.variables.name !== "widgets") return answer(res, 200, { data: { repository: null }, errors: [{ message: "Could not resolve to a Repository" }] })
      // Like GraphQL, answer only what was asked for.
      const nodes = [PULL_NODE, DRAFT_NODE].map((node) => {
        if (body.query.includes("latestOpinionatedReviews")) return node
        const { latestOpinionatedReviews, reviewRequests, baseRef, ...plain } = node
        void [latestOpinionatedReviews, reviewRequests, baseRef]
        return plain
      })
      return answer(res, 200, { data: { repository: { nameWithOwner: "acme/widgets", pullRequests: { nodes } } } })
    }
    if (route === "GET /api/v3/repos/acme/widgets/pulls/7") return answer(res, 200, { body: "Retries **three** times.", changed_files: 2 })
    if (route === "GET /api/v3/repos/acme/widgets/pulls/7/files") {
      return answer(res, 200, [
        { filename: "src/fetch.ts", status: "modified", additions: 30, deletions: 12, patch: "@@ -1 +1 @@\n-old\n+new" },
        { filename: "src/retry.ts", status: "added", additions: 10, deletions: 0, patch: "@@ -0,0 +1 @@\n+export const retry = 3" }
      ])
    }
    answer(res, 404, { message: "Not Found" })
  })
  const url = await listen(server)
  return { url, publicKey: publicPem, appId, auths, queries, refuseDetail, close: () => server.close(), ...{ privateKey: privateKey.export({ type: "pkcs1", format: "pem" }) as string } } as FakeGitHub & { privateKey: string }
}

/* -------------------------------------------------------------------------- */
/*  A stand-in GitLab                                                         */
/* -------------------------------------------------------------------------- */

const MR_NODE = {
  iid: "12",
  title: "Speed up the indexer",
  webUrl: "https://gitlab.com/acme/tools/indexer/-/merge_requests/12",
  draft: false,
  createdAt: "2026-09-18T10:00:00Z",
  updatedAt: "2026-09-19T12:00:00Z",
  sourceBranch: "faster",
  targetBranch: "main",
  diffHeadSha: "def456",
  conflicts: false,
  detailedMergeStatus: "NOT_APPROVED",
  approved: false,
  approvalsLeft: 1,
  author: { username: "bob" },
  labels: { nodes: [{ title: "performance" }] },
  diffStatsSummary: { additions: 20, deletions: 5, fileCount: 1 },
  headPipeline: { status: "RUNNING", path: "/acme/tools/indexer/-/pipelines/1", jobs: { nodes: [{ name: "build", status: "SUCCESS", webPath: "/acme/tools/indexer/-/jobs/1" }, { name: "test", status: "RUNNING", webPath: "/acme/tools/indexer/-/jobs/2" }] } }
}

const fakeGitLab = async (): Promise<{ url: string; close: () => void }> => {
  const project = encodeURIComponent("acme/tools/indexer")
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake")
    if (req.headers.authorization !== "Bearer glpat-secret") return answer(res, 401, { message: "401 Unauthorized" })
    const route = `${req.method} ${url.pathname}`
    if (route === `GET /api/v4/projects/${project}`) return answer(res, 200, { path_with_namespace: "acme/tools/indexer" })
    if (route === "POST /api/graphql") {
      await readBody(req)
      return answer(res, 200, { data: { project: { fullPath: "acme/tools/indexer", mergeRequests: { nodes: [MR_NODE] } } } })
    }
    if (route === `GET /api/v4/projects/${project}/merge_requests/12`) return answer(res, 200, { description: "Uses a bigger batch." })
    if (route === `GET /api/v4/projects/${project}/merge_requests/12/diffs`) {
      return answer(res, 200, [{ old_path: "index.ts", new_path: "indexer.ts", renamed_file: true, new_file: false, deleted_file: false, diff: "@@ -1,2 +1,3 @@\n-a\n+b\n+c\n d" }])
    }
    answer(res, 404, { message: "404 Not Found" })
  })
  const url = await listen(server)
  return { url, close: () => server.close() }
}

/* -------------------------------------------------------------------------- */

suite("Plugin store", function () {
  this.timeout(20_000)
  let server: GatewayServer
  let plugins: PluginHost
  let url: string
  let admin: string
  let dev: string
  let dir: string

  suiteSetup(async () => {
    dir = path.join(scratch, "store")
    const built = build(dir)
    server = built.server
    plugins = built.plugins
    admin = built.keys.create("operator", { admin: true }).key
    dev = built.keys.create("alice").key
    url = (await server.start()).url
  })

  suiteTeardown(async () => {
    await plugins.stop()
    await server.stop()
  })

  test("the bundled plugins are listed, off, and only for admins", async () => {
    const listed = await request(`${url}/twinny/v1/admin/plugins`, "GET", admin)
    assert.strictEqual(listed.status, 200)
    const ids = (listed.body.plugins as Array<{ id: string; enabled: boolean }>).map((plugin) => `${plugin.id}:${plugin.enabled}`)
    assert.deepStrictEqual(ids, ["github:false", "gitlab:false", "gitea:false", "bitbucket:false", "slack:false", "discord:false", "teams:false", "oidc:false", "context:false", "backups:false"])
    assert.strictEqual((await request(`${url}/twinny/v1/admin/plugins`, "GET", dev)).status, 403)
  })

  test("a plugin's routes answer 409 while it is off, and its store entry survives a restart", async () => {
    const off = await request(`${url}/twinny/v1/admin/plugins/gitlab/api/`, "GET", admin)
    assert.strictEqual(off.status, 409)
    assert.match(message(off), /switched off/)

    const on = await request(`${url}/twinny/v1/admin/plugins/gitlab/enable`, "POST", admin)
    assert.strictEqual(on.status, 200)
    assert.deepStrictEqual((on.body.plugin as { enabled: boolean }).enabled, true)
    assert.ok(plugins.instance("gitlab"))
    assert.deepStrictEqual(PluginStore.open(pluginsFileFor(path.join(dir, "keys.json"))).enabled(), ["gitlab"])
    assert.ok(fs.existsSync(path.join(dir, "plugins", "gitlab")), "the plugin got a directory")

    const listing = await request(`${url}/twinny/v1/admin/plugins/gitlab/api/`, "GET", admin)
    assert.strictEqual(listing.status, 200)
    assert.deepStrictEqual(listing.body.repos, [])
    assert.strictEqual(listing.body.appAuth, false)

    // A second host over the same store starts what the file says.
    const again = new PluginHost({ plugins: BUNDLED_PLUGINS, store: PluginStore.open(pluginsFileFor(path.join(dir, "keys.json"))), dataDir: dir, log: createGatewayLog(() => undefined) })
    again.start()
    assert.ok(again.instance("gitlab"))
    assert.strictEqual(again.instance("github"), undefined)
    await again.stop()

    const offAgain = await request(`${url}/twinny/v1/admin/plugins/gitlab/disable`, "POST", admin)
    assert.strictEqual(offAgain.status, 200)
    assert.strictEqual(plugins.instance("gitlab"), undefined)
    assert.deepStrictEqual(PluginStore.open(pluginsFileFor(path.join(dir, "keys.json"))).enabled(), [])
  })

  test("unknown plugins and wrong methods are refused", async () => {
    assert.strictEqual((await request(`${url}/twinny/v1/admin/plugins/nope/enable`, "POST", admin)).status, 404)
    assert.strictEqual((await request(`${url}/twinny/v1/admin/plugins/github/enable`, "GET", admin)).status, 405)
    assert.strictEqual((await request(`${url}/twinny/v1/admin/plugins/github`, "GET", admin)).status, 404)
  })
})

suite("Plugins and the licence", function () {
  this.timeout(20_000)

  test("plugins switch on only with the plugins feature, stop when the licence goes, and come back with it", async () => {
    const dir = path.join(scratch, "licence")
    const signing = generateSigningKeys()
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
    const license = LicenseStore.open(config.auth.licenseFile, [signing.publicKeyRaw], 0)
    const log = createGatewayLog(() => undefined)
    const plugins = new PluginHost({
      plugins: BUNDLED_PLUGINS,
      store: PluginStore.open(pluginsFileFor(config.auth.keysFile)),
      dataDir: dir,
      log,
      licensed: () => license.current().features.includes("plugins")
    })
    const server = new GatewayServer({ config, keys, license, routes: buildRouteTable(config, readGatewaySecrets(config, {}, 1), providerRegistry), log, plugins })
    const admin = keys.create("operator", { admin: true }).key
    const url = (await server.start()).url
    try {
      const listed = await request(`${url}/twinny/v1/admin/plugins`, "GET", admin)
      assert.strictEqual(listed.body.licensed, false)
      const refused = await request(`${url}/twinny/v1/admin/plugins/gitlab/enable`, "POST", admin)
      assert.strictEqual(refused.status, 403)
      assert.match(message(refused), /licence with the plugins feature/)

      const token = issueLicense({ org: "Acme", seats: 10, features: ["plugins"] }, signing.privateKeyPem).token
      assert.strictEqual((await request(`${url}/twinny/v1/admin/license`, "PUT", admin, { token })).status, 200)
      assert.strictEqual((await request(`${url}/twinny/v1/admin/plugins/gitlab/enable`, "POST", admin)).status, 200)
      assert.strictEqual((await request(`${url}/twinny/v1/admin/plugins/gitlab/api/`, "GET", admin)).status, 200)
      assert.strictEqual((await request(`${url}/twinny/v1/admin/plugins`, "GET", admin)).body.licensed, true)

      // The licence goes: the plugin stops and its routes refuse, but its switch is kept.
      assert.strictEqual((await request(`${url}/twinny/v1/admin/license`, "DELETE", admin)).status, 200)
      assert.strictEqual(plugins.instance("gitlab"), undefined)
      const off = await request(`${url}/twinny/v1/admin/plugins/gitlab/api/`, "GET", admin)
      assert.strictEqual(off.status, 403)
      assert.deepStrictEqual(PluginStore.open(pluginsFileFor(config.auth.keysFile)).enabled(), ["gitlab"])
      const stillListed = (await request(`${url}/twinny/v1/admin/plugins`, "GET", admin)).body.plugins as Array<{ id: string; enabled: boolean }>
      assert.strictEqual(stillListed.find((plugin) => plugin.id === "gitlab")?.enabled, false)

      // A licence without the feature is not enough; one with it brings the plugin straight back.
      const seatsOnly = issueLicense({ org: "Acme", seats: 10, features: ["policy"] }, signing.privateKeyPem).token
      await request(`${url}/twinny/v1/admin/license`, "PUT", admin, { token: seatsOnly })
      assert.strictEqual(plugins.instance("gitlab"), undefined)
      await request(`${url}/twinny/v1/admin/license`, "PUT", admin, { token })
      assert.ok(plugins.instance("gitlab"), "running again without anyone pressing the switch")
      assert.strictEqual((await request(`${url}/twinny/v1/admin/plugins/gitlab/api/`, "GET", admin)).status, 200)
    } finally {
      await plugins.stop()
      await server.stop()
    }
  })
})

suite("GitHub plugin", function () {
  this.timeout(30_000)
  let server: GatewayServer
  let plugins: PluginHost
  let url: string
  let admin: string
  let dir: string
  let github: FakeGitHub & { privateKey: string }
  const api = "/twinny/v1/admin/plugins/github/api"

  suiteSetup(async () => {
    dir = path.join(scratch, "github")
    const built = build(dir)
    server = built.server
    plugins = built.plugins
    admin = built.keys.create("operator", { admin: true }).key
    url = (await server.start()).url
    github = (await fakeGitHub()) as FakeGitHub & { privateKey: string }
    await request(`${url}/twinny/v1/admin/plugins/github/enable`, "POST", admin)
    const set = await request(`${url}${api}/settings`, "PUT", admin, { baseUrl: `${github.url}/ignored/path` })
    assert.strictEqual(set.status, 200)
    assert.strictEqual((set.body.host as { baseUrl: string }).baseUrl, github.url)
  })

  suiteTeardown(async () => {
    await plugins.stop()
    await server.stop()
    github.close()
  })

  test("adding a repository needs a token until an App is set up, and checks it against GitHub", async () => {
    const noToken = await request(`${url}${api}/repos`, "POST", admin, { fullName: "acme/widgets" })
    assert.strictEqual(noToken.status, 400)
    assert.match(message(noToken), /access token/)

    const badName = await request(`${url}${api}/repos`, "POST", admin, { fullName: "widgets", token: "ghp_secret" })
    assert.strictEqual(badName.status, 400)

    const wrongToken = await request(`${url}${api}/repos`, "POST", admin, { fullName: "acme/widgets", token: "ghp_wrong" })
    assert.strictEqual(wrongToken.status, 502)
    assert.match(message(wrongToken), /token was refused/)

    const missing = await request(`${url}${api}/repos`, "POST", admin, { fullName: "acme/nothere", token: "ghp_secret" })
    assert.strictEqual(missing.status, 502)
    assert.match(message(missing), /not found/)
  })

  test("a watched repository lists its open pulls in the shared shape, with no token in sight", async () => {
    const added = await request(`${url}${api}/repos`, "POST", admin, { fullName: " https://github.com/acme/widgets.git ".trim().replace("https://github.com/", ""), token: "ghp_secret" })
    assert.strictEqual(added.status, 201, message(added))
    const repo = added.body.repo as { id: string; fullName: string; auth: string; url: string; pulls: unknown[]; syncedAt?: string; error?: string }
    assert.strictEqual(repo.fullName, "acme/widgets")
    assert.strictEqual(repo.auth, "token")
    assert.strictEqual(repo.url, `${github.url}/acme/widgets`)
    assert.strictEqual(repo.error, undefined)
    assert.ok(repo.syncedAt)
    assert.ok(!added.text.includes("ghp_secret"), "the token never comes back")

    const duplicate = await request(`${url}${api}/repos`, "POST", admin, { fullName: "ACME/Widgets", token: "ghp_secret" })
    assert.strictEqual(duplicate.status, 409)

    const listing = await request(`${url}${api}/`, "GET", admin)
    assert.strictEqual(listing.status, 200)
    assert.ok(!listing.text.includes("ghp_secret"))
    const [watched] = listing.body.repos as Array<{ pulls: Array<Record<string, unknown>> }>
    assert.strictEqual(watched.pulls.length, 2)
    const [first, second] = watched.pulls
    // Newest update first.
    assert.strictEqual(first.number, 7)
    assert.strictEqual(first.author, "alice")
    assert.strictEqual(first.checks, "failure")
    assert.deepStrictEqual(
      (first.checkRuns as Array<{ name: string; state: string }>).map((check) => `${check.name}=${check.state}`),
      ["build=success", "test=failure", "lint=pending"]
    )
    assert.strictEqual(first.mergeable, "mergeable")
    assert.strictEqual(first.review, "review-required")
    assert.deepStrictEqual(first.approvals, { approved: ["bob"], changes: ["carol"], pending: ["dave", "a team"], required: 2 })
    assert.deepStrictEqual(first.labels, ["bug"])
    assert.strictEqual(first.headRef, "fetch-retries")
    assert.strictEqual(first.additions, 40)
    assert.strictEqual(second.number, 9)
    assert.strictEqual(second.draft, true)
    assert.strictEqual(second.checks, "none")
    assert.strictEqual(second.mergeable, "conflicting")
    assert.strictEqual(second.review, "none")
    assert.deepStrictEqual(second.approvals, { approved: [], changes: [], pending: [] })

    // The file keeps the token, for the owner only.
    const file = path.join(dir, "plugins", "github", "repos.json")
    assert.ok(fs.readFileSync(file, "utf8").includes("ghp_secret"))
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
    // And a token request carried it.
    assert.ok(github.auths.includes("Bearer ghp_secret"))
  })

  test("the page knows who the operator is: the token's login, or a name set by hand", async () => {
    const listing = await request(`${url}${api}/`, "GET", admin)
    assert.deepStrictEqual(listing.body.me, { name: "alice", detected: "alice" }, "detected from the token at sync")

    const set = await request(`${url}${api}/settings`, "PUT", admin, { me: "@Bob" })
    assert.strictEqual(set.status, 200, message(set))
    assert.deepStrictEqual(set.body.me, { name: "Bob", detected: "alice" }, "the hand-set name wins, without its @")

    const cleared = await request(`${url}${api}/settings`, "PUT", admin, { me: "" })
    assert.deepStrictEqual(cleared.body.me, { name: "alice", detected: "alice" })
  })

  test("a host that refuses the reviewer detail is listed plainly, once, and stays that way", async () => {
    const listing = await request(`${url}${api}/`, "GET", admin)
    const [watched] = listing.body.repos as Array<{ id: string }>
    github.refuseDetail.on = true
    try {
      github.queries.length = 0
      const synced = await request(`${url}${api}/repos/${watched.id}/sync`, "POST", admin)
      assert.strictEqual(synced.status, 200, message(synced))
      const repo = synced.body.repo as { error?: string; pulls: Array<Record<string, unknown>> }
      assert.strictEqual(repo.error, undefined, "the listing survives the refusal")
      assert.strictEqual(repo.pulls.length, 2)
      assert.strictEqual(repo.pulls[0].review, "review-required", "what the plain query gives is still there")
      assert.strictEqual(repo.pulls[0].approvals, undefined, "no detail, no approvals")
      assert.deepStrictEqual(github.queries.map((query) => query.includes("latestOpinionatedReviews")), [true, false], "rich first, then plain")

      github.queries.length = 0
      await request(`${url}${api}/repos/${watched.id}/sync`, "POST", admin)
      assert.deepStrictEqual(github.queries.map((query) => query.includes("latestOpinionatedReviews")), [false], "the rich query is not tried again")
    } finally {
      github.refuseDetail.on = false
    }
  })

  test("one pull opens with its description and files", async () => {
    const listing = await request(`${url}${api}/`, "GET", admin)
    const [repo] = listing.body.repos as Array<{ id: string }>
    const detail = await request(`${url}${api}/repos/${repo.id}/pulls/7`, "GET", admin)
    assert.strictEqual(detail.status, 200, message(detail))
    assert.strictEqual((detail.body.pull as { title: string }).title, "Add retries to the fetcher")
    assert.strictEqual(detail.body.body, "Retries **three** times.")
    const files = detail.body.files as Array<{ path: string; status: string; patch: string; additions: number }>
    assert.deepStrictEqual(files.map((file) => `${file.status} ${file.path} +${file.additions}`), ["modified src/fetch.ts +30", "added src/retry.ts +10"])
    assert.ok(files[0].patch.includes("+new"))
    assert.strictEqual(detail.body.moreFiles, 0)

    const gone = await request(`${url}${api}/repos/${repo.id}/pulls/77`, "GET", admin)
    assert.strictEqual(gone.status, 404)
    assert.match(message(gone), /no open pull 77/)
  })

  test("a GitHub App reads repositories without a token of their own", async () => {
    // The JWT is what GitHub expects: RS256 over header.payload, issued by the App.
    const jwt = appJwt(github.appId, github.privateKey, Date.now())
    const [header] = jwt.split(".")
    assert.deepStrictEqual(JSON.parse(Buffer.from(header, "base64url").toString("utf8")), { alg: "RS256", typ: "JWT" })

    const badKey = await request(`${url}${api}/app`, "PUT", admin, { appId: github.appId, privateKey: "not a key" })
    assert.strictEqual(badKey.status, 400)
    const badId = await request(`${url}${api}/app`, "PUT", admin, { appId: "1", privateKey: github.privateKey })
    assert.strictEqual(badId.status, 502)
    assert.match(message(badId), /refused/)

    const set = await request(`${url}${api}/app`, "PUT", admin, { appId: github.appId, privateKey: github.privateKey })
    assert.strictEqual(set.status, 200, message(set))
    const host = set.body.host as { app: { appId: string; slug: string; installUrl: string } }
    assert.strictEqual(host.app.slug, "acme-reviewer")
    assert.strictEqual(host.app.installUrl, `${github.url}/apps/acme-reviewer/installations/new`)
    assert.ok(!set.text.includes("PRIVATE KEY"), "the key never comes back")

    const listing = await request(`${url}${api}/`, "GET", admin)
    assert.strictEqual(listing.body.appAuth, true)
    assert.ok(!listing.text.includes("PRIVATE KEY"))

    const seen = await request(`${url}${api}/app/repositories`, "GET", admin)
    assert.strictEqual(seen.status, 200, message(seen))
    assert.deepStrictEqual(
      (seen.body.repositories as Array<{ fullName: string; account: string }>).map((entry) => `${entry.account}:${entry.fullName}`),
      ["acme:acme/gadgets", "acme:acme/widgets"]
    )

    // Replace the token repository with an App one.
    const [tokenRepo] = listing.body.repos as Array<{ id: string }>
    assert.strictEqual((await request(`${url}${api}/repos/${tokenRepo.id}`, "DELETE", admin)).status, 200)
    github.auths.length = 0
    const added = await request(`${url}${api}/repos`, "POST", admin, { fullName: "acme/widgets" })
    assert.strictEqual(added.status, 201, message(added))
    const repo = added.body.repo as { id: string; auth: string; pulls: unknown[]; error?: string }
    assert.strictEqual(repo.auth, "app")
    assert.strictEqual(repo.error, undefined)
    assert.strictEqual(repo.pulls.length, 2)
    // The installation token did the reading; the JWT only fetched it, once.
    assert.ok(github.auths.includes("Bearer ghs_installation"))
    assert.strictEqual(github.auths.filter((auth) => auth === "Bearer ghs_installation").length >= 2, true)
    const jwts = github.auths.filter((auth) => auth.split(".").length === 3)
    assert.strictEqual(jwts.length, 1, "one JWT to find the installation; its token was cached by the listing above")

    // Without the App, the repository says why it cannot sync.
    assert.strictEqual((await request(`${url}${api}/app`, "DELETE", admin)).status, 200)
    const synced = await request(`${url}${api}/repos/${repo.id}/sync`, "POST", admin)
    assert.strictEqual(synced.status, 200)
    assert.match((synced.body.repo as { error: string }).error, /no longer set up/)
  })
})

suite("GitLab plugin", function () {
  this.timeout(30_000)
  let server: GatewayServer
  let plugins: PluginHost
  let url: string
  let admin: string
  let gitlab: { url: string; close: () => void }
  const api = "/twinny/v1/admin/plugins/gitlab/api"

  suiteSetup(async () => {
    const built = build(path.join(scratch, "gitlab"))
    server = built.server
    plugins = built.plugins
    admin = built.keys.create("operator", { admin: true }).key
    url = (await server.start()).url
    gitlab = await fakeGitLab()
    await request(`${url}/twinny/v1/admin/plugins/gitlab/enable`, "POST", admin)
    await request(`${url}${api}/settings`, "PUT", admin, { baseUrl: gitlab.url })
  })

  suiteTeardown(async () => {
    await plugins.stop()
    await server.stop()
    gitlab.close()
  })

  test("a project's merge requests come out in the shared shape, pipelines as checks", async () => {
    const added = await request(`${url}${api}/repos`, "POST", admin, { fullName: "acme/tools/indexer", token: "glpat-secret" })
    assert.strictEqual(added.status, 201, message(added))
    assert.ok(!added.text.includes("glpat-secret"))
    const repo = added.body.repo as { id: string; url: string; pulls: Array<Record<string, unknown>> }
    assert.strictEqual(repo.url, `${gitlab.url}/acme/tools/indexer`)
    const [mr] = repo.pulls
    assert.strictEqual(mr.number, 12)
    assert.strictEqual(mr.author, "bob")
    assert.strictEqual(mr.checks, "pending")
    assert.deepStrictEqual(
      (mr.checkRuns as Array<{ name: string; state: string; url: string }>).map((check) => `${check.name}=${check.state}@${check.url}`),
      [`build=success@${gitlab.url}/acme/tools/indexer/-/jobs/1`, `test=pending@${gitlab.url}/acme/tools/indexer/-/jobs/2`]
    )
    assert.strictEqual(mr.mergeable, "blocked")
    assert.strictEqual(mr.review, "review-required")
    assert.deepStrictEqual(mr.labels, ["performance"])
    assert.strictEqual(mr.changedFiles, 1)

    const detail = await request(`${url}${api}/repos/${repo.id}/pulls/12`, "GET", admin)
    assert.strictEqual(detail.status, 200, message(detail))
    assert.strictEqual(detail.body.body, "Uses a bigger batch.")
    const [file] = detail.body.files as Array<Record<string, unknown>>
    assert.strictEqual(file.status, "renamed")
    assert.strictEqual(file.previousPath, "index.ts")
    assert.strictEqual(file.path, "indexer.ts")
    assert.strictEqual(file.additions, 2)
    assert.strictEqual(file.deletions, 1)
  })

  test("a token the host refuses is reported on the project, not thrown away", async () => {
    const refused = await request(`${url}${api}/repos`, "POST", admin, { fullName: "acme/tools/other", token: "glpat-wrong" })
    assert.strictEqual(refused.status, 502)
    assert.match(message(refused), /token was refused/)
  })
})

suite("Pull-request plugin core", () => {
  test("the store keeps tokens and settings, and forgets removed repositories", () => {
    const file = path.join(scratch, "core", "repos.json")
    const store = RepoStore.open(file)
    const repo = store.add({ fullName: "a/b", auth: "token", token: "t", addedAt: "2026-09-20T00:00:00Z", addedBy: "op" })
    store.setSettings({ baseUrl: "https://example.test" })
    const reopened = RepoStore.open(file)
    assert.deepStrictEqual(reopened.get(repo.id)?.token, "t")
    assert.deepStrictEqual(reopened.settings(), { baseUrl: "https://example.test" })
    assert.ok(reopened.byName("A/B"))
    assert.strictEqual(reopened.remove(repo.id), true)
    assert.strictEqual(reopened.remove(repo.id), false)
    assert.deepStrictEqual(RepoStore.open(file).repos(), [])
  })

  test("a plugin whose host cannot be reached records the failure per repository and keeps going", async () => {
    const dir = path.join(scratch, "unreachable")
    fs.mkdirSync(dir, { recursive: true })
    const plugin = new PullsPlugin(
      { dataDir: dir, log: createGatewayLog(() => undefined), fetch, now: Date.now },
      () => ({
        noun: "Pull request",
        repoUrl: (name) => `x://${name}`,
        hasAppAuth: () => true,
        checkRepo: async (repo) => repo.fullName,
        listPulls: async (repo) => {
          if (repo.fullName === "bad/one") throw new Error("boom")
          return []
        },
        pullContent: async () => ({ body: "", files: [], moreFiles: 0 }),
        postReview: async () => ({}),
        status: () => ({ baseUrl: "x://" })
      }),
      0
    ) as PluginInstance & PullsPlugin
    plugin.start()
    const body = async (fullName: string) => ({ fullName })
    await plugin.handle({ method: "POST", path: "repos", query: new URLSearchParams(), body: () => body("bad/one"), principal: "op" })
    await plugin.handle({ method: "POST", path: "repos", query: new URLSearchParams(), body: () => body("good/one"), principal: "op" })
    const listing = await plugin.handle({ method: "GET", path: "", query: new URLSearchParams(), body: async () => ({}), principal: "op" })
    const repos = (listing.body as { repos: Array<{ fullName: string; error?: string; syncedAt?: string }> }).repos
    assert.strictEqual(repos.find((repo) => repo.fullName === "bad/one")?.error, "boom")
    assert.ok(repos.find((repo) => repo.fullName === "good/one")?.syncedAt)
    await plugin.stop()
  })
})

suite("Pull-request reviews", function () {
  this.timeout(20_000)
  const scripted = (reply: string, options: { active?: () => number; fail?: boolean } = {}) => {
    const calls: Array<{ alias: string; prompt: string }> = []
    const inference = {
      chatAliases: () => ["coder", "chat"],
      embeddingAliases: () => [],
      embed: async () => [],
      active: options.active ?? (() => 0),
      async *chat(alias: string, messages: ChatMessage[]) {
        calls.push({ alias, prompt: messages.map((m) => String(m.content)).join("\n") })
        if (options.fail) throw new Error("backend is down")
        for (const piece of reply.split(" ")) yield `${piece} `
      }
    }
    return { inference, calls }
  }
  const forge = (heads: Record<number, string>) => () => ({
    noun: "Pull request",
    repoUrl: (name: string) => `x://${name}`,
    hasAppAuth: () => true,
    checkRepo: async (repo: { fullName: string }) => repo.fullName,
    listPulls: async (repo: { fullName: string }) =>
      Object.entries(heads).map(([number, sha]) => ({
        repo: repo.fullName,
        number: Number(number),
        title: `Pull ${number}`,
        author: "alice",
        url: "x://pull",
        draft: number === "3",
        createdAt: "2026-09-19T00:00:00Z",
        updatedAt: `2026-09-19T0${number}:00:00Z`,
        headRef: "topic",
        baseRef: "main",
        headSha: sha,
        checks: "none" as const,
        checkRuns: [],
        mergeable: "unknown" as const,
        review: "none" as const,
        labels: []
      })),
    pullContent: async () => ({ body: "Does a thing.", files: [{ path: "a.ts", status: "modified" as const, additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }], moreFiles: 0 }),
    postReview: async () => ({}),
    status: () => ({ baseUrl: "x://" })
  })
  const req = (method: string, path: string, body: Record<string, unknown> = {}) => ({ method, path, query: new URLSearchParams(), body: async () => body, principal: "op" })
  const plugin = (dir: string, inference: PluginContext["inference"], heads: Record<number, string>) => {
    fs.mkdirSync(dir, { recursive: true })
    return new PullsPlugin({ dataDir: dir, log: createGatewayLog(() => undefined), fetch, now: Date.now, inference }, forge(heads), 0)
  }

  test("review now runs the gateway's chat model over the pull and keeps the answer", async () => {
    const { inference, calls } = scripted("## Summary\nFine.\n\n## Verdict\nApprove.")
    const dir = path.join(scratch, "reviews-now")
    const p = plugin(dir, inference, { 1: "aaa" })
    p.start()
    const added = await p.handle(req("POST", "repos", { fullName: "acme/one" }))
    const repo = (added.body as { repo: { id: string } }).repo
    const before = await p.handle(req("GET", `repos/${repo.id}/pulls/1`))
    assert.strictEqual((before.body as PullPage).review, undefined)
    assert.strictEqual((before.body as PullPage).reviewing, false)

    const reviewed = await p.handle(req("POST", `repos/${repo.id}/pulls/1/review`))
    assert.strictEqual(reviewed.status, 200)
    const review = (reviewed.body as { review: ReviewRecord }).review
    assert.strictEqual(review.status, "done")
    assert.strictEqual(review.alias, "coder")
    assert.strictEqual(review.requestedBy, "op")
    assert.strictEqual(review.headSha, "aaa")
    assert.match(review.text, /Approve/)
    assert.strictEqual(calls.length, 1)
    assert.match(calls[0].prompt, /acme\/one#1: Pull 1/)
    assert.match(calls[0].prompt, /Does a thing\./)
    assert.match(calls[0].prompt, /```diff\n@@ -1 \+1 @@\n-old\n\+new\n```/)

    const after = await p.handle(req("GET", `repos/${repo.id}/pulls/1`))
    assert.strictEqual((after.body as PullPage).review?.text, review.text)
    const listing = await p.handle(req("GET", ""))
    const view = (listing.body as { repos: Array<{ reviews: Record<number, { stale: boolean; status: string }> }>; review: { available: boolean; alias: string } }).repos[0]
    assert.deepStrictEqual(view.reviews[1].stale, false)
    assert.strictEqual((listing.body as { review: { alias: string } }).review.alias, "coder")
    // The file survives a restart and never has the token.
    const reopened = ReviewStore.open(path.join(dir, "reviews.json"))
    assert.strictEqual(reopened.latest(repo.id, 1)?.status, "done")
    assert.strictEqual(fs.statSync(path.join(dir, "reviews.json")).mode & 0o777, 0o600)

    // The review model can be chosen, and must be one the gateway serves.
    const bad = await p.handle(req("PUT", "settings", { reviewAlias: "nope" })).catch((e: PluginError) => e)
    assert.ok(bad instanceof PluginError && bad.status === 400)
    await p.handle(req("PUT", "settings", { reviewAlias: "chat" }))
    const again = await p.handle(req("POST", `repos/${repo.id}/pulls/1/review`))
    assert.strictEqual((again.body as { review: ReviewRecord }).review.alias, "chat")
    await p.stop()
  })

  test("auto-review takes one pull at a time, newest first, skips drafts, waits for idle models and re-reviews moved commits", async () => {
    const { inference, calls } = scripted("LGTM")
    let active = 1
    inference.active = () => active
    const dir = path.join(scratch, "reviews-auto")
    const heads: Record<number, string> = { 1: "aaa", 2: "bbb", 3: "ccc" }
    const p = plugin(dir, inference, heads)
    p.start()
    const added = await p.handle(req("POST", "repos", { fullName: "acme/two" }))
    const repo = (added.body as { repo: { id: string } }).repo
    // Off by default: nothing happens.
    await p.autoReview()
    assert.strictEqual(calls.length, 0)
    await p.handle(req("PUT", `repos/${repo.id}`, { autoReview: true }))
    // Developers are busy: still nothing.
    await p.autoReview()
    assert.strictEqual(calls.length, 0)
    active = 0
    await p.autoReview()
    assert.strictEqual(calls.length, 1)
    assert.match(calls[0].prompt, /Pull 2/, "the newest non-draft pull first")
    await p.autoReview()
    assert.strictEqual(calls.length, 2)
    assert.match(calls[1].prompt, /Pull 1/)
    await p.autoReview()
    assert.strictEqual(calls.length, 2, "the draft is left alone and nothing else is due")
    // The pull moves on: its review is stale, and auto-review does it again.
    heads[2] = "bbb2"
    await p.syncAll()
    const listing = await p.handle(req("GET", ""))
    const view = (listing.body as { repos: Array<{ reviews: Record<number, { stale: boolean }> }> }).repos[0]
    assert.strictEqual(view.reviews[2].stale, true)
    await p.autoReview()
    assert.strictEqual(calls.length, 3)
    assert.strictEqual(p.reviews.latest(repo.id, 2)?.headSha, "bbb2")
    // Removing the repository drops its reviews.
    await p.handle(req("DELETE", `repos/${repo.id}`))
    assert.strictEqual(ReviewStore.open(path.join(dir, "reviews.json")).latest(repo.id, 2), undefined)
    await p.stop()
  })

  test("a failed review is kept as failed with the reason, and no models means a clear refusal", async () => {
    const { inference } = scripted("", { fail: true })
    const dir = path.join(scratch, "reviews-fail")
    const p = plugin(dir, inference, { 1: "aaa" })
    p.start()
    const repo = ((await p.handle(req("POST", "repos", { fullName: "acme/three" }))).body as { repo: { id: string } }).repo
    const failed = await p.handle(req("POST", `repos/${repo.id}/pulls/1/review`))
    const review = (failed.body as { review: ReviewRecord }).review
    assert.strictEqual(review.status, "failed")
    assert.match(review.error ?? "", /backend is down/)
    const listing = await p.handle(req("GET", ""))
    assert.strictEqual((listing.body as { repos: Array<{ reviews: Record<number, { status: string }> }> }).repos[0].reviews[1].status, "failed")
    await p.stop()

    const none = plugin(path.join(scratch, "reviews-none"), undefined, { 1: "aaa" })
    none.start()
    const repo2 = ((await none.handle(req("POST", "repos", { fullName: "acme/four" }))).body as { repo: { id: string } }).repo
    const refused = await none.handle(req("POST", `repos/${repo2.id}/pulls/1/review`)).catch((e: PluginError) => e)
    assert.ok(refused instanceof PluginError && refused.status === 503, "no inference is a 503")
    const overview = await none.handle(req("GET", ""))
    assert.strictEqual((overview.body as { review: { available: boolean } }).review.available, false)
    await none.stop()
  })

  test("a finished review can be posted to the host, and auto-post does it as a comment straight away", async () => {
    const { inference } = scripted("## Summary\nOk.\n\n## Verdict\nApprove.")
    const posts: Array<{ number: number; as: string; body: string }> = []
    const dir = path.join(scratch, "reviews-post")
    fs.mkdirSync(dir, { recursive: true })
    const bus = new PluginEventBus()
    const seen: string[] = []
    bus.on((event) => seen.push(event.type))
    const p = new PullsPlugin(
      { dataDir: dir, log: createGatewayLog(() => undefined), fetch, now: Date.now, inference, events: bus },
      () => ({
        ...forge({ 1: "aaa", 2: "bbb" })(),
        postReview: async (_repo: { fullName: string }, pull: { number: number }, body: string, as: string) => {
          posts.push({ number: pull.number, as, body })
          return { url: `x://posted/${pull.number}` }
        }
      }),
      0
    )
    p.start()
    const repo = ((await p.handle(req("POST", "repos", { fullName: "acme/post" }))).body as { repo: { id: string } }).repo
    // Nothing to post before a review exists.
    const early = await p.handle(req("POST", `repos/${repo.id}/pulls/1/review/post`)).catch((e: PluginError) => e)
    assert.ok(early instanceof PluginError && early.status === 409)
    await p.handle(req("POST", `repos/${repo.id}/pulls/1/review`))
    const posted = await p.handle(req("POST", `repos/${repo.id}/pulls/1/review/post`, { as: "approve" }))
    const review = (posted.body as { review: ReviewRecord }).review
    assert.strictEqual(review.postedAs, "approve")
    assert.strictEqual(review.postedUrl, "x://posted/1")
    assert.strictEqual(review.postedBy, "op")
    assert.ok(review.postedAt)
    assert.deepStrictEqual(posts.map((post) => `${post.number}:${post.as}`), ["1:approve"])
    assert.match(posts[0].body, /Reviewed by twinny-server with `coder`/)
    assert.ok(seen.includes("review.posted"))
    const listing = await p.handle(req("GET", ""))
    assert.strictEqual((listing.body as { repos: Array<{ reviews: Record<number, { posted?: boolean }> }> }).repos[0].reviews[1].posted, true)

    // Auto-post: the next review goes straight to the host as a comment.
    await p.handle(req("PUT", `repos/${repo.id}`, { autoPost: true }))
    const auto = await p.handle(req("POST", `repos/${repo.id}/pulls/2/review`))
    assert.strictEqual((auto.body as { review: ReviewRecord }).review.postedAs, "comment")
    assert.strictEqual((auto.body as { review: ReviewRecord }).review.postedBy, "auto")
    assert.deepStrictEqual(posts.map((post) => `${post.number}:${post.as}`), ["1:approve", "2:comment"])
    await p.stop()
  })


  test("the model's JSON is read leniently and labels are matched to the project's own", () => {
    const parsed = parseTriage("Sure! ```json\n{\"labels\": [\"BUG\", \"nope\"], \"duplicateOf\": 12, \"priority\": \"high\", \"reply\": \"Thanks.\"}\n```", ["bug", "docs"])
    assert.deepStrictEqual(parsed, { labels: ["bug"], duplicateOf: 12, priority: "high", reply: "Thanks." })
    assert.deepStrictEqual(parseTriage("{\"labels\": [], \"duplicateOf\": null, \"priority\": \"urgent\", \"reply\": \"\"}", []), { labels: [], reply: "" })
    assert.throws(() => parseTriage("no json here", []), /did not answer with JSON/)
  })

  test("issues are synced, triaged on demand or in the background, and the reply and labels are posted on request", async () => {
    const { inference, calls } = scripted("{\"labels\": [\"bug\"], \"duplicateOf\": 7, \"priority\": \"high\", \"reply\": \"Thanks, this looks like #7; which version?\"}")
    const comments: Array<{ number: number; body: string }> = []
    const labelled: Array<{ number: number; labels: string[] }> = []
    const bus = new PluginEventBus()
    const seen: string[] = []
    bus.on((event) => seen.push(event.type))
    const dir = path.join(scratch, "triage")
    fs.mkdirSync(dir, { recursive: true })
    const issue = (number: number, title: string) => ({ repo: "acme/tri", number, title, author: "dana", url: `x://issues/${number}`, createdAt: "", updatedAt: `2026-09-1${number}T00:00:00Z`, labels: [], comments: 0 })
    const p = new PullsPlugin(
      { dataDir: dir, log: createGatewayLog(() => undefined), fetch, now: Date.now, inference, events: bus },
      () => ({
        ...forge({})(),
        listIssues: async () => [issue(7, "Crash on start"), issue(9, "Crashes when starting")],
        issueBody: async () => "It crashes.",
        listLabels: async () => ["bug", "docs"],
        commentIssue: async (_r: unknown, number: number, body: string) => {
          comments.push({ number, body })
          return { url: `x://c/${number}` }
        },
        labelIssue: async (_r: unknown, number: number, labels: string[]) => {
          labelled.push({ number, labels })
        }
      }),
      0
    )
    p.start()
    const repo = ((await p.handle(req("POST", "repos", { fullName: "acme/tri" }))).body as { repo: { id: string; issues: unknown[]; issuesSupported: boolean } }).repo
    assert.strictEqual(repo.issuesSupported, true)
    assert.strictEqual(repo.issues.length, 2)

    const triaged = await p.handle(req("POST", `repos/${repo.id}/issues/9/triage`))
    const record = (triaged.body as { triage: TriageRecord }).triage
    assert.strictEqual(record.status, "done")
    assert.deepStrictEqual(record.labels, ["bug"])
    assert.strictEqual(record.duplicateOf, 7)
    assert.strictEqual(record.priority, "high")
    assert.match(calls[0].prompt, /#7: Crash on start/)
    assert.match(calls[0].prompt, /Labels the project uses\nbug, docs/)
    assert.ok(seen.includes("issue.triaged"))
    const detail = await p.handle(req("GET", `repos/${repo.id}/issues/9`))
    assert.strictEqual((detail.body as { body: string }).body, "It crashes.")
    const listing = await p.handle(req("GET", ""))
    const view = (listing.body as { repos: Array<{ triage: Record<number, { priority: string; replied: boolean }> }> }).repos[0]
    assert.deepStrictEqual(view.triage[9], { ...view.triage[9], priority: "high", replied: false })

    const posted = await p.handle(req("POST", `repos/${repo.id}/issues/9/triage/post`, { replyText: "Thanks, see #7." }))
    const after = (posted.body as { triage: TriageRecord }).triage
    assert.ok(after.repliedAt && after.labeledAt)
    assert.deepStrictEqual(comments.map((c) => c.number), [9])
    assert.match(comments[0].body, /Thanks, see #7\.\n\n---\n_Triaged by twinny-server/)
    assert.deepStrictEqual(labelled, [{ number: 9, labels: ["bug"] }])

    // Auto-triage picks the untriaged issue when no review is due; posting still waits for a person.
    await p.handle(req("PUT", `repos/${repo.id}`, { autoTriage: true }))
    await p.autoReview()
    assert.strictEqual(p.triage.latest(repo.id, 7)?.status, "done")
    assert.strictEqual(comments.length, 1)
    await p.autoReview()
    assert.strictEqual(calls.length, 2, "nothing left to triage")
    await p.stop()
  })

  test("the prompt fits a small context: patches beyond the budget are named, not sent", () => {
    const big = "+".repeat(REVIEW_PROMPT_BUDGET)
    const messages = reviewMessages(
      {
        pull: { repo: "a/b", number: 1, title: "t", author: "x", url: "", draft: false, createdAt: "", updatedAt: "", headRef: "h", baseRef: "m", headSha: "s", checks: "none", checkRuns: [], mergeable: "unknown", review: "none", labels: [] },
        body: "d",
        files: [
          { path: "small.ts", status: "modified", additions: 1, deletions: 0, patch: "+x" },
          { path: "huge.ts", status: "added", additions: 9, deletions: 0, patch: big }
        ],
        moreFiles: 2
      },
      "Pull request"
    )
    assert.strictEqual(messages[0].role, "system")
    const user = String(messages[1].content)
    assert.ok(user.length < REVIEW_PROMPT_BUDGET + 500)
    assert.match(user, /small\.ts[\s\S]*```diff\n\+x\n```/)
    assert.match(user, /huge\.ts \(\+9 −0\)\n\(diff left out: too large for this review\)/)
    assert.match(user, /\(2 more changed files not shown\)/)
  })

  test("a review the output cap cut off says so, and a finished review can be asked about", async () => {
    const calls: Array<{ messages: ChatMessage[]; options: { maxTokens?: number; think?: boolean } }> = []
    let reply = "## Summary\nThis migrates the router and wraps the existing v5"
    let finish: "stop" | "length" = "length"
    const inference = {
      chatAliases: () => ["chat"],
      embeddingAliases: () => [],
      embed: async () => [],
      active: () => 0,
      async *chat(_alias: string, messages: ChatMessage[], options: { maxTokens?: number; think?: boolean; onFinish?: (reason: "stop" | "length") => void }) {
        calls.push({ messages, options })
        yield reply
        options.onFinish?.(finish)
      }
    }
    const dir = path.join(scratch, "reviews-ask")
    const p = plugin(dir, inference, { 1: "aaa" })
    p.start()
    const repo = ((await p.handle(req("POST", "repos", { fullName: "acme/ask" }))).body as { repo: { id: string } }).repo
    const early = await p.handle(req("POST", `repos/${repo.id}/pulls/1/review/ask`, { question: "why?" })).catch((e: PluginError) => e)
    assert.ok(early instanceof PluginError && early.status === 409, "nothing to ask about before a review")

    const reviewed = ((await p.handle(req("POST", `repos/${repo.id}/pulls/1/review`))).body as { review: ReviewRecord }).review
    assert.strictEqual(reviewed.status, "done")
    assert.strictEqual(reviewed.text, reply)
    assert.match(reviewed.cutShort ?? "", /limit of 4,000 output tokens before it finished\./)
    assert.strictEqual(calls[0].options.maxTokens, 4000)

    const blank = await p.handle(req("POST", `repos/${repo.id}/pulls/1/review/ask`, { question: "  " })).catch((e: PluginError) => e)
    assert.ok(blank instanceof PluginError && blank.status === 400)

    reply = "Because the compat layer keeps v5 routes working."
    finish = "stop"
    const asked = ((await p.handle(req("POST", `repos/${repo.id}/pulls/1/review/ask`, { question: "Why wrap v5?" }))).body as { review: ReviewRecord }).review
    const prompt = calls[1].messages
    assert.strictEqual(prompt[0].role, "system")
    assert.match(String(prompt[1].content), /Does a thing\./, "the pull is in front of the model")
    assert.deepStrictEqual(prompt[2], { role: "assistant", content: reviewed.text }, "so is the review")
    assert.deepStrictEqual(prompt[3], { role: "user", content: "Why wrap v5?" })
    assert.strictEqual(calls[1].options.maxTokens, 2000)
    assert.strictEqual(calls[1].options.think, false)
    assert.strictEqual(asked.thread?.length, 2)
    assert.strictEqual(asked.thread?.[0].by, "op")
    assert.strictEqual(asked.thread?.[1].text, reply)
    assert.strictEqual(asked.thread?.[1].cutShort, undefined)
    assert.ok(asked.cutShort, "the review itself is still marked as cut")

    reply = "Yes."
    const again = ((await p.handle(req("POST", `repos/${repo.id}/pulls/1/review/ask`, { question: "Is it safe?" }))).body as { review: ReviewRecord }).review
    assert.deepStrictEqual(calls[2].messages.slice(3), [
      { role: "user", content: "Why wrap v5?" },
      { role: "assistant", content: "Because the compat layer keeps v5 routes working." },
      { role: "user", content: "Is it safe?" }
    ])
    assert.strictEqual(again.thread?.length, 4)
    const page = (await p.handle(req("GET", `repos/${repo.id}/pulls/1`))).body as PullPage
    assert.strictEqual(page.review?.thread?.length, 4)
    assert.strictEqual(ReviewStore.open(path.join(dir, "reviews.json")).latest(repo.id, 1)?.thread?.length, 4, "the thread survives a restart")

    reply = "## Summary\nAll of it.\n\n## Verdict\nApprove."
    const fresh = ((await p.handle(req("POST", `repos/${repo.id}/pulls/1/review`))).body as { review: ReviewRecord }).review
    assert.strictEqual(fresh.thread, undefined, "a new review starts a new thread")
    assert.strictEqual(fresh.cutShort, undefined)
    await p.stop()
  })

})

suite("Reviews and reasoning models", () => {
  test("inline and unclosed <think> blocks are stripped from an answer", () => {
    assert.strictEqual(stripThinking("<think>hmm</think>\n## Summary\nFine."), "## Summary\nFine.")
    assert.strictEqual(stripThinking("<think>still thinking when the budget ran out"), "")
    assert.strictEqual(stripThinking("## Summary\nNo thinking here."), "## Summary\nNo thinking here.")
  })

  test("a model that only reasons fails with a reason, and think:false is asked for", async () => {
    let asked: { think?: boolean } = {}
    const inference = {
      chatAliases: () => ["chat"],
      embeddingAliases: () => [],
      embed: async () => [],
      active: () => 0,
      async *chat(_alias: string, _messages: ChatMessage[], options: { think?: boolean; onReasoning?: (t: string) => void }) {
        asked = { think: options.think }
        options.onReasoning?.("Let me think about this diff very carefully...")
        yield ""
      }
    }
    const dir = path.join(scratch, "reviews-thinking")
    fs.mkdirSync(dir, { recursive: true })
    const forge = () => ({
      noun: "Pull request",
      repoUrl: (name: string) => `x://${name}`,
      hasAppAuth: () => true,
      checkRepo: async (repo: { fullName: string }) => repo.fullName,
      listPulls: async (repo: { fullName: string }) => [{ repo: repo.fullName, number: 1, title: "t", author: "a", url: "", draft: false, createdAt: "", updatedAt: "2026-09-19T00:00:00Z", headRef: "h", baseRef: "m", headSha: "s", checks: "none" as const, checkRuns: [], mergeable: "unknown" as const, review: "none" as const, labels: [] }],
      pullContent: async () => ({ body: "", files: [], moreFiles: 0 }),
      postReview: async () => ({}),
      status: () => ({ baseUrl: "x://" })
    })
    const p = new PullsPlugin({ dataDir: dir, log: createGatewayLog(() => undefined), fetch, now: Date.now, inference }, forge, 0)
    p.start()
    const repo = ((await p.handle({ method: "POST", path: "repos", query: new URLSearchParams(), body: async () => ({ fullName: "acme/think" }), principal: "op" })).body as { repo: { id: string } }).repo
    const reviewed = await p.handle({ method: "POST", path: `repos/${repo.id}/pulls/1/review`, query: new URLSearchParams(), body: async () => ({}), principal: "op" })
    const review = (reviewed.body as { review: ReviewRecord }).review
    assert.strictEqual(review.status, "failed")
    assert.match(review.error ?? "", /spent its whole answer thinking \(46 characters of reasoning\)/)
    assert.strictEqual(asked.think, false)
    await p.stop()
  })
})

/**
 * The Gitea and Bitbucket forges against stand-in servers, the unified
 * diff splitter they share, and the Discord and Teams message shapes.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as http from "http"
import * as os from "os"
import * as path from "path"

import { createGatewayLog } from "../../gateway/log"
import { BitbucketForge } from "../../gateway/plugins/bitbucket"
import { discordPayload } from "../../gateway/plugins/discord"
import { splitUnifiedDiff } from "../../gateway/plugins/forge"
import { GiteaForge } from "../../gateway/plugins/gitea"
import type { PluginContext } from "../../gateway/plugins/host"
import { PullsPlugin } from "../../gateway/plugins/pulls"
import { teamsPayload } from "../../gateway/plugins/teams"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-forges-test-"))

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 const a = 1
-const b = 2
+const b = 3
 export { a, b }
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const fresh = true
+export const also = 1
diff --git a/old-name.md b/new-name.md
similarity index 100%
rename from old-name.md
rename to new-name.md
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`

const listen = (server: http.Server): Promise<string> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)))

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

const context = (name: string): PluginContext => {
  const dir = path.join(scratch, name)
  fs.mkdirSync(dir, { recursive: true })
  return { dataDir: dir, log: createGatewayLog(() => undefined), fetch, now: Date.now }
}
const req = (method: string, route: string, body: Record<string, unknown> = {}) => ({ method, path: route, query: new URLSearchParams(), body: async () => body, principal: "op" })

suite("Unified diff splitter", () => {
  test("one entry per file with status, rename and counts", () => {
    const { files, moreFiles } = splitUnifiedDiff(DIFF)
    assert.strictEqual(moreFiles, 0)
    assert.deepStrictEqual(
      files.map((file) => `${file.status} ${file.previousPath ? `${file.previousPath}→` : ""}${file.path} +${file.additions} -${file.deletions}`),
      ["modified src/a.ts +1 -1", "added src/new.ts +2 -0", "renamed old-name.md→new-name.md +0 -0", "removed gone.txt +0 -1"]
    )
    assert.ok(files[0].patch?.startsWith("@@ -1,3 +1,3 @@"))
    assert.strictEqual(files[2].patch, undefined, "a pure rename has no hunk")
    assert.deepStrictEqual(splitUnifiedDiff("").files, [])
  })
})

suite("Gitea forge", function () {
  this.timeout(20_000)

  test("lists pulls with statuses and reviews, and reads a pull's diff", async () => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://fake")
      if (req.headers.authorization !== "token gta_secret") return json(res, 401, { message: "token is required" })
      const route = `${req.method} ${url.pathname}`
      if (route === "GET /api/v1/repos/acme/tools") return json(res, 200, { full_name: "acme/tools" })
      if (route === "GET /api/v1/repos/acme/tools/pulls")
        return json(res, 200, [
          { number: 4, title: "Faster index", html_url: "https://git.example/acme/tools/pulls/4", draft: false, created_at: "2026-09-18T00:00:00Z", updated_at: "2026-09-19T00:00:00Z", user: { login: "dana" }, head: { ref: "faster", sha: "f00" }, base: { ref: "main" }, mergeable: true, labels: [{ name: "perf" }], requested_reviewers: [{ login: "eve" }, { login: "finn" }] }
        ])
      if (route === "GET /api/v1/repos/acme/tools/commits/f00/status") return json(res, 200, { state: "failure", statuses: [{ context: "ci/build", status: "success", target_url: "https://ci/1" }, { context: "ci/test", status: "failure", target_url: "https://ci/2" }] })
      if (route === "GET /api/v1/repos/acme/tools/pulls/4/reviews") return json(res, 200, [{ user: { login: "eve" }, state: "REQUEST_CHANGES" }, { user: { login: "eve" }, state: "APPROVED" }])
      if (route === "GET /api/v1/repos/acme/tools/branch_protections/main") return json(res, 200, { branch_name: "main", required_approvals: 2 })
      if (route === "GET /api/v1/repos/acme/tools/pulls/4") return json(res, 200, { body: "Index in one pass." })
      if (route === "GET /api/v1/repos/acme/tools/pulls/4.diff") {
        res.writeHead(200, { "Content-Type": "text/plain" })
        return res.end(DIFF)
      }
      json(res, 404, { message: "not found" })
      return undefined
    })
    const url = await listen(server)
    try {
      const plugin = new PullsPlugin(context("gitea"), (store, ctx) => new GiteaForge(store, ctx), 0, "gitea")
      plugin.start()
      await plugin.handle(req("PUT", "settings", { baseUrl: url }))
      const refused = await plugin.handle(req("POST", "repos", { fullName: "acme/tools", token: "wrong" })).catch((e: Error) => e)
      assert.ok(refused instanceof Error && /token was refused/.test(refused.message))
      const added = await plugin.handle(req("POST", "repos", { fullName: "acme/tools", token: "gta_secret" }))
      const repo = (added.body as { repo: { id: string; url: string; pulls: Array<Record<string, unknown>> } }).repo
      assert.strictEqual(repo.url, `${url}/acme/tools`)
      const [pull] = repo.pulls
      assert.strictEqual(pull.number, 4)
      assert.strictEqual(pull.author, "dana")
      assert.strictEqual(pull.checks, "failure")
      assert.deepStrictEqual((pull.checkRuns as Array<{ name: string; state: string }>).map((c) => `${c.name}=${c.state}`), ["ci/build=success", "ci/test=failure"])
      assert.strictEqual(pull.review, "approved", "the reviewer's latest word wins")
      assert.deepStrictEqual(pull.approvals, { approved: ["eve"], changes: [], pending: ["finn"], required: 2 }, "who answered, who is still asked, what the branch wants")
      assert.strictEqual(pull.mergeable, "mergeable")
      assert.deepStrictEqual(pull.labels, ["perf"])
      const detail = await plugin.handle(req("GET", `repos/${repo.id}/pulls/4`))
      assert.strictEqual(detail.body && (detail.body as { body: string }).body, "Index in one pass.")
      assert.strictEqual((detail.body as { files: unknown[] }).files.length, 4)
      await plugin.stop()
    } finally {
      server.close()
    }
  })
})

suite("Bitbucket forge", function () {
  this.timeout(20_000)

  test("uses Basic auth for user:app-password, lists pulls with build statuses and approvals, and reads the diff", async () => {
    const expected = `Basic ${Buffer.from("rich:app-pass").toString("base64")}`
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://fake")
      if (req.headers.authorization !== expected) return json(res, 401, { error: { message: "Access token expired." } })
      const route = `${req.method} ${url.pathname}`
      if (route === "GET /2.0/repositories/acme/widgets") return json(res, 200, { full_name: "acme/widgets" })
      if (route === "GET /2.0/repositories/acme/widgets/pullrequests")
        return json(res, 200, {
          values: [
            { id: 12, title: "Retry uploads", draft: true, created_on: "2026-09-18T00:00:00+00:00", updated_on: "2026-09-19T00:00:00+00:00", links: { html: { href: "https://bitbucket.org/acme/widgets/pull-requests/12" } }, author: { nickname: "sam", display_name: "Sam" }, source: { branch: { name: "retry" }, commit: { hash: "abc" } }, destination: { branch: { name: "main" } }, participants: [{ approved: true, state: "approved", role: "REVIEWER", user: { nickname: "kim" } }, { approved: false, state: null, role: "REVIEWER", user: { nickname: "lee" } }, { approved: false, state: null, role: "PARTICIPANT", user: { nickname: "sam" } }] }
          ]
        })
      if (route === "GET /2.0/repositories/acme/widgets/commit/abc/statuses") return json(res, 200, { values: [{ name: "Pipeline", state: "INPROGRESS", url: "https://bitbucket.org/p/1" }] })
      if (route === "GET /2.0/repositories/acme/widgets/pullrequests/12") return json(res, 200, { summary: { raw: "Retries once." } })
      if (route === "GET /2.0/repositories/acme/widgets/pullrequests/12/diff") {
        res.writeHead(200, { "Content-Type": "text/plain" })
        return res.end(DIFF)
      }
      json(res, 404, { error: { message: "nope" } })
      return undefined
    })
    const url = await listen(server)
    try {
      const plugin = new PullsPlugin(context("bitbucket"), (store, ctx) => new BitbucketForge(store, ctx), 0, "bitbucket")
      plugin.start()
      await plugin.handle(req("PUT", "settings", { baseUrl: url }))
      const added = await plugin.handle(req("POST", "repos", { fullName: "acme/widgets", token: "rich:app-pass" }))
      assert.strictEqual(added.status, 201, JSON.stringify(added.body))
      const repo = (added.body as { repo: { id: string; pulls: Array<Record<string, unknown>> } }).repo
      const [pull] = repo.pulls
      assert.strictEqual(pull.number, 12)
      assert.strictEqual(pull.author, "sam")
      assert.strictEqual(pull.draft, true)
      assert.strictEqual(pull.checks, "pending")
      assert.strictEqual(pull.review, "approved")
      assert.deepStrictEqual(pull.approvals, { approved: ["kim"], changes: [], pending: ["lee"] }, "reviewers only; the author is a participant")
      assert.strictEqual(pull.headRef, "retry")
      const detail = await plugin.handle(req("GET", `repos/${repo.id}/pulls/12`))
      assert.strictEqual((detail.body as { body: string }).body, "Retries once.")
      assert.strictEqual((detail.body as { files: Array<{ path: string }> }).files[1].path, "src/new.ts")
      await plugin.stop()
    } finally {
      server.close()
    }
  })
})

suite("Notifier payloads", () => {
  const event = { type: "review.changes", source: "github", at: "2026-09-20T00:00:00Z", level: "warn" as const, title: "Review of acme/widgets#7: request changes", text: "Retry is missing.", url: "https://github.com/acme/widgets/pull/7" }

  test("Discord gets an embed with the level's colour and a link", () => {
    const payload = discordPayload(event)
    assert.strictEqual(payload.embeds.length, 1)
    assert.strictEqual(payload.embeds[0].title, event.title)
    assert.strictEqual(payload.embeds[0].url, event.url)
    assert.strictEqual(payload.embeds[0].description, "Retry is missing.")
    assert.strictEqual(payload.embeds[0].color, 0xc98500)
    assert.strictEqual(discordPayload({ ...event, url: undefined, text: "" }).embeds[0].url, undefined)
  })

  test("Teams gets an Adaptive Card with an Open action", () => {
    const payload = teamsPayload(event)
    assert.strictEqual(payload.type, "message")
    const card = payload.attachments[0].content
    assert.strictEqual(card.type, "AdaptiveCard")
    assert.strictEqual(card.body[0].text, event.title)
    assert.strictEqual(card.body[0].color, "warning")
    assert.deepStrictEqual(card.actions, [{ type: "Action.OpenUrl", title: "Open", url: event.url }])
    assert.strictEqual(teamsPayload({ ...event, url: undefined }).attachments[0].content.actions, undefined)
  })
})

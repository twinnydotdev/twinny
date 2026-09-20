/**
 * The Slack plugin: webhooks are kept without ever being shown, events
 * from the other plugins and from the gateway's health reach the
 * channels that asked for them in Slack's shape, a test posts at once,
 * and failures are recorded rather than thrown.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as http from "http"
import * as os from "os"
import * as path from "path"

import { createGatewayLog } from "../../gateway/log"
import { PluginEventBus } from "../../gateway/plugins/events"
import type { PluginContext, PluginError } from "../../gateway/plugins/host"
import { PullsPlugin, summaryOf, verdictOf } from "../../gateway/plugins/pulls"
import { slackPayload, SlackPlugin, WebhookStore } from "../../gateway/plugins/slack"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-slack-test-"))

const fakeSlack = async (): Promise<{ url: string; posts: Array<{ path: string; body: { text: string } }>; failNext: { status: number } | null; close: () => void }> => {
  const state = { posts: [] as Array<{ path: string; body: { text: string } }>, failNext: null as { status: number } | null }
  const server = http.createServer(async (req, res) => {
    let text = ""
    for await (const chunk of req) text += chunk
    if (state.failNext) {
      const { status } = state.failNext
      state.failNext = null
      res.writeHead(status)
      return res.end("invalid_payload")
    }
    state.posts.push({ path: req.url ?? "", body: JSON.parse(text) as { text: string } })
    res.writeHead(200)
    res.end("ok")
    return undefined
  })
  const url = await new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)))
  return {
    url,
    get posts() {
      return state.posts
    },
    get failNext() {
      return state.failNext
    },
    set failNext(value) {
      state.failNext = value
    },
    close: () => server.close()
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150))
const req = (method: string, route: string, body: Record<string, unknown> = {}) => ({ method, path: route, query: new URLSearchParams(), body: async () => body, principal: "op" })

suite("Slack plugin", function () {
  this.timeout(20_000)

  test("webhooks are kept secret, events reach the channels that want them, and a test posts at once", async () => {
    const slack = await fakeSlack()
    const bus = new PluginEventBus()
    const dir = path.join(scratch, "slack")
    fs.mkdirSync(dir, { recursive: true })
    const context: PluginContext = { dataDir: dir, log: createGatewayLog(() => undefined), fetch, now: Date.now, events: bus }
    const plugin = new SlackPlugin(context, 0)
    plugin.start()
    try {
      const bad = await plugin.handle(req("POST", "webhooks", { name: "#eng", url: "not a url" })).catch((e: PluginError) => e)
      assert.ok(bad instanceof Error && /webhook URL/.test(bad.message))
      const unknown = await plugin.handle(req("POST", "webhooks", { name: "#eng", url: `${slack.url}/services/T/B/x`, events: ["nope"] })).catch((e: PluginError) => e)
      assert.ok(unknown instanceof Error && /not an event/.test(unknown.message))

      const all = await plugin.handle(req("POST", "webhooks", { name: "#eng", url: `${slack.url}/services/T/B/all` }))
      assert.strictEqual(all.status, 201)
      const only = await plugin.handle(req("POST", "webhooks", { name: "#ops", url: `${slack.url}/services/T/B/ops`, events: ["backup.failed", "backend.down"] }))
      const ops = (only.body as { webhook: { id: string; host: string } }).webhook
      assert.strictEqual(ops.host, new URL(slack.url).host)
      const overview = await plugin.handle(req("GET", ""))
      assert.ok(!JSON.stringify(overview.body).includes("/services/"), "URLs never come back")
      assert.strictEqual(fs.statSync(path.join(dir, "webhooks.json")).mode & 0o777, 0o600)
      assert.strictEqual(WebhookStore.open(path.join(dir, "webhooks.json")).all()[1].url, `${slack.url}/services/T/B/ops`)

      bus.emit({ type: "review.changes", source: "github", level: "warn", title: "Review of acme/widgets#7: request changes", text: "Summary here.", url: "https://github.com/acme/widgets/pull/7" })
      bus.emit({ type: "backup.failed", source: "backups", level: "error", title: "Backup failed", text: "disk full" })
      await settle()
      assert.deepStrictEqual(
        slack.posts.map((post) => post.path),
        ["/services/T/B/all", "/services/T/B/all", "/services/T/B/ops"]
      )
      assert.strictEqual(slack.posts[0].body.text, ":warning: *<https://github.com/acme/widgets/pull/7|Review of acme/widgets#7: request changes>*\nSummary here.")
      assert.strictEqual(slack.posts[2].body.text, ":x: *Backup failed*\ndisk full")

      const tested = await plugin.handle(req("POST", `webhooks/${ops.id}/test`))
      assert.strictEqual(tested.status, 200)
      assert.match(slack.posts[3].body.text, /can reach this channel/)

      // A refusal is recorded against the delivery, not thrown at the emitter.
      slack.failNext = { status: 400 }
      bus.emit({ type: "backend.down", source: "gateway", level: "error", title: "Backend local is down", text: "" })
      await settle()
      // Both channels wanted it; whichever posted first hit the refusal, the other still got it.
      const latest = plugin.deliveries().slice(0, 2)
      assert.strictEqual(latest.filter((delivery) => delivery.ok).length, 1, "the other channel still got it")
      assert.match(latest.find((delivery) => !delivery.ok)?.error ?? "", /answered 400: invalid_payload/)

      // Editing keeps the URL when none is given and narrows the events.
      await plugin.handle(req("PUT", `webhooks/${ops.id}`, { events: ["backup.ok"] }))
      const opsBefore = slack.posts.filter((post) => post.path.endsWith("/ops")).length
      bus.emit({ type: "backend.down", source: "gateway", level: "error", title: "again", text: "" })
      await settle()
      assert.strictEqual(slack.posts.filter((post) => post.path.endsWith("/ops")).length, opsBefore, "ops no longer gets backend.down")
      assert.strictEqual(slack.posts[slack.posts.length - 1].path, "/services/T/B/all", "the other channel still does")
      assert.strictEqual((await plugin.handle(req("DELETE", `webhooks/${ops.id}`))).status, 200)
      assert.strictEqual(WebhookStore.open(path.join(dir, "webhooks.json")).all().length, 1)
    } finally {
      await plugin.stop()
      slack.close()
    }
  })

  test("backend health is polled and only changes are reported", async () => {
    const bus = new PluginEventBus()
    const seen: string[] = []
    bus.on((event) => seen.push(`${event.type}:${event.title}`))
    let ok = true
    const dir = path.join(scratch, "health")
    fs.mkdirSync(dir, { recursive: true })
    const plugin = new SlackPlugin({ dataDir: dir, log: createGatewayLog(() => undefined), fetch, now: Date.now, events: bus, health: async () => [{ provider: "local", ok, ...(ok ? {} : { kind: "provider-unavailable" }) }] }, 0)
    await plugin.pollHealth()
    await plugin.pollHealth()
    assert.strictEqual(seen.length, 0, "the first look sets the baseline; nothing changed after")
    ok = false
    await plugin.pollHealth()
    await plugin.pollHealth()
    ok = true
    await plugin.pollHealth()
    assert.deepStrictEqual(seen, ["backend.down:Backend local is down", "backend.up:Backend local answers again"])
    await plugin.stop()
  })

  test("the pulls plugin reports reviews, new pulls and newly failing checks on the bus", async () => {
    const bus = new PluginEventBus()
    const seen: Array<{ type: string; title: string; text: string }> = []
    bus.on((event) => seen.push({ type: event.type, title: event.title, text: event.text }))
    const heads: Record<number, { sha: string; checks: "success" | "failure" | "none" }> = { 1: { sha: "a", checks: "success" } }
    const inference = {
      chatAliases: () => ["chat"],
      active: () => 0,
      async *chat() {
        yield "## Summary\nSwaps the loop for a batch call.\n\n## Issues\n- none\n\n## Verdict\n**Request changes** - the retry is missing."
      }
    }
    const dir = path.join(scratch, "pulls-events")
    fs.mkdirSync(dir, { recursive: true })
    const plugin = new PullsPlugin(
      { dataDir: dir, log: createGatewayLog(() => undefined), fetch, now: Date.now, events: bus, inference },
      () => ({
        noun: "Pull request",
        repoUrl: (name: string) => `x://${name}`,
        hasAppAuth: () => true,
        checkRepo: async (repo: { fullName: string }) => repo.fullName,
        listPulls: async (repo: { fullName: string }) =>
          Object.entries(heads).map(([number, head]) => ({
            repo: repo.fullName,
            number: Number(number),
            title: `Pull ${number}`,
            author: "alice",
            url: `x://${repo.fullName}/${number}`,
            draft: false,
            createdAt: "",
            updatedAt: `2026-09-19T0${number}:00:00Z`,
            headRef: "h",
            baseRef: "m",
            headSha: head.sha,
            checks: head.checks,
            checkRuns: head.checks === "none" ? [] : [{ name: "test", state: head.checks }],
            mergeable: "unknown" as const,
            review: "none" as const,
            labels: []
          })),
        pullContent: async () => ({ body: "", files: [], moreFiles: 0 }),
        status: () => ({ baseUrl: "x://" })
      }),
      0,
      "github"
    )
    plugin.start()
    const repo = ((await plugin.handle(req("POST", "repos", { fullName: "acme/one" }))).body as { repo: { id: string } }).repo
    assert.strictEqual(seen.length, 0, "the first sync announces nothing")
    heads[2] = { sha: "b", checks: "none" }
    heads[1].checks = "failure"
    await plugin.syncOne({ id: repo.id, fullName: "acme/one", auth: "app", addedAt: "", addedBy: "" })
    assert.deepStrictEqual(
      seen.map((event) => `${event.type}|${event.title}`),
      ["pull.opened|acme/one#2 opened: Pull 2", "pull.checks-failed|Checks failed on acme/one#1: Pull 1"]
    )
    assert.match(seen[1].text, /Failing: test\./)

    await plugin.handle(req("POST", `repos/${repo.id}/pulls/1/review`))
    const review = seen[2]
    assert.strictEqual(review.type, "review.changes")
    assert.strictEqual(review.title, "Review of acme/one#1: request changes")
    assert.match(review.text, /reviewed by chat in \d+ s\.\nSwaps the loop for a batch call\./)
    await plugin.stop()
  })

  test("verdict and summary are read from a review's sections", () => {
    assert.strictEqual(verdictOf("## Verdict\nApprove: it is fine."), "approve")
    assert.strictEqual(verdictOf("## Verdict\n*Request changes* because…"), "request changes")
    assert.strictEqual(verdictOf("## Verdict\nComment"), "comment")
    assert.strictEqual(verdictOf("no sections at all"), undefined)
    assert.strictEqual(summaryOf("## Summary\nOne.\nTwo.\n\n## Issues\n- x"), "One. Two.")
    assert.deepStrictEqual(slackPayload({ type: "t", source: "s", at: "", level: "info", title: "Hello", text: "" }), { text: ":white_check_mark: *Hello*" })
  })
})

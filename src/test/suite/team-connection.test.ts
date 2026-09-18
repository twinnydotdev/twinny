import * as assert from "assert"
import http from "node:http"
import { AddressInfo } from "node:net"

import { API_PROVIDERS } from "../../common/constants"
import { ProviderType } from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"
import { policyRefusal } from "../../extension/providers/policy"
import { memoryPolicyStorage, TeamConnection, teamUrl } from "../../extension/providers/team"
import { RemoteTeam } from "../../protocol/types"
import { parseTeam } from "../../protocol/wire"

suite("Connect to team", function () {
  this.timeout(10_000)
  let server: http.Server
  let url: string
  let team: RemoteTeam
  let shared: boolean
  let refused: boolean
  let failFim: boolean
  /** Inference calls the fake gateway saw; connecting must make none. */
  let inferenceRequests: number
  let service: TeamConnection
  let providers: Record<string, TwinnyProvider>
  let active: Partial<Record<ProviderType, TwinnyProvider>>
  let tokens: Map<string, string>
  let failSave: boolean
  let policies: ReturnType<typeof memoryPolicyStorage>
  /** The fake gateway's sign-in: one outstanding request, decided by the test. */
  let signIn: { deviceCode: string; userCode: string; decision: "pending" | "approved" | "denied"; polls: number }
  /** The fake gateway's one invite. */
  let invite: { code: string; opened: number }
  const token = "personal-secret-test-value"
  const personal = (type: ProviderType): TwinnyProvider => ({
    id: `personal-${type}`,
    provider: "ollama",
    label: `Personal ${type}`,
    modelName: "personal-model",
    type,
    apiKey: ""
  })
  const input = () => ({ url, token })

  setup(async () => {
    team = {
      protocol: 1,
      defaults: { chat: "coder", fim: "coder", embeddings: "embed" },
      models: [
        { id: "coder", name: "coder", capabilities: ["chat", "fim"], model: "codestral-latest" },
        { id: "embed", name: "embed", capabilities: ["embeddings"] }
      ]
    }
    shared = false
    refused = false
    failFim = false
    inferenceRequests = 0
    failSave = false
    policies = memoryPolicyStorage()
    signIn = { deviceCode: "d".repeat(64), userCode: "BCDF-GHJK", decision: "pending", polls: 0 }
    invite = { code: "twi_" + "1".repeat(8) + "_" + "2".repeat(64), opened: 0 }
    providers = {}
    active = {}
    tokens = new Map()
    server = http.createServer((req, res) => {
      let raw = ""
      req.setEncoding("utf8")
      req.on("data", (chunk: string) => (raw += chunk))
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json")
        if (req.url === "/base/twinny/v1/signin") {
          assert.strictEqual(req.headers.authorization, undefined, "sign-in must carry no credential")
          const body = JSON.parse(raw) as { name?: string; machine?: string }
          assert.strictEqual(typeof body.machine, "string")
          res.writeHead(201).end(
            JSON.stringify({
              deviceCode: signIn.deviceCode,
              userCode: signIn.userCode,
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
              interval: 1
            })
          )
          return
        }
        if (req.url === "/base/twinny/v1/join") {
          assert.strictEqual(req.headers.authorization, undefined, "join must carry no credential")
          const body = JSON.parse(raw) as { code?: string; machine?: string }
          if (body.code !== invite.code) {
            res.writeHead(410).end(JSON.stringify({ error: { kind: "authentication", message: "This invite has already been used." } }))
            return
          }
          invite.opened++
          assert.strictEqual(typeof body.machine, "string")
          res.writeHead(201).end(JSON.stringify({ key: token, name: "alice", admin: false }))
          return
        }
        if (req.url === "/base/twinny/v1/signin/poll") {
          assert.strictEqual(req.headers.authorization, undefined)
          assert.strictEqual((JSON.parse(raw) as { deviceCode: string }).deviceCode, signIn.deviceCode)
          signIn.polls++
          res.end(
            JSON.stringify(
              signIn.decision === "approved"
                ? { status: "approved", key: token, name: "alice" }
                : { status: signIn.decision }
            )
          )
          return
        }
        assert.strictEqual(req.headers.authorization, `Bearer ${token}`)
        if (refused) {
          res
            .writeHead(401)
            .end(
              JSON.stringify({
                error: { kind: "authentication", message: "Key revoked" }
              })
            )
          return
        }
        if (req.url === "/base/twinny/v1/team") {
          res.end(JSON.stringify(team))
          return
        }
        if (req.url === "/base/twinny/v1/whoami") {
          res.end(JSON.stringify({ protocol: 1, key: "alice", shared }))
          return
        }
        if (/\/(embeddings|fim|chat)$/.test(req.url ?? "")) inferenceRequests++
        if (req.url === "/base/twinny/v1/embeddings") {
          res.end(JSON.stringify({ vectors: [[0.1, 0.2]] }))
          return
        }
        if (req.url === "/base/twinny/v1/fim" && failFim) {
          res
            .writeHead(503)
            .end(
              JSON.stringify({
                error: {
                  kind: "provider-unavailable",
                  message: "Model offline"
                }
              })
            )
          return
        }
        res.setHeader("Content-Type", "application/x-ndjson")
        res.end(
          `${JSON.stringify(
            req.url?.endsWith("/fim")
              ? { text: "return a+b" }
              : { content: "Hello" }
          )}\n{"done":true}\n`
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/base`
    service = new TeamConnection(
      {
        getProviders: async () => providers,
        saveProviders: async (next) => {
          if (failSave) {
            failSave = false
            throw new Error("Storage unavailable")
          }
          providers = next
        },
        getActive: (type) => active[type],
        setActive: async (type, provider) => {
          active[type] = provider
        }
      },
      {
        get: (id) => tokens.get(id),
        set: async (id, key) => {
          tokens.set(id, key)
        },
        delete: async (id) => {
          tokens.delete(id)
        }
      },
      policies
    )
  })
  teardown(async () => {
    service.cancel()
    ;(
      server as unknown as { closeAllConnections(): void }
    ).closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  test("previews the team defaults without touching the models, then saves them with keys only in secret storage", async () => {
    const preview = await service.preview(input())
    assert.strictEqual(preview.identity, "alice")
    assert.deepStrictEqual(preview.roles.map((role) => role.alias), ["coder", "coder", "embed"])
    assert.strictEqual(inferenceRequests, 0, "connecting sends nothing to the models")
    assert.strictEqual(Object.keys(providers).length, 0)
    assert.strictEqual(tokens.size, 0)
    assert.ok(!JSON.stringify(preview).includes(token))
    const result = await service.apply({
      previewId: preview.id,
      replaceExisting: false
    })
    assert.deepStrictEqual(result.connected, ["chat", "fim", "embedding"])
    assert.strictEqual(tokens.size, 3)
    assert.ok(
      Object.values(providers).every(
        (provider) =>
          provider.apiKey === "" &&
          provider.provider === API_PROVIDERS.TwinnyRemote &&
          provider.apiPath === "/base"
      )
    )
    assert.strictEqual(active.chat?.modelName, "coder")
    assert.strictEqual(active.embedding?.modelName, "embed")
    assert.strictEqual(active.fim?.modelName, "coder", "the alias is what the gateway is asked for")
    assert.strictEqual(active.fim?.fimTemplate, "codestral", "but the prompt format follows the backend model behind it")
    assert.ok(!JSON.stringify(providers).includes(token))
  })

  test("replacing active personal settings needs consent and preserves the original providers", async () => {
    const original = personal("chat")
    providers[original.id] = original
    active.chat = original
    const preview = await service.preview(input())
    assert.strictEqual(preview.roles[0].current?.id, original.id)
    await assert.rejects(
      service.apply({ previewId: preview.id, replaceExisting: false }),
      /Confirm replacing/
    )
    assert.strictEqual(active.chat, original)
    assert.strictEqual(tokens.size, 0)
    await service.apply({ previewId: preview.id, replaceExisting: true })
    assert.strictEqual(providers[original.id], original)
    assert.notStrictEqual(active.chat?.id, original.id)
  })

  test("a missing default leaves that job alone; a model that is down still connects", async () => {
    delete team.defaults.embeddings
    failFim = true
    active.embedding = personal("embedding")
    const preview = await service.preview(input())
    assert.strictEqual(preview.roles[1].alias, "coder")
    assert.strictEqual(preview.roles[2].alias, undefined)
    assert.deepStrictEqual(
      (await service.apply({ previewId: preview.id, replaceExisting: false }))
        .connected,
      ["chat", "fim"]
    )
    assert.strictEqual(active.embedding?.id, "personal-embedding")
    assert.strictEqual(active.fim?.modelName, "coder", "the admin fixes the model later; the developer is already connected")
  })

  test("reconnecting updates the same team entries rather than duplicating them", async () => {
    const first = await service.preview(input())
    await service.apply({ previewId: first.id, replaceExisting: false })
    const ids = Object.keys(providers)
    const next = await service.preview(input())
    await service.apply({ previewId: next.id, replaceExisting: true })
    assert.deepStrictEqual(Object.keys(providers), ids)
  })

  test("changed defaults, changed personal settings and revoked keys invalidate an unapplied preview", async () => {
    let preview = await service.preview(input())
    team.defaults = { chat: "coder" }
    await assert.rejects(
      service.apply({ previewId: preview.id, replaceExisting: true }),
      /defaults changed/
    )
    preview = await service.preview(input())
    active.chat = personal("chat")
    await assert.rejects(
      service.apply({ previewId: preview.id, replaceExisting: true }),
      /active settings changed/
    )
    preview = await service.preview(input())
    refused = true
    await assert.rejects(
      service.apply({ previewId: preview.id, replaceExisting: true }),
      /Key revoked/
    )
    assert.strictEqual(Object.keys(providers).length, 0)
  })

  test("shared tokens, cancelled previews and empty defaults cannot connect", async () => {
    shared = true
    await assert.rejects(service.preview(input()), /personal gateway key/)
    shared = false
    const preview = await service.preview(input())
    service.cancel()
    await assert.rejects(
      service.apply({ previewId: preview.id, replaceExisting: false }),
      /expired/
    )
    team.defaults = {}
    const empty = await service.preview(input())
    await assert.rejects(
      service.apply({ previewId: empty.id, replaceExisting: false }),
      /not set a default model/
    )
    assert.strictEqual(tokens.size, 0)
  })

  test("storage failure restores providers, active selections and secrets", async () => {
    const old = personal("chat")
    providers[old.id] = old
    active.chat = old
    const preview = await service.preview(input())
    failSave = true
    await assert.rejects(
      service.apply({ previewId: preview.id, replaceExisting: true }),
      /Storage unavailable/
    )
    assert.deepStrictEqual(providers, { [old.id]: old })
    assert.strictEqual(active.chat, old)
    assert.strictEqual(tokens.size, 0)
  })

  test("a sign-in shows the code, polls at the gateway's pace, and lands on the same preview with the key held here", async () => {
    const started = await service.startSignIn({ url })
    assert.strictEqual(started.userCode, "BCDF-GHJK")
    assert.strictEqual(started.intervalMs, 1_000)
    assert.ok(!JSON.stringify(started).includes(signIn.deviceCode), "device code sent to the webview")

    assert.deepStrictEqual(await service.pollSignIn({ id: started.id }), { status: "pending" })
    const before = Date.now()
    assert.deepStrictEqual(await service.pollSignIn({ id: started.id }), { status: "pending" })
    assert.ok(Date.now() - before >= 900, "a second poll waited for the interval")
    assert.deepStrictEqual(await service.pollSignIn({ id: "other" }), { status: "expired" })

    signIn.decision = "approved"
    const approved = await service.pollSignIn({ id: started.id })
    assert.strictEqual(approved.status, "approved")
    if (approved.status !== "approved") return
    assert.strictEqual(approved.name, "alice")
    assert.strictEqual(approved.preview.identity, "alice")
    assert.deepStrictEqual(approved.preview.roles.map((role) => role.alias), ["coder", "coder", "embed"])
    assert.ok(!JSON.stringify(approved).includes(token), "key sent to the webview")
    assert.deepStrictEqual(await service.pollSignIn({ id: started.id }), { status: "expired" }, "a finished sign-in is gone")

    // "Check again" from the webview sends no key; the one the sign-in produced is reused.
    const again = await service.preview({ url, token: "" })
    assert.strictEqual(again.identity, "alice")
    const result = await service.apply({ previewId: again.id, replaceExisting: false })
    assert.deepStrictEqual(result.connected, ["chat", "fim", "embedding"])
    assert.strictEqual(tokens.get("team-" + Object.keys(providers)[0].split("-")[1] + "-chat"), token)
    // After apply the key lives in secret storage, and a blank re-check reads it from there.
    const stored = await service.preview({ url, token: "" })
    assert.strictEqual(stored.identity, "alice", "the stored key is reused after apply")
    tokens.clear()
    await assert.rejects(service.preview({ url, token: "" }), /personal key/, "nothing remembered outside secret storage")
  })

  test("an invite link opens into the same preview, with the key held here until apply", async () => {
    const opened = await service.redeemInvite({ url, code: invite.code })
    assert.strictEqual(invite.opened, 1)
    assert.strictEqual(opened.name, "alice")
    assert.strictEqual(opened.preview.identity, "alice")
    assert.deepStrictEqual(opened.preview.roles.map((role) => role.alias), ["coder", "coder", "embed"])
    assert.ok(!JSON.stringify(opened).includes(token), "key sent to the webview")
    assert.strictEqual(tokens.size, 0, "nothing stored before apply")
    const result = await service.apply({ previewId: opened.preview.id, replaceExisting: false })
    assert.deepStrictEqual(result.connected, ["chat", "fim", "embedding"])
    assert.strictEqual(tokens.size, 3)
    assert.ok([...tokens.values()].every((stored) => stored === token))

    await assert.rejects(service.redeemInvite({ url, code: "twi_" + "9".repeat(8) + "_" + "9".repeat(64) }), /already been used/)
    await assert.rejects(service.redeemInvite({ url, code: "" }), /incomplete/)
    await assert.rejects(service.redeemInvite({ url: "ftp://x", code: invite.code }), /http/i)
  })

  test("a denied or failed sign-in reports why and keeps nothing", async () => {
    const started = await service.startSignIn({ url })
    signIn.decision = "denied"
    assert.deepStrictEqual(await service.pollSignIn({ id: started.id }), { status: "denied" })
    assert.deepStrictEqual(await service.pollSignIn({ id: started.id }), { status: "expired" })
    await assert.rejects(service.startSignIn({ url: "ftp://x" }), /HTTP or HTTPS/)
    await assert.rejects(service.startSignIn({ url: `${url}/admin` }), /without \/admin/)
    assert.strictEqual(tokens.size, 0)
  })

  test("a policy is shown before connecting, kept on apply, refreshed from the gateway, and released on leave", async () => {
    team.policy = { teamOnly: true, lockDefaults: true }
    const preview = await service.preview(input())
    assert.deepStrictEqual(preview.policy, { teamOnly: true, lockDefaults: true })
    assert.strictEqual(service.policy(), undefined, "nothing is enforced before apply")
    await service.apply({ previewId: preview.id, replaceExisting: false })
    const state = service.policy()
    assert.ok(state)
    assert.strictEqual(state.url, url)
    assert.deepStrictEqual(state.policy, team.policy)
    assert.strictEqual(state.providerIds.length, 3)
    assert.ok(state.providerIds.every((id) => providers[id]))

    // The rules, as the manager applies them.
    const personal = { id: "p1", provider: "openai", label: "x", modelName: "m", type: "chat" as const, apiKey: "" }
    assert.match(policyRefusal(state, "add", personal) ?? "", /does not allow openai providers/)
    assert.match(policyRefusal(state, "add", { ...personal, provider: "ollama" }) ?? "", /does not allow ollama providers/)
    assert.match(policyRefusal({ ...state, policy: { lockDefaults: true } }, "activate", { ...personal, provider: "ollama" }, "chat") ?? "", /keeps its default chat model/)
    assert.strictEqual(policyRefusal({ ...state, policy: { lockDefaults: true } }, "add", { ...personal, provider: "ollama" }), undefined)
    assert.strictEqual(policyRefusal(state, "add", { ...personal, provider: "twinny-remote" }), undefined, "another gateway may be added")
    assert.strictEqual(policyRefusal(state, "activate", providers[state.providerIds[0]], "chat"), undefined, "the team's own entries are always allowed")
    assert.strictEqual(policyRefusal(undefined, "add", personal), undefined)

    // The admin loosens the policy; the next VS Code start picks it up.
    team.policy = { lockDefaults: true }
    const refreshed = await service.refreshPolicy()
    assert.deepStrictEqual(refreshed?.policy, { lockDefaults: true })
    assert.strictEqual(policyRefusal(service.policy(), "add", personal), undefined)

    // The gateway is unreachable: what was agreed stays.
    refused = true
    assert.deepStrictEqual((await service.refreshPolicy())?.policy, { lockDefaults: true })
    refused = false

    // The admin removes the policy (or the licence lapses): released.
    delete team.policy
    assert.strictEqual(await service.refreshPolicy(), undefined)
    assert.strictEqual(service.policy(), undefined)

    // Reconnect with a policy, then leave: team entries, keys and policy all go.
    team.policy = { teamOnly: true }
    const again = await service.preview(input())
    await service.apply({ previewId: again.id, replaceExisting: true })
    assert.ok(service.policy())
    const mine = personal
    providers[mine.id] = mine
    const left = await service.leave()
    assert.strictEqual(left.removed, 3)
    assert.deepStrictEqual(Object.keys(providers), [mine.id])
    assert.strictEqual(tokens.size, 0)
    assert.strictEqual(service.policy(), undefined)
    assert.strictEqual(active.chat?.id, mine.id, "a remaining provider takes over the job")
    assert.strictEqual(active.fim, undefined)
    await assert.rejects(service.leave(), /not connected to a team/)
  })

  test("reconnecting with a blank key reuses the stored one, so no new sign-in is needed", async () => {
    const first = await service.preview(input())
    await service.apply({ previewId: first.id, replaceExisting: false })
    const blank = await service.preview({ url, token: "" })
    assert.strictEqual(blank.identity, "alice", "the stored key spoke for the developer")
    await service.apply({ previewId: blank.id, replaceExisting: true })
    assert.strictEqual(Object.keys(providers).length, 3, "same entries, not duplicates")
    assert.ok([...tokens.values()].every((value) => value === token))
    // Another gateway, or a machine without the key, still needs one.
    await assert.rejects(service.preview({ url: "http://127.0.0.1:1/other", token: "" }), /personal key/)
    tokens.clear()
    await assert.rejects(service.preview({ url, token: "" }), /personal key/)
  })

  test("a team that sets no policy still reports as connected and can be left", async () => {
    delete team.policy
    assert.strictEqual(await service.status(), undefined)
    const preview = await service.preview(input())
    await service.apply({ previewId: preview.id, replaceExisting: false })
    assert.strictEqual(service.policy(), undefined, "nothing stored without a policy")
    // A restart re-creates the service over the same stored providers and keys.
    const restarted = new TeamConnection(
      {
        getProviders: async () => providers,
        saveProviders: async (next) => {
          providers = next
        },
        getActive: (type) => active[type],
        setActive: async (type, provider) => {
          active[type] = provider
        }
      },
      { get: (id) => tokens.get(id), set: async (id, t) => void tokens.set(id, t), delete: async (id) => void tokens.delete(id) },
      memoryPolicyStorage()
    )
    const status = await restarted.status()
    assert.strictEqual(status?.url, url)
    assert.deepStrictEqual(status?.policy, {})
    assert.strictEqual(status?.providerIds.length, 3)
    assert.strictEqual(status?.keyMissing, undefined)
    // The key gone from secret storage is reported, not hidden.
    const saved = new Map(tokens)
    tokens.clear()
    assert.strictEqual((await restarted.status())?.keyMissing, true)
    for (const [id, t] of saved) tokens.set(id, t)
    const left = await restarted.leave()
    assert.strictEqual(left.removed, 3)
    assert.deepStrictEqual(providers, {})
    assert.strictEqual(tokens.size, 0)
    assert.strictEqual(await restarted.status(), undefined)
    await assert.rejects(restarted.leave(), /not connected to a team/)
  })

  test("a team connected before the policy existed picks it up on refresh", async () => {
    delete team.policy
    const preview = await service.preview(input())
    await service.apply({ previewId: preview.id, replaceExisting: false })
    assert.strictEqual(service.policy(), undefined)
    assert.strictEqual(await service.refreshPolicy(), undefined, "no policy, nothing stored")
    team.policy = { teamOnly: true }
    const found = await service.refreshPolicy()
    assert.deepStrictEqual(found?.policy, { teamOnly: true })
    assert.strictEqual(found?.url, url)
    assert.strictEqual(found?.providerIds.length, 3)
    assert.ok(found?.providerIds.every((id) => providers[id]))
    assert.deepStrictEqual(service.policy(), found)
  })

  test("a gateway without a policy clears one previously accepted for the same URL", async () => {
    team.policy = { lockDefaults: true }
    const first = await service.preview(input())
    await service.apply({ previewId: first.id, replaceExisting: false })
    assert.ok(service.policy())
    delete team.policy
    const second = await service.preview(input())
    assert.strictEqual(second.policy, undefined)
    await service.apply({ previewId: second.id, replaceExisting: true })
    assert.strictEqual(service.policy(), undefined)
  })

  test("URLs and advertised defaults reject unsafe or incompatible input", () => {
    for (const value of [
      "file:///etc/passwd",
      "https://user:secret@host",
      "https://host/?key=x",
      "https://host/#key",
      "https://host/admin",
      "https://host/twinny/v1",
      "not-a-url"
    ])
      assert.throws(() => teamUrl(value))
    assert.strictEqual(teamUrl("https://host/base/").href, "https://host/base")
    assert.throws(
      () => parseTeam({ ...team, defaults: { fim: "embed" } }),
      /invalid team default/
    )
    assert.throws(
      () => parseTeam({ ...team, protocol: 999 }),
      /compatible team defaults/
    )
    assert.throws(
      () => parseTeam({ ...team, defaults: { chat: "unknown" } }),
      /invalid team default/
    )
  })
})

/**
 * The Shared context plugin: a repository on disk is cloned, chunked and
 * embedded through the gateway's embeddings alias, a second sync embeds
 * only what changed, and search returns the chunk that matches with a
 * gateway key and refuses without one.
 */
import * as assert from "assert"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { createGatewayLog } from "../../gateway/log"
import { chunkLines, ContextPlugin } from "../../gateway/plugins/context"
import type { PluginContext } from "../../gateway/plugins/host"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-context-test-"))

/** A deterministic "embedding": letter frequencies, so similar text lands nearby. */
const embed = (text: string): number[] => {
  const vector = new Array<number>(26).fill(0)
  for (const ch of text.toLowerCase()) {
    const i = ch.charCodeAt(0) - 97
    if (i >= 0 && i < 26) vector[i]++
  }
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1
  return vector.map((v) => v / norm)
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString()

const req = (method: string, route: string, body: Record<string, unknown> = {}) => ({ method, path: route, query: new URLSearchParams(), body: async () => body, principal: "op" })

suite("Shared context plugin", function () {
  this.timeout(60_000)

  test("chunks are line windows cut at blank lines with overlap", () => {
    const lines: string[] = []
    for (let i = 1; i <= 130; i++) lines.push(i % 45 === 0 ? "" : `line ${i}`)
    const chunks = chunkLines(lines.join("\n"))
    assert.ok(chunks.length >= 3)
    assert.strictEqual(chunks[0].startLine, 1)
    assert.ok(chunks[0].endLine <= 60)
    assert.ok(chunks[1].startLine < chunks[0].endLine, "windows overlap")
    assert.strictEqual(chunks[chunks.length - 1].endLine, 130)
    assert.deepStrictEqual(chunkLines("  \n\n"), [])
  })

  test("clones, indexes, re-embeds only changed files, searches with a key, and cleans up on remove", async () => {
    // The "remote": a repository on disk.
    const remote = path.join(scratch, "remote")
    fs.mkdirSync(path.join(remote, "src"), { recursive: true })
    git(remote, "init", "-q", "-b", "main")
    fs.writeFileSync(path.join(remote, "src", "licence.ts"), "export const verifyLicenceToken = (token: string) => {\n  // checks the signature against the trusted keys\n  return token.startsWith(\"twl1.\")\n}\n")
    fs.writeFileSync(path.join(remote, "src", "quota.ts"), "export const dailyQuota = 500\nexport const resetsAtMidnight = true\n")
    fs.writeFileSync(path.join(remote, "README.md"), "# Widgets\n\nHow the gateway checks licences and quotas.\n")
    fs.writeFileSync(path.join(remote, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]))
    git(remote, "add", ".")
    git(remote, "commit", "-q", "-m", "first")

    const embedded: string[][] = []
    const inference = {
      chatAliases: () => [],
      embeddingAliases: () => ["embed"],
      active: () => 0,
      embed: async (_alias: string, inputs: string[]) => {
        embedded.push(inputs)
        return inputs.map(embed)
      },
      async *chat() {
        yield ""
      }
    }
    const dir = path.join(scratch, "plugin")
    fs.mkdirSync(dir, { recursive: true })
    const context: PluginContext = { dataDir: dir, log: createGatewayLog(() => undefined), fetch, now: Date.now, inference }
    const plugin = new ContextPlugin(context, 0)
    plugin.start()

    const added = await plugin.handle(req("POST", "repos", { url: remote, name: "acme/widgets", wait: true }))
    assert.strictEqual(added.status, 201, JSON.stringify(added.body))
    const repo = (added.body as { repo: { id: string; index: { files: number; chunks: number; alias: string; commit: string }; tokenSet: boolean } }).repo
    assert.strictEqual(repo.index.files, 3, "the png is skipped")
    assert.strictEqual(repo.index.chunks, 3)
    assert.strictEqual(repo.index.alias, "embed")
    assert.match(repo.index.commit, /^[0-9a-f]{40}$/)
    assert.strictEqual(repo.tokenSet, false)
    assert.strictEqual(embedded.flat().length, 3)
    assert.ok(fs.existsSync(path.join(dir, "repos", repo.id, "index", "vectors.bin")))

    // Search: the licence chunk comes first for a licence question; the key is required on the public route.
    const found = await plugin.handlePublic({ method: "POST", path: "search", query: new URLSearchParams(), headers: {}, address: "127.0.0.1", body: async () => ({ query: "verify the licence token signature" }), principal: "alice" })
    assert.strictEqual(found.status, 200)
    const hits = (found.body as { hits: Array<{ repo: string; path: string; startLine: number; text: string; score: number }> }).hits
    assert.strictEqual(hits[0].repo, "acme/widgets")
    assert.strictEqual(hits[0].path, "src/licence.ts")
    assert.strictEqual(hits[0].startLine, 1)
    assert.match(hits[0].text, /verifyLicenceToken/)
    const anonymous = await plugin.handlePublic({ method: "POST", path: "search", query: new URLSearchParams(), headers: {}, address: "127.0.0.1", body: async () => ({ query: "x" }) })
    assert.strictEqual(anonymous.status, 401)

    // A change to one file: only that file is embedded again; the commit moves.
    embedded.length = 0
    fs.writeFileSync(path.join(remote, "src", "quota.ts"), "export const dailyQuota = 1000\n")
    git(remote, "commit", "-qam", "raise quota")
    const synced = await plugin.handle(req("POST", `repos/${repo.id}/sync`, { wait: true }))
    const after = (synced.body as { repo: { index: { commit: string; chunks: number }; error?: string } }).repo
    assert.strictEqual(after.error, undefined)
    assert.notStrictEqual(after.index.commit, repo.index.commit)
    assert.strictEqual(embedded.flat().length, 1, "only the changed file was embedded")
    assert.match(embedded[0][0], /dailyQuota = 1000/)
    // The index survives a restart.
    const again = new ContextPlugin(context, 0)
    const reloaded = await again.handle(req("GET", ""))
    assert.strictEqual((reloaded.body as { repos: Array<{ index: { chunks: number } }> }).repos[0].index.chunks, after.index.chunks)

    const removed = await plugin.handle(req("DELETE", `repos/${repo.id}`))
    assert.strictEqual(removed.status, 200)
    assert.ok(!fs.existsSync(path.join(dir, "repos", repo.id)))
    await plugin.stop()
    await again.stop()
  })

  test("a bad clone URL is reported on the repository, not thrown at the page", async () => {
    const dir = path.join(scratch, "bad")
    fs.mkdirSync(dir, { recursive: true })
    const plugin = new ContextPlugin({ dataDir: dir, log: createGatewayLog(() => undefined), fetch, now: Date.now, inference: { chatAliases: () => [], embeddingAliases: () => ["embed"], active: () => 0, embed: async (_a: string, i: string[]) => i.map(embed), async *chat() { yield "" } } }, 0)
    const added = await plugin.handle(req("POST", "repos", { url: path.join(scratch, "nowhere"), wait: true }))
    assert.strictEqual(added.status, 502)
    assert.match((added.body as { repo: { error: string } }).repo.error, /git clone failed/)
    const refused = await plugin.handle(req("POST", "repos", { url: "not a url" })).catch((e: Error) => e)
    assert.ok(refused instanceof Error && /clone URL/.test(refused.message))
    await plugin.stop()
  })
})

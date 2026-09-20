/**
 * The Backups plugin: the archive format round-trips and refuses damage,
 * encryption needs the passphrase, the S3 client signs and speaks enough
 * S3 for a fake bucket, the plugin backs up to a directory on schedule
 * and prunes, and the CLI restores with the server stopped.
 */
import * as assert from "assert"
import * as fs from "fs"
import * as http from "http"
import * as os from "os"
import * as path from "path"
import { gunzipSync, gzipSync } from "zlib"

import { runBackup } from "../../gateway/backup-cli"
import { createGatewayLog } from "../../gateway/log"
import { BackupsPlugin, pathDestination, readBackupSettings, writeBackupSettings } from "../../gateway/plugins/backups"
import { buildArchive, collectFiles, openArchive, planRestore, restoreArchive } from "../../gateway/plugins/backups/archive"
import { decryptArchive, encryptArchive, isEncryptedArchive } from "../../gateway/plugins/backups/crypto"
import { S3Client } from "../../gateway/plugins/backups/s3"
import { packTar, unpackTar } from "../../gateway/plugins/backups/tar"
import type { GatewayPaths, PluginContext } from "../../gateway/plugins/host"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-backups-test-"))

/** A gateway's files as they would be on disk: config outside, usage inside the data directory. */
const layout = (name: string): GatewayPaths => {
  const root = path.join(scratch, name)
  const dataDir = path.join(root, "data")
  const paths: GatewayPaths = {
    configFile: path.join(root, "twinny.gateway.json"),
    dataDir,
    keysFile: path.join(dataDir, "keys.json"),
    licenseFile: path.join(dataDir, "license"),
    usageDir: path.join(dataDir, "usage"),
    recordingsDir: path.join(dataDir, "recordings")
  }
  fs.mkdirSync(path.join(dataDir, "usage"), { recursive: true })
  fs.mkdirSync(path.join(dataDir, "recordings"), { recursive: true })
  fs.mkdirSync(path.join(dataDir, "plugins", "github"), { recursive: true })
  fs.mkdirSync(path.join(dataDir, "plugins", "backups"), { recursive: true })
  fs.writeFileSync(paths.configFile as string, "{\"listen\":{\"port\":8765}}\n")
  fs.writeFileSync(paths.keysFile, "{\"version\":1,\"keys\":[]}\n", { mode: 0o600 })
  fs.writeFileSync(paths.licenseFile, "twl1.token\n")
  fs.writeFileSync(path.join(dataDir, "plugins.json"), "{\"version\":1,\"enabled\":[\"github\"]}\n")
  fs.writeFileSync(path.join(dataDir, "plugins", "github", "repos.json"), "{\"version\":1,\"repos\":[],\"settings\":{}}\n")
  fs.writeFileSync(path.join(dataDir, "plugins", "backups", "settings.json"), "{\"destination\":\"path\"}\n")
  fs.writeFileSync(path.join(dataDir, "plugins", "backups", "twinny-backup-20260101-000000.tar.gz"), "old archive kept locally")
  fs.writeFileSync(path.join(dataDir, "usage", "2026-09-20.jsonl"), "{\"ts\":\"x\"}\n")
  fs.writeFileSync(path.join(dataDir, "recordings", "chat.jsonl"), "{\"secret\":\"content\"}\n")
  fs.writeFileSync(path.join(dataDir, "keys.json.123.tmp"), "half written")
  return paths
}

suite("Backup archive format", () => {
  test("tar round-trips names, modes and bytes, including long paths", () => {
    const long = `${"deep/".repeat(30)}file.txt`
    const entries = [
      { name: "a.txt", data: Buffer.from("hello"), mode: 0o600, mtimeMs: 1_700_000_000_000 },
      { name: long, data: Buffer.alloc(1000, 7), mode: 0o644, mtimeMs: 1_700_000_000_000 },
      { name: "empty", data: Buffer.alloc(0), mode: 0o600, mtimeMs: 0 }
    ]
    const tar = packTar(entries)
    assert.strictEqual(tar.length % 512, 0)
    const back = unpackTar(tar)
    assert.deepStrictEqual(back.map((e) => [e.name, e.data.length, e.mode]), entries.map((e) => [e.name, e.data.length, e.mode]))
    assert.ok(back[1].data.equals(entries[1].data))
  })

  test("encryption needs the passphrase and notices tampering", () => {
    const plain = Buffer.from("keys and tokens")
    const sealed = encryptArchive(plain, "correct horse battery")
    assert.ok(isEncryptedArchive(sealed))
    assert.ok(!sealed.includes("keys and tokens"))
    assert.ok(decryptArchive(sealed, "correct horse battery").equals(plain))
    assert.throws(() => decryptArchive(sealed, "wrong"), /passphrase is wrong/)
    const tampered = Buffer.from(sealed)
    tampered[tampered.length - 1] ^= 0xff
    assert.throws(() => decryptArchive(tampered, "correct horse battery"), /wrong, or the backup is damaged/)
  })

  test("an archive carries the configuration, data, usage and (only when asked) recordings, and skips its own archives and temp files", () => {
    const paths = layout("collect")
    const names = collectFiles(paths, false).map((entry) => entry.name)
    assert.deepStrictEqual(names, [
      "config/twinny.gateway.json",
      "data/keys.json",
      "data/license",
      "data/plugins.json",
      "data/plugins/backups/settings.json",
      "data/plugins/github/repos.json",
      "usage/2026-09-20.jsonl"
    ])
    assert.ok(collectFiles(paths, true).some((entry) => entry.name === "recordings/chat.jsonl"))

    const built = buildArchive(paths, { includeRecordings: false, now: () => Date.parse("2026-09-20T03:15:00Z") })
    assert.strictEqual(built.name, "twinny-backup-20260920-031500.tar.gz")
    assert.strictEqual(built.encrypted, false)
    assert.strictEqual(built.manifest.files.length, 7)
    // Readable by any tar: gzip, then ustar with a manifest first.
    const entries = unpackTar(gunzipSync(built.data as Uint8Array))
    assert.strictEqual(entries[0].name, "manifest.json")

    const opened = openArchive(built.data)
    assert.strictEqual(opened.manifest.createdAt, "2026-09-20T03:15:00.000Z")
    assert.strictEqual(opened.entries.length, 7)

    // A flipped byte inside is caught by the manifest's hashes.
    const damaged = gunzipSync(built.data as Uint8Array)
    const at = damaged.indexOf("twl1.token")
    damaged[at] = "X".charCodeAt(0)
    assert.throws(() => openArchive(gzipSync(damaged as Uint8Array)), /does not match its manifest/)
    assert.throws(() => openArchive(Buffer.from("nope")), /not gzip/)
  })

  test("an encrypted archive restores into another layout, config included when the target names one", () => {
    const from = layout("restore-from")
    const built = buildArchive(from, { includeRecordings: false, passphrase: "twelve characters" })
    assert.ok(built.name.endsWith(".tar.gz.enc"))
    assert.throws(() => openArchive(built.data), /encrypted; the passphrase is needed/)

    const to = layout("restore-to")
    fs.writeFileSync(to.keysFile, "{\"version\":1,\"keys\":[{\"id\":\"newer\"}]}\n")
    fs.writeFileSync(path.join(to.usageDir, "2026-09-21.jsonl"), "kept\n")
    const opened = openArchive(built.data, "twelve characters")
    const plan = planRestore(opened, to)
    assert.strictEqual(plan.skipped.length, 0)
    assert.ok(plan.writes.find((write) => write.to === to.keysFile)?.exists)
    const written = restoreArchive(opened, to)
    assert.strictEqual(written.length, 7)
    assert.strictEqual(fs.readFileSync(to.keysFile, "utf8"), "{\"version\":1,\"keys\":[]}\n")
    assert.strictEqual(fs.readFileSync(to.configFile as string, "utf8"), "{\"listen\":{\"port\":8765}}\n")
    assert.strictEqual(fs.readFileSync(path.join(to.usageDir, "2026-09-21.jsonl"), "utf8"), "kept\n", "files not in the backup are left alone")
    assert.strictEqual(fs.statSync(to.keysFile).mode & 0o777, 0o600)

    // Without a config path, the configuration entry has nowhere to go and is reported.
    const { configFile: _ignored, ...noConfig } = to
    void _ignored
    assert.deepStrictEqual(planRestore(opened, noConfig).skipped, ["config/twinny.gateway.json"])
  })
})

/* -------------------------------------------------------------------------- */
/*  A stand-in S3 bucket that checks the signature's shape                    */
/* -------------------------------------------------------------------------- */

const fakeS3 = async (): Promise<{ url: string; objects: Map<string, Buffer>; auths: string[]; close: () => void }> => {
  const objects = new Map<string, Buffer>()
  const auths: string[] = []
  const server = http.createServer(async (req, res) => {
    auths.push(req.headers.authorization ?? "")
    const url = new URL(req.url ?? "/", "http://fake")
    if (!/^AWS4-HMAC-SHA256 Credential=AKIA\/\d{8}\/eu-test-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/.test(req.headers.authorization ?? "")) {
      res.writeHead(403)
      return res.end("<Error><Code>SignatureDoesNotMatch</Code><Message>bad</Message></Error>")
    }
    // Path style: /bucket/key
    const [, bucket, ...rest] = url.pathname.split("/")
    const key = decodeURIComponent(rest.join("/"))
    if (bucket !== "backups") {
      res.writeHead(404)
      return res.end("<Error><Code>NoSuchBucket</Code></Error>")
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      objects.set(key, Buffer.concat(chunks as Uint8Array[]))
      res.writeHead(200)
      return res.end()
    }
    if (req.method === "GET" && key === "" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? ""
      const listed = [...objects.entries()].filter(([k]) => k.startsWith(prefix))
      res.writeHead(200, { "Content-Type": "application/xml" })
      return res.end(
        `<ListBucketResult><IsTruncated>false</IsTruncated>${listed
          .map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size><LastModified>2026-09-20T00:00:00.000Z</LastModified></Contents>`)
          .join("")}</ListBucketResult>`
      )
    }
    if (req.method === "GET") {
      const object = objects.get(key)
      if (!object) {
        res.writeHead(404)
        return res.end("<Error><Code>NoSuchKey</Code><Message>gone</Message></Error>")
      }
      res.writeHead(200)
      return res.end(object)
    }
    if (req.method === "DELETE") {
      objects.delete(key)
      res.writeHead(204)
      return res.end()
    }
    res.writeHead(400)
    res.end()
    return undefined
  })
  const url = await new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)))
  return { url, objects, auths, close: () => server.close() }
}

suite("Backup S3 client", function () {
  this.timeout(20_000)

  test("puts, lists under the prefix, gets and deletes with a SigV4 signature", async () => {
    const bucket = await fakeS3()
    try {
      const client = new S3Client({ endpoint: bucket.url, region: "eu-test-1", bucket: "backups", prefix: "twinny/", accessKeyId: "AKIA", secretAccessKey: "secret", forcePathStyle: true })
      await client.put("twinny-backup-20260920-031500.tar.gz", Buffer.from("one"))
      await client.put("twinny-backup-20260921-031500.tar.gz", Buffer.from("two!"))
      assert.ok(bucket.objects.has("twinny/twinny-backup-20260920-031500.tar.gz"))
      const listed = await client.list()
      assert.deepStrictEqual(listed.map((o) => `${o.key}:${o.size}`), ["twinny-backup-20260920-031500.tar.gz:3", "twinny-backup-20260921-031500.tar.gz:4"])
      assert.strictEqual((await client.get("twinny-backup-20260921-031500.tar.gz")).toString(), "two!")
      await client.delete("twinny-backup-20260920-031500.tar.gz")
      assert.strictEqual((await client.list()).length, 1)
      await assert.rejects(client.get("missing"), /Downloading missing: 404 NoSuchKey \(gone\)/)

      const wrong = new S3Client({ endpoint: bucket.url, region: "eu-test-1", bucket: "nope", prefix: "", accessKeyId: "AKIA", secretAccessKey: "secret", forcePathStyle: true })
      await assert.rejects(wrong.list(), /Listing the bucket: 404 NoSuchBucket/)
    } finally {
      bucket.close()
    }
  })
})

/* -------------------------------------------------------------------------- */
/*  The plugin and the CLI                                                    */
/* -------------------------------------------------------------------------- */

const context = (paths: GatewayPaths, now: () => number): PluginContext => ({
  dataDir: path.join(paths.dataDir, "plugins", "backups"),
  log: createGatewayLog(() => undefined),
  fetch,
  now,
  paths
})
const req = (method: string, route: string, body: Record<string, unknown> = {}) => ({ method, path: route, query: new URLSearchParams(), body: async () => body, principal: "op" })

suite("Backups plugin", function () {
  this.timeout(20_000)

  test("backs up to a directory now and nightly, keeps N, and never shows its secrets", async () => {
    const paths = layout("plugin")
    let clock = Date.parse("2026-09-20T02:00:00")
    const plugin = new BackupsPlugin(context(paths, () => clock), 0)
    const dest = path.join(scratch, "plugin-dest")

    const unset = await plugin.handle(req("GET", ""))
    assert.strictEqual((unset.body as { configured: boolean }).configured, false)
    await assert.rejects(plugin.handle(req("POST", "run")).then((r) => Promise.reject(new Error(JSON.stringify(r.body)))), /Give the backups a directory/)

    const saved = await plugin.handle(req("PUT", "settings", { path: dest, keep: 2, hour: 3, minute: 0, passphrase: "a long passphrase", s3: { accessKeyId: "AKIA", secretAccessKey: "hidden" } }))
    const view = (saved.body as { settings: { passphraseSet: boolean; s3?: { secretAccessKeySet: boolean } } }).settings
    assert.strictEqual(view.passphraseSet, true)
    assert.strictEqual(view.s3?.secretAccessKeySet, true)
    assert.ok(!JSON.stringify(saved.body).includes("a long passphrase"))
    assert.ok(!JSON.stringify(saved.body).includes("hidden"))
    assert.strictEqual(fs.statSync(path.join(paths.dataDir, "plugins", "backups", "settings.json")).mode & 0o777, 0o600)
    assert.strictEqual(readBackupSettings(path.join(paths.dataDir, "plugins", "backups", "settings.json")).passphrase, "a long passphrase")

    const ran = await plugin.handle(req("POST", "run"))
    assert.strictEqual(ran.status, 200, JSON.stringify(ran.body))
    const run = (ran.body as { run: { ok: boolean; name: string; files: number } }).run
    assert.strictEqual(run.ok, true)
    assert.match(run.name, /\.tar\.gz\.enc$/)
    assert.strictEqual(run.files, 7)
    assert.ok(fs.existsSync(path.join(dest, run.name)))

    // Not yet 03:00: the schedule waits. Then it fires once for the day.
    await plugin.tick()
    assert.strictEqual(fs.readdirSync(dest).length, 1)
    clock = Date.parse("2026-09-20T03:00:30")
    await plugin.tick()
    assert.strictEqual(fs.readdirSync(dest).length, 2)
    await plugin.tick()
    assert.strictEqual(fs.readdirSync(dest).length, 2, "once a day")
    // Next day: a third, and the oldest is pruned to keep two.
    clock = Date.parse("2026-09-21T03:00:30")
    await plugin.tick()
    const kept = fs.readdirSync(dest).sort()
    assert.strictEqual(kept.length, 2)
    assert.ok(!kept.includes(run.name), "the oldest went")

    const overview = (await plugin.handle(req("GET", ""))).body as { archives: Array<{ name: string; encrypted: boolean }>; nextRunAt: string; lastRun: { requestedBy: string } }
    assert.deepStrictEqual(overview.archives.map((a) => a.name), kept)
    assert.strictEqual(overview.archives[0].encrypted, true)
    assert.strictEqual(overview.lastRun.requestedBy, "schedule")
    assert.ok(overview.nextRunAt.startsWith("2026-09-22T"))

    const deleted = await plugin.handle(req("DELETE", `archives/${kept[0]}`))
    assert.strictEqual(deleted.status, 200)
    assert.strictEqual(fs.readdirSync(dest).length, 1)
    await plugin.stop()
  })

  test("the CLI backs up, lists and restores with --yes, using the plugin's settings", async () => {
    const paths = layout("cli")
    const dest = path.join(scratch, "cli-dest")
    writeBackupSettings(path.join(paths.dataDir, "plugins", "backups", "settings.json"), { destination: "path", path: dest, hour: 3, minute: 0, keep: 5, includeRecordings: false, schedule: true, passphrase: "cli passphrase!" })
    // A real configuration file, since the CLI reads it for the paths.
    fs.writeFileSync(
      paths.configFile as string,
      JSON.stringify({
        listen: { host: "127.0.0.1", port: 0 },
        auth: { tokenEnv: null, keysFile: paths.keysFile, licenseFile: paths.licenseFile },
        usage: { dir: paths.usageDir },
        recording: { dir: paths.recordingsDir },
        providers: { local: { provider: "ollama", apiHostname: "127.0.0.1", apiPort: 1 } },
        models: [{ alias: "coder", provider: "local", model: "x", capabilities: ["chat"] }]
      })
    )
    const lines: string[] = []
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(`ERR ${line}`), env: {} as NodeJS.ProcessEnv }
    assert.strictEqual(await runBackup(["now", "--config", paths.configFile as string], io), 0)
    assert.match(lines[0], /Backed up 7 files \(.* encrypted\) as twinny-backup-.*\.enc to /)
    assert.strictEqual(await runBackup(["list", "--config", paths.configFile as string], io), 0)
    assert.match(lines[lines.length - 1], /twinny-backup-.*encrypted/)
    const archive = (await pathDestination(dest).list())[0].name

    // Something goes wrong; restore shows the plan, then does it with --yes.
    fs.writeFileSync(paths.keysFile, "corrupted")
    lines.length = 0
    assert.strictEqual(await runBackup(["restore", archive, "--config", paths.configFile as string], io), 0)
    assert.ok(lines.some((line) => line.includes("overwrite") && line.includes(paths.keysFile)))
    assert.ok(lines.some((line) => line.includes("Nothing written")))
    assert.strictEqual(fs.readFileSync(paths.keysFile, "utf8"), "corrupted")
    assert.strictEqual(await runBackup(["restore", archive, "--config", paths.configFile as string, "--yes"], io), 0)
    assert.strictEqual(fs.readFileSync(paths.keysFile, "utf8"), "{\"version\":1,\"keys\":[]}\n")

    // On another machine, the passphrase comes from the environment.
    fs.writeFileSync(paths.keysFile, "corrupted again")
    fs.unlinkSync(path.join(paths.dataDir, "plugins", "backups", "settings.json"))
    lines.length = 0
    assert.strictEqual(await runBackup(["restore", path.join(dest, archive), "--config", paths.configFile as string, "--yes"], io), 1)
    assert.match(lines[lines.length - 1], /encrypted; the passphrase is needed/)
    io.env = { TWINNY_BACKUP_PASSPHRASE: "cli passphrase!" }
    assert.strictEqual(await runBackup(["restore", path.join(dest, archive), "--config", paths.configFile as string, "--yes"], io), 0)
    assert.strictEqual(fs.readFileSync(paths.keysFile, "utf8"), "{\"version\":1,\"keys\":[]}\n")
  })
})

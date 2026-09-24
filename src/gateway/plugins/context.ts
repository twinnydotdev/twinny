/**
 * The Shared context plugin: one index of the team's repositories on the
 * gateway, built with an embeddings alias the gateway serves, so every
 * developer's chat can pull in code from the whole codebase instead of
 * only what their laptop has cloned and indexed.
 *
 *   admin  POST api/repos { url, name?, branch?, token? }   clone (shallow) and index
 *   admin  POST api/repos/<id>/sync                        fetch, re-index what changed
 *   admin  PUT  api/settings { alias?, intervalMinutes? }
 *   dev    POST /twinny/v1/plugins/context/search { query, k?, repos? }   with a gateway key
 *
 * Files are chunked by lines (a window with overlap, cut at blank lines),
 * embedded in batches, and kept per repository as chunks.json plus a
 * Float32 vectors.bin; only files whose content hash changed are
 * re-embedded on a sync. Search is cosine similarity over every vector
 * plus a small bonus for query words present in the chunk, capped by a
 * character budget so the answer fits a prompt.
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { isRecord } from "../../common/guards"
import { isIndexablePath, looksBinary } from "../../extension/embeddings/indexable"
import { writePrivateJson } from "../private-file"

import {
  GatewayPlugin,
  json,
  notFound,
  PluginContext,
  PluginError,
  PluginInstance,
  PluginRequest,
  PluginResponse,
  PublicPluginRequest
} from "./host"
import { repoWorkspace } from "./inference"

const CHUNK_LINES = 60
const CHUNK_OVERLAP = 10
const MAX_FILE_BYTES = 256 * 1024
const MAX_FILES = 20_000
const MAX_CHUNKS = 60_000
const EMBED_BATCH = 32
const DEFAULT_INTERVAL_MINUTES = 60
const MAX_REPOS = 50
const SEARCH_BUDGET_CHARS = 24_000
const MAX_HITS = 12
const GIT_TIMEOUT_MS = 10 * 60_000

export interface ContextRepo {
  id: string
  name: string
  url: string
  branch?: string
  /** `user:token` or a token alone (`x-access-token` is assumed); only for https clones. */
  token?: string
  addedAt: string
  addedBy: string
}

export interface ContextSettings {
  alias?: string
  intervalMinutes: number
  repos: ContextRepo[]
}

export interface RepoIndexState {
  files: number
  chunks: number
  dims: number
  alias: string
  /** The commit indexed. */
  commit?: string
  updatedAt?: string
}

/** Where a sync is, for the page: the phase and, while embedding, how many chunks of how many. */
export interface SyncProgress {
  phase: "cloning" | "fetching" | "scanning" | "embedding" | "saving"
  done: number
  total: number
  startedAt: string
}

export interface ContextRepoView extends Omit<ContextRepo, "token"> {
  tokenSet: boolean
  syncing: boolean
  progress?: SyncProgress
  lastSyncAt?: string
  error?: string
  index?: RepoIndexState
}

export interface ContextHit {
  repo: string
  path: string
  startLine: number
  endLine: number
  text: string
  score: number
}

interface ChunkRecord {
  path: string
  startLine: number
  endLine: number
  text: string
  fileHash: string
}

interface Manifest extends RepoIndexState {
  /** path → content hash. */
  fileHashes: Record<string, string>
}

const sha1 = (data: Buffer | string): string => createHash("sha1").update(data as Uint8Array | string).digest("hex")

/** Windows of lines with overlap, cut at the nearest blank line so functions are not split mid-way where it can be helped. */
export const chunkLines = (content: string): Array<{ startLine: number; endLine: number; text: string }> => {
  const lines = content.split("\n")
  const out: Array<{ startLine: number; endLine: number; text: string }> = []
  let start = 0
  while (start < lines.length) {
    let end = Math.min(lines.length, start + CHUNK_LINES)
    if (end < lines.length) {
      // Pull the cut back to a blank line within the last quarter of the window.
      for (let i = end; i > start + Math.floor(CHUNK_LINES * 0.75); i--) {
        if (lines[i - 1].trim() === "") {
          end = i
          break
        }
      }
    }
    const text = lines.slice(start, end).join("\n")
    if (text.trim()) out.push({ startLine: start + 1, endLine: end, text })
    if (end >= lines.length) break
    start = Math.max(end - CHUNK_OVERLAP, start + 1)
  }
  return out
}

const words = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length > 2)
  )

const cosine = (a: Float32Array, b: Float32Array, offsetB: number, dims: number): number => {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < dims; i++) {
    const x = a[i]
    const y = b[offsetB + i]
    dot += x * y
    na += x * x
    nb += y * y
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/** Runs git with no prompts and no credential helpers; the token, if any, rides in a header that is never logged. */
const git = (args: string[], cwd: string, token?: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const auth = token ? (token.includes(":") ? token : `x-access-token:${token}`) : undefined
    const full = [
      "-c",
      "credential.helper=",
      ...(auth ? ["-c", `http.extraheader=Authorization: Basic ${Buffer.from(auth, "utf8").toString("base64")}`] : []),
      ...args
    ]
    const child = spawn("git", full, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" }, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let err = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS)
    child.stdout.on("data", (d: Buffer) => (out += d.toString()))
    child.stderr.on("data", (d: Buffer) => (err += d.toString()))
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(new Error(`git could not run: ${error.message}`))
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`git ${args[0]} failed: ${err.trim().split("\n").slice(-2).join(" ").replace(/Basic [A-Za-z0-9+/=]+/g, "Basic …") || `exit ${code}`}`))
    })
  })

interface LoadedIndex {
  chunks: ChunkRecord[]
  vectors: Float32Array
  manifest: Manifest
}

export class ContextPlugin implements PluginInstance {
  private _settings: ContextSettings
  private readonly _file: string
  private readonly _indexes = new Map<string, LoadedIndex>()
  private readonly _state = new Map<string, { syncing: boolean; lastSyncAt?: string; error?: string; progress?: SyncProgress }>()
  private _timer: NodeJS.Timeout | undefined
  private _syncing: Promise<void> | undefined
  private readonly _stopped = new AbortController()

  constructor(
    private readonly _context: PluginContext,
    private readonly _tickMs = 60_000
  ) {
    this._file = path.join(_context.dataDir, "settings.json")
    this._settings = this.read()
    for (const repo of this._settings.repos) this.load(repo.id)
  }

  private read(): ContextSettings {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this._file, "utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { intervalMinutes: DEFAULT_INTERVAL_MINUTES, repos: [] }
      throw error
    }
    if (!isRecord(parsed)) return { intervalMinutes: DEFAULT_INTERVAL_MINUTES, repos: [] }
    return {
      ...(typeof parsed.alias === "string" && parsed.alias ? { alias: parsed.alias } : {}),
      intervalMinutes: typeof parsed.intervalMinutes === "number" ? parsed.intervalMinutes : DEFAULT_INTERVAL_MINUTES,
      repos: (Array.isArray(parsed.repos) ? parsed.repos : []).flatMap((entry) =>
        isRecord(entry) && typeof entry.id === "string" && typeof entry.url === "string" && typeof entry.name === "string"
          ? [
              {
                id: entry.id,
                name: entry.name,
                url: entry.url,
                ...(typeof entry.branch === "string" && entry.branch ? { branch: entry.branch } : {}),
                ...(typeof entry.token === "string" && entry.token ? { token: entry.token } : {}),
                addedAt: typeof entry.addedAt === "string" ? entry.addedAt : "",
                addedBy: typeof entry.addedBy === "string" ? entry.addedBy : ""
              }
            ]
          : []
      )
    }
  }

  private save(): void {
    writePrivateJson(this._file, this._settings)
  }

  public start(): void {
    if (this._tickMs > 0) {
      this._timer = setInterval(() => void this.tick(), this._tickMs)
      this._timer.unref()
    }
  }

  public async stop(): Promise<void> {
    if (this._timer) clearInterval(this._timer)
    this._stopped.abort()
    await this._syncing?.catch(() => undefined)
  }

  public get alias(): string | undefined {
    const aliases = this._context.inference?.embeddingAliases() ?? []
    return this._settings.alias && aliases.includes(this._settings.alias) ? this._settings.alias : aliases[0]
  }

  private repoDir(id: string): string {
    return path.join(this._context.dataDir, "repos", id)
  }

  private load(id: string): LoadedIndex | undefined {
    const dir = path.join(this.repoDir(id), "index")
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest
      const chunks = JSON.parse(fs.readFileSync(path.join(dir, "chunks.json"), "utf8")) as ChunkRecord[]
      const raw = fs.readFileSync(path.join(dir, "vectors.bin"))
      const vectors = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
      const loaded = { manifest, chunks, vectors }
      this._indexes.set(id, loaded)
      return loaded
    } catch {
      return undefined
    }
  }

  private store(id: string, index: LoadedIndex): void {
    const dir = path.join(this.repoDir(id), "index")
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(index.manifest), { mode: 0o600 })
    fs.writeFileSync(path.join(dir, "chunks.json"), JSON.stringify(index.chunks), { mode: 0o600 })
    fs.writeFileSync(path.join(dir, "vectors.bin"), Buffer.from(index.vectors.buffer, index.vectors.byteOffset, index.vectors.byteLength), { mode: 0o600 })
    this._indexes.set(id, index)
  }

  /** A scheduled pass: one repository whose interval has passed, only while developers are idle. */
  public async tick(): Promise<void> {
    if (this._syncing || !this._context.inference || this._context.inference.active() > 0) return
    const now = this._context.now()
    const due = this._settings.repos.find((repo) => {
      const state = this._state.get(repo.id)
      if (state?.syncing) return false
      const last = state?.lastSyncAt ? Date.parse(state.lastSyncAt) : 0
      return now - last >= this._settings.intervalMinutes * 60_000
    })
    if (due) await this.sync(due).catch(() => undefined)
  }

  /** Clones or updates the checkout, then embeds what changed. Serialised; a second call waits for the first. */
  public sync(repo: ContextRepo): Promise<void> {
    if (this._syncing) return this._syncing.then(() => this.sync(repo))
    this._syncing = this.syncNow(repo).finally(() => {
      this._syncing = undefined
    })
    return this._syncing
  }

  private async syncNow(repo: ContextRepo): Promise<void> {
    const state = this._state.get(repo.id) ?? { syncing: false }
    state.syncing = true
    this._state.set(repo.id, state)
    const startedAt = new Date(this._context.now()).toISOString()
    const progress = (phase: SyncProgress["phase"], done = 0, total = 0) => {
      state.progress = { phase, done, total, startedAt }
    }
    try {
      const inference = this._context.inference
      const alias = this.alias
      if (!inference || !alias) throw new PluginError("No embeddings alias is served; add one under Providers & models.", 503)
      const checkout = path.join(this.repoDir(repo.id), "checkout")
      const branchArgs = repo.branch ? ["--branch", repo.branch] : []
      if (!fs.existsSync(path.join(checkout, ".git"))) {
        progress("cloning")
        fs.mkdirSync(path.dirname(checkout), { recursive: true, mode: 0o700 })
        await git(["clone", "--depth", "1", "--single-branch", ...branchArgs, repo.url, checkout], path.dirname(checkout), repo.token)
      } else {
        progress("fetching")
        await git(["fetch", "--depth", "1", "origin", ...(repo.branch ? [repo.branch] : [])], checkout, repo.token)
        await git(["reset", "--hard", "FETCH_HEAD"], checkout)
        await git(["clean", "-fdq"], checkout)
      }
      const commit = (await git(["rev-parse", "HEAD"], checkout)).trim()
      const previous = this._indexes.get(repo.id) ?? this.load(repo.id)
      const sameAlias = previous?.manifest.alias === alias
      const oldHashes = sameAlias ? previous?.manifest.fileHashes ?? {} : {}
      const oldChunksByFile = new Map<string, ChunkRecord[]>()
      const oldVectorByChunk = new Map<ChunkRecord, number>()
      if (previous && sameAlias) {
        previous.chunks.forEach((chunk, i) => {
          const list = oldChunksByFile.get(chunk.path) ?? []
          list.push(chunk)
          oldChunksByFile.set(chunk.path, list)
          oldVectorByChunk.set(chunk, i)
        })
      }
      // Walk the checkout.
      progress("scanning")
      const files: Array<{ path: string; hash: string; content?: string }> = []
      const walk = (dir: string) => {
        if (files.length >= MAX_FILES) return
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === ".git") continue
          const absolute = path.join(dir, entry.name)
          const relative = path.relative(checkout, absolute).split(path.sep).join("/")
          if (entry.isDirectory()) {
            if (!isIndexablePath(`${relative}/x.ts`)) continue
            walk(absolute)
          } else if (entry.isFile() && isIndexablePath(relative)) {
            const stat = fs.statSync(absolute)
            if (stat.size > MAX_FILE_BYTES || stat.size === 0) continue
            const buffer = fs.readFileSync(absolute)
            if (looksBinary(buffer)) continue
            files.push({ path: relative, hash: sha1(buffer), content: buffer.toString("utf8") })
            if (files.length >= MAX_FILES) return
          }
        }
      }
      walk(checkout)
      // Chunks: reused when the file did not change, embedded when it did.
      const chunks: ChunkRecord[] = []
      const reuse: Array<number | undefined> = []
      const toEmbed: number[] = []
      for (const file of files) {
        if (oldHashes[file.path] === file.hash) {
          for (const chunk of oldChunksByFile.get(file.path) ?? []) {
            chunks.push(chunk)
            reuse.push(oldVectorByChunk.get(chunk))
          }
          continue
        }
        for (const piece of chunkLines(file.content ?? "")) {
          if (chunks.length >= MAX_CHUNKS) break
          chunks.push({ path: file.path, startLine: piece.startLine, endLine: piece.endLine, text: piece.text, fileHash: file.hash })
          reuse.push(undefined)
          toEmbed.push(chunks.length - 1)
        }
      }
      let dims = previous?.manifest.dims ?? 0
      const fresh = new Map<number, number[]>()
      progress("embedding", 0, toEmbed.length)
      for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
        if (this._stopped.signal.aborted) throw new Error("The plugin stopped.")
        progress("embedding", i, toEmbed.length)
        const batch = toEmbed.slice(i, i + EMBED_BATCH)
        const vectors = await inference.embed(alias, batch.map((index) => `${chunks[index].path}\n${chunks[index].text}`), this._stopped.signal, repoWorkspace(repo.name))
        batch.forEach((index, j) => {
          const vector = vectors[j] ?? []
          if (!dims) dims = vector.length
          fresh.set(index, vector)
        })
      }
      if (!dims) dims = 1
      progress("saving", toEmbed.length, toEmbed.length)
      const vectors = new Float32Array(chunks.length * dims)
      chunks.forEach((_, index) => {
        const vector = fresh.get(index)
        if (vector) vectors.set(vector.slice(0, dims), index * dims)
        else if (previous && reuse[index] !== undefined) vectors.set(previous.vectors.subarray((reuse[index] as number) * dims, (reuse[index] as number) * dims + dims), index * dims)
      })
      const manifest: Manifest = {
        files: files.length,
        chunks: chunks.length,
        dims,
        alias,
        commit,
        updatedAt: new Date(this._context.now()).toISOString(),
        fileHashes: Object.fromEntries(files.map((file) => [file.path, file.hash]))
      }
      this.store(repo.id, { chunks, vectors, manifest })
      state.lastSyncAt = manifest.updatedAt
      delete state.error
      this._context.log.info({ event: "plugin.context-indexed", reason: repo.name, message: `${files.length} files, ${chunks.length} chunks, ${toEmbed.length} embedded` })
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
      state.lastSyncAt = new Date(this._context.now()).toISOString()
      this._context.log.warn({ event: "plugin.context-failed", reason: repo.name, message: state.error })
    } finally {
      state.syncing = false
      delete state.progress
    }
  }

  public async search(query: string, k = MAX_HITS, repoIds?: string[]): Promise<ContextHit[]> {
    const inference = this._context.inference
    const alias = this.alias
    if (!inference || !alias) throw new PluginError("No embeddings alias is served, so nothing can be searched.", 503)
    const trimmed = query.trim().slice(0, 2000)
    if (!trimmed) throw new PluginError("Say what to search for.", 400)
    const [vector] = await inference.embed(alias, [trimmed], this._stopped.signal)
    const queryVector = Float32Array.from(vector ?? [])
    const queryWords = words(trimmed)
    const scored: ContextHit[] = []
    for (const repo of this._settings.repos) {
      if (repoIds?.length && !repoIds.includes(repo.id) && !repoIds.includes(repo.name)) continue
      const index = this._indexes.get(repo.id)
      if (!index || index.manifest.alias !== alias || index.manifest.dims !== queryVector.length) continue
      const { dims } = index.manifest
      const top: ContextHit[] = []
      index.chunks.forEach((chunk, i) => {
        let score = cosine(queryVector, index.vectors, i * dims, dims)
        if (queryWords.size) {
          const present = words(`${chunk.path} ${chunk.text}`)
          let hits = 0
          for (const word of queryWords) if (present.has(word)) hits++
          score += 0.15 * (hits / queryWords.size)
        }
        if (top.length < k * 3 || score > top[top.length - 1].score) {
          top.push({ repo: repo.name, path: chunk.path, startLine: chunk.startLine, endLine: chunk.endLine, text: chunk.text, score })
          top.sort((a, b) => b.score - a.score)
          if (top.length > k * 3) top.pop()
        }
      })
      scored.push(...top)
    }
    scored.sort((a, b) => b.score - a.score)
    const out: ContextHit[] = []
    let budget = SEARCH_BUDGET_CHARS
    for (const hit of scored) {
      if (out.length >= k) break
      if (out.some((seen) => seen.repo === hit.repo && seen.path === hit.path && Math.abs(seen.startLine - hit.startLine) < CHUNK_LINES / 2)) continue
      if (hit.text.length > budget) continue
      budget -= hit.text.length
      out.push({ ...hit, score: Math.round(hit.score * 1000) / 1000 })
    }
    return out
  }

  private views(): ContextRepoView[] {
    return this._settings.repos.map((repo) => {
      const { token, ...rest } = repo
      const state = this._state.get(repo.id)
      const index = this._indexes.get(repo.id)?.manifest
      return {
        ...rest,
        tokenSet: !!token,
        syncing: state?.syncing ?? false,
        ...(state?.progress ? { progress: state.progress } : {}),
        ...(state?.lastSyncAt ? { lastSyncAt: state.lastSyncAt } : {}),
        ...(state?.error ? { error: state.error } : {}),
        ...(index ? { index: { files: index.files, chunks: index.chunks, dims: index.dims, alias: index.alias, commit: index.commit, updatedAt: index.updatedAt } } : {})
      }
    })
  }

  private overview() {
    return {
      repos: this.views(),
      alias: this.alias,
      aliases: this._context.inference?.embeddingAliases() ?? [],
      intervalMinutes: this._settings.intervalMinutes,
      searchPath: "/twinny/v1/plugins/context/search",
      gitAvailable: true
    }
  }

  public async handlePublic(request: PublicPluginRequest): Promise<PluginResponse> {
    if (request.path === "search" && request.method === "POST") {
      if (!request.principal) return { status: 401, body: { error: { message: "Search needs a gateway key." } } }
      const body = await request.body()
      const k = typeof body.k === "number" && body.k > 0 ? Math.min(body.k, MAX_HITS * 2) : MAX_HITS
      const repos = Array.isArray(body.repos) ? body.repos.filter((r): r is string => typeof r === "string") : undefined
      const hits = await this.search(typeof body.query === "string" ? body.query : "", k, repos)
      return json({ hits, alias: this.alias })
    }
    return notFound()
  }

  public async handle(request: PluginRequest): Promise<PluginResponse> {
    const { method, path: route } = request
    if (route === "" && method === "GET") return json(this.overview())
    if (route === "settings" && method === "PUT") {
      const body = await request.body()
      if (body.alias !== undefined) {
        const alias = typeof body.alias === "string" ? body.alias.trim() : ""
        if (alias && !(this._context.inference?.embeddingAliases() ?? []).includes(alias)) throw new PluginError(`No embeddings model is served as "${alias}".`, 400)
        if (alias) this._settings.alias = alias
        else delete this._settings.alias
      }
      if (body.intervalMinutes !== undefined) {
        const n = Number(body.intervalMinutes)
        if (!Number.isInteger(n) || n < 5 || n > 1440) throw new PluginError("The interval is 5 to 1440 minutes.", 400)
        this._settings.intervalMinutes = n
      }
      this.save()
      return json(this.overview())
    }
    if (route === "search" && method === "POST") {
      const body = await request.body()
      return json({ hits: await this.search(typeof body.query === "string" ? body.query : "", typeof body.k === "number" ? body.k : MAX_HITS) })
    }
    if (route === "repos" && method === "POST") {
      const body = await request.body()
      const url = typeof body.url === "string" ? body.url.trim() : ""
      if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(url)) throw new PluginError("Give a clone URL (https://…, git@…, ssh://… or a path on this server).", 400)
      if (this._settings.repos.length >= MAX_REPOS) throw new PluginError(`At most ${MAX_REPOS} repositories.`, 429)
      const name = (typeof body.name === "string" && body.name.trim()) || url.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).slice(-2).join("/")
      if (this._settings.repos.some((repo) => repo.name === name)) throw new PluginError(`"${name}" is already indexed.`, 409)
      const branch = typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : undefined
      const token = typeof body.token === "string" && body.token.trim() ? body.token.trim() : undefined
      let id = createHash("sha1").update(`${name}:${this._context.now()}`).digest("hex").slice(0, 8)
      while (this._settings.repos.some((repo) => repo.id === id)) id = createHash("sha1").update(`${id}x`).digest("hex").slice(0, 8)
      const repo: ContextRepo = { id, name, url, ...(branch ? { branch } : {}), ...(token ? { token } : {}), addedAt: new Date(this._context.now()).toISOString(), addedBy: request.principal }
      this._settings.repos.push(repo)
      this.save()
      this._context.log.info({ event: "plugin.context-repo-added", key: request.principal, reason: name })
      // The clone and the embedding can take minutes: the page watches the progress unless asked to wait.
      if (body.wait === true) {
        await this.sync(repo)
        const view = this.views().find((entry) => entry.id === id)
        return json({ repo: view }, view?.error ? 502 : 201)
      }
      void this.sync(repo)
      return json({ repo: this.views().find((entry) => entry.id === id) }, 202)
    }
    const match = /^repos\/([0-9a-f]{8})(?:\/(sync))?$/.exec(route)
    if (!match) return notFound()
    const repo = this._settings.repos.find((entry) => entry.id === match[1])
    if (!repo) return notFound("No such repository.")
    if (match[2] === "sync" && method === "POST") {
      const body = await request.body()
      if (body.wait === true) await this.sync(repo)
      else void this.sync(repo)
      return json({ repo: this.views().find((entry) => entry.id === repo.id) }, body.wait === true ? 200 : 202)
    }
    if (!match[2] && method === "DELETE") {
      this._settings.repos = this._settings.repos.filter((entry) => entry.id !== repo.id)
      this.save()
      this._indexes.delete(repo.id)
      this._state.delete(repo.id)
      fs.rmSync(this.repoDir(repo.id), { recursive: true, force: true })
      this._context.log.info({ event: "plugin.context-repo-removed", key: request.principal, reason: repo.name })
      return json({ id: repo.id, status: "removed" })
    }
    return notFound()
  }
}

export const contextPlugin: GatewayPlugin = {
  id: "context",
  name: "Shared context",
  description:
    "One index of your repositories on the gateway, built with a model it serves, so every developer's chat can draw on the whole codebase, not only the clone on their laptop.",
  create: (context) => new ContextPlugin(context)
}

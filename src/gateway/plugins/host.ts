/**
 * Plugins: features the gateway ships with but that are not the gateway.
 * Each one is switched on by the admin, owns a file under the data
 * directory, answers its own admin routes and, on the admin page, its own
 * section. The core knows nothing about what a plugin does.
 *
 *   GET  /twinny/v1/admin/plugins                 → what is bundled and what is on
 *   POST /twinny/v1/admin/plugins/<id>/enable     → switch on (started at once)
 *   POST /twinny/v1/admin/plugins/<id>/disable    → switch off (stopped at once)
 *   *    /twinny/v1/admin/plugins/<id>/api/<rest> → the plugin's own routes
 *   GET  /twinny/v1/admin/plugins/<id>/access     → who besides the admins may use it
 *   PUT  /twinny/v1/admin/plugins/<id>/access     { everyone, people }
 *
 * A developer's key reaches the listing (only what is shared with them)
 * and the routes a shared plugin names in `memberRoutes`; see access.ts.
 *
 * Which plugins are on, and who they are shared with, is kept in
 * plugins.json next to keys.json, so both survive a restart. Plugins are
 * bundled, not loaded from disk: the "store" is the list of what this
 * build carries.
 */
import fs from "node:fs"
import path from "node:path"

import { messageOf } from "../../common/errors"
import { isRecord } from "../../common/guards"
import type { GatewayLog } from "../log"
import { writePrivateJson } from "../private-file"

import { grants, isShared, memberMay, MemberRoute, NO_ACCESS, parseAccess, PluginAccess } from "./access"
import { PluginEventBus } from "./events"
import type { PluginInference } from "./inference"

export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/

/** Where the gateway keeps its files, for plugins that copy or move them. */
export interface GatewayPaths {
  /** The configuration file, when the gateway was started with one. */
  configFile?: string
  dataDir: string
  keysFile: string
  licenseFile: string
  usageDir: string
  recordingsDir: string
}

/** What a plugin gets from the gateway. Nothing else. */
export interface PluginContext {
  /** A directory of the plugin's own, under the gateway data directory. */
  dataDir: string
  log: GatewayLog
  /** Outgoing HTTP, injectable so tests can stand in for the world. */
  fetch: typeof fetch
  now: () => number
  /** The gateway's models, when the host offers them. */
  inference?: PluginInference
  /** The gateway's files, when the host says where they are. */
  paths?: GatewayPaths
  /** What the other plugins report; every plugin gets the same bus. */
  events?: PluginEventBus
  /** A live check of the backends, for plugins that watch health. */
  health?: () => Promise<Array<{ provider: string; ok: boolean; kind?: string }>>
  /** Minting keys through one-time invites, for sign-in plugins. */
  invites?: PluginInvites
}

/**
 * One request handed to a plugin: already authenticated, as an admin or,
 * with `member`, as a developer the plugin is shared with on one of its
 * `memberRoutes`.
 */
export interface PluginRequest {
  method: string
  /** The part after `/api/`, without a leading slash; `""` for the root. */
  path: string
  query: URLSearchParams
  /** The JSON body, read on demand; `{}` when there is none. */
  body: () => Promise<Record<string, unknown>>
  /** The key's name, for the log and for whatever the plugin keeps per person. */
  principal: string
  /** A developer rather than an admin; absent for an admin. */
  member?: boolean
}

export interface PluginResponse {
  status: number
  /** JSON, unless `html` is set. `null` with a 3xx status and a Location header redirects. */
  body?: unknown
  headers?: Record<string, string>
  /** A page instead of JSON, for the browser side of a plugin. */
  html?: string
}

/** A request on a plugin's public routes: no credential, so only what the request itself says. */
export interface PublicPluginRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: Record<string, string | undefined>
  /** The client address, for logs and throttles. */
  address: string
  body: () => Promise<Record<string, unknown>>
  /** The key's name when the request carried a valid gateway key; plugins that serve developers require it. */
  principal?: string
}

/** A running plugin. */
export interface PluginInstance {
  start?(): void
  stop?(): void | Promise<void>
  handle(request: PluginRequest): Promise<PluginResponse>
  /** Routes under `/twinny/v1/plugins/<id>/…`, open to anyone; only for plugins that need a browser flow. */
  handlePublic?(request: PublicPluginRequest): Promise<PluginResponse>
}

/** What a plugin may ask of the gateway's keys: an invite that mints one, on the gateway's own terms (seats, names). */
export interface PluginInvites {
  create(input: { name: string; admin?: boolean; replace?: boolean; ttlMs?: number; createdBy: string }): Promise<{ code: string; expiresAt: string }>
}

/** A bundled plugin: how it is described in the store, and how to run it. */
export interface GatewayPlugin {
  id: string
  name: string
  description: string
  create(context: PluginContext): PluginInstance
  /**
   * The routes a developer may call once an admin shares the plugin with
   * them. Absent, the plugin is for admins only and cannot be shared.
   */
  memberRoutes?: readonly MemberRoute[]
}

/** What the admin page lists. */
export interface PluginSummary {
  id: string
  name: string
  description: string
  enabled: boolean
  /** Whether an admin may share it with developers. */
  shareable: boolean
  /** Who it is shared with; in the admin listing of a shareable plugin only. */
  access?: PluginAccess
}

export class PluginError extends Error {
  constructor(
    message: string,
    /** The HTTP status a route should answer with. */
    public readonly status: number
  ) {
    super(message)
    this.name = "PluginError"
  }
}

/** Not found within a plugin, as most plugins will want to say it. */
export const notFound = (message = "Not found."): PluginResponse => ({
  status: 404,
  body: { error: { message } }
})

export const json = (body: unknown, status = 200): PluginResponse => ({
  status,
  body
})

interface PluginsFile {
  version: 1
  enabled: string[]
  /** Per plugin id; a plugin shared with nobody has no entry. */
  access?: Record<string, PluginAccess>
}

const parsePluginsFile = (text: string, file: string): PluginsFile => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON: ${messageOf(error)}`
    )
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.enabled) ||
    !parsed.enabled.every((id) => typeof id === "string")
  ) {
    throw new Error(`${file} is not a twinny-server plugins file.`)
  }
  const access: Record<string, PluginAccess> = {}
  if (parsed.access !== undefined) {
    if (!isRecord(parsed.access)) throw new Error(`${file} has a malformed access section.`)
    for (const [id, entry] of Object.entries(parsed.access)) {
      try {
        access[id] = parseAccess(entry)
      } catch (error) {
        throw new Error(`${file} has a malformed access entry for "${id}": ${messageOf(error)}`)
      }
    }
  }
  return { version: 1, enabled: parsed.enabled as string[], access }
}

/** The file that goes with a keys file. */
export const pluginsFileFor = (keysFile: string): string =>
  path.join(path.dirname(keysFile), "plugins.json")

/** Which plugins are on and who they are shared with; a small file, rewritten atomically. */
export class PluginStore {
  private _enabled: string[] = []
  private _access: Record<string, PluginAccess> = {}

  constructor(public readonly file: string) {}

  public static open(file: string): PluginStore {
    const store = new PluginStore(file)
    store.reload()
    return store
  }

  public enabled(): string[] {
    return [...this._enabled]
  }

  public isEnabled(id: string): boolean {
    return this._enabled.includes(id)
  }

  public setEnabled(id: string, enabled: boolean): void {
    const without = this._enabled.filter((entry) => entry !== id)
    this._enabled = enabled ? [...without, id] : without
    this.save()
  }

  /** Who a plugin is shared with; nobody unless an admin said otherwise. */
  public access(id: string): PluginAccess {
    return this._access[id] ?? NO_ACCESS
  }

  public setAccess(id: string, access: PluginAccess): void {
    const others = Object.fromEntries(Object.entries(this._access).filter(([entry]) => entry !== id))
    this._access = isShared(access) ? { ...others, [id]: access } : others
    this.save()
  }

  public reload(): void {
    try {
      const file = parsePluginsFile(fs.readFileSync(this.file, "utf8"), this.file)
      this._enabled = file.enabled
      this._access = file.access ?? {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this._enabled = []
        this._access = {}
        return
      }
      throw error
    }
  }

  private save(): void {
    const content: PluginsFile = {
      version: 1,
      enabled: this._enabled,
      ...(Object.keys(this._access).length ? { access: this._access } : {})
    }
    writePrivateJson(this.file, content)
  }
}

export interface PluginHostOptions {
  plugins: GatewayPlugin[]
  store: PluginStore
  /** Where plugins keep their files: `<dataDir>/plugins/<id>/`. */
  dataDir: string
  log: GatewayLog
  fetch?: typeof fetch
  now?: () => number
  /** The gateway's models for a plugin, by plugin id; read when the plugin starts. */
  inference?: (id: string) => PluginInference | undefined
  paths?: GatewayPaths
  health?: () => Promise<Array<{ provider: string; ok: boolean; kind?: string }>>
  invites?: PluginInvites
  /**
   * Whether the plan allows plugins. Read at every switch and request, so
   * a licence installed or lapsing applies at once; absent means allowed.
   */
  licensed?: () => boolean
}

export const PLUGINS_UNLICENSED =
  "Plugins need a licence with the plugins feature. Install one under Plan & licence."


/**
 * Runs the enabled plugins and routes admin requests to them. Switching a
 * plugin on starts it; off stops it and forgets the instance, so a plugin
 * switched on again starts fresh from its file.
 */
export class PluginHost {
  private readonly _running = new Map<string, PluginInstance>()
  private readonly _byId = new Map<string, GatewayPlugin>()
  public readonly events: PluginEventBus

  constructor(private readonly _options: PluginHostOptions) {
    this.events = new PluginEventBus(_options.now ?? Date.now, (error) =>
      _options.log.error({ event: "plugin.event-handler-failed", message: messageOf(error) })
    )
    for (const plugin of _options.plugins) {
      if (!PLUGIN_ID_PATTERN.test(plugin.id))
        throw new Error(`"${plugin.id}" is not a valid plugin id.`)
      if (this._byId.has(plugin.id))
        throw new Error(`Plugin "${plugin.id}" is bundled twice.`)
      this._byId.set(plugin.id, plugin)
    }
  }

  public get licensed(): boolean {
    return this._options.licensed?.() ?? true
  }

  /** Starts every plugin the store says is on, while the plan allows. Unknown ids are left alone. */
  public start(): void {
    if (!this.licensed) return
    for (const id of this._options.store.enabled()) {
      if (this._byId.has(id) && !this._running.has(id)) this.run(id)
    }
  }

  /**
   * After the plan changed: starts the plugins that are on if the licence
   * now allows them, stops them all if it no longer does. Their switch is
   * left as it was, so a renewed licence brings them straight back.
   */
  public async refresh(): Promise<void> {
    if (this.licensed) {
      this.start()
      return
    }
    for (const id of [...this._running.keys()]) await this.halt(id)
  }

  public async stop(): Promise<void> {
    for (const id of [...this._running.keys()]) await this.halt(id)
  }

  /** Everything bundled, with who each shareable plugin is shared with: the admin's view. */
  public list(): PluginSummary[] {
    return [...this._byId.values()].map((plugin) => ({
      ...this.summary(plugin),
      ...(plugin.memberRoutes ? { access: this._options.store.access(plugin.id) } : {})
    }))
  }

  /** What a developer may open: running, shareable plugins shared with them. Nothing about who else. */
  public listFor(principal: string): PluginSummary[] {
    return [...this._byId.values()]
      .filter((plugin) => this._running.has(plugin.id) && this.shares(plugin, principal))
      .map((plugin) => this.summary(plugin))
  }

  public access(id: string): PluginAccess {
    const plugin = this.plugin(id)
    if (!plugin.memberRoutes) throw new PluginError(`The ${plugin.name} plugin is for admins only.`, 404)
    return this._options.store.access(id)
  }

  /** Shares a plugin, or stops sharing it; takes effect with the next request. */
  public setAccess(id: string, input: unknown): PluginAccess {
    const plugin = this.plugin(id)
    if (!plugin.memberRoutes)
      throw new PluginError(`The ${plugin.name} plugin is for admins only and cannot be shared.`, 400)
    let access: PluginAccess
    try {
      access = parseAccess(input)
    } catch (error) {
      throw new PluginError(messageOf(error), 400)
    }
    this._options.store.setAccess(id, access)
    return this._options.store.access(id)
  }

  /**
   * Why a developer may not make this request, or nothing when they may:
   * the plugin must be shared with them and name the route as theirs.
   */
  public refuseMember(id: string, principal: string, method: string, path: string): string | undefined {
    const plugin = this.plugin(id)
    if (!this.shares(plugin, principal)) return `The ${plugin.name} plugin is not shared with ${principal}. An admin can share it on the Plugins page.`
    if (!memberMay(plugin.memberRoutes ?? [], method, path)) return `Only an admin can do that in the ${plugin.name} plugin.`
    return undefined
  }

  public has(id: string): boolean {
    return this._byId.has(id)
  }

  public isEnabled(id: string): boolean {
    return this._running.has(id)
  }

  /** The running instance, for tests and for the gateway's own checks. */
  public instance(id: string): PluginInstance | undefined {
    return this._running.get(id)
  }

  public enable(id: string): PluginSummary {
    const plugin = this.plugin(id)
    if (!this.licensed) throw new PluginError(PLUGINS_UNLICENSED, 403)
    if (!this._running.has(id)) this.run(id)
    this._options.store.setEnabled(id, true)
    return this.summary(plugin)
  }

  public async disable(id: string): Promise<PluginSummary> {
    const plugin = this.plugin(id)
    await this.halt(id)
    this._options.store.setEnabled(id, false)
    return this.summary(plugin)
  }

  /** Hands a request to a running plugin. */
  public async handle(
    id: string,
    request: PluginRequest
  ): Promise<PluginResponse> {
    const plugin = this.plugin(id)
    if (!this.licensed) throw new PluginError(PLUGINS_UNLICENSED, 403)
    const instance = this._running.get(id)
    if (!instance)
      throw new PluginError(`The ${plugin.name} plugin is switched off.`, 409)
    try {
      return await instance.handle(request)
    } catch (error) {
      if (error instanceof PluginError)
        return { status: error.status, body: { error: { message: error.message } } }
      this._options.log.error({
        event: "plugin.failed",
        reason: id,
        message: messageOf(error)
      })
      return {
        status: 500,
        body: {
          error: {
            message: messageOf(error)
          }
        }
      }
    }
  }

  /** Hands a public (no credential) request to a running plugin that has public routes. */
  public async handlePublic(id: string, request: PublicPluginRequest): Promise<PluginResponse> {
    const plugin = this.plugin(id)
    if (!this.licensed) throw new PluginError(PLUGINS_UNLICENSED, 403)
    const instance = this._running.get(id)
    if (!instance) throw new PluginError(`The ${plugin.name} plugin is switched off.`, 409)
    if (!instance.handlePublic) throw new PluginError(`The ${plugin.name} plugin has no public routes.`, 404)
    try {
      return await instance.handlePublic(request)
    } catch (error) {
      if (error instanceof PluginError) return { status: error.status, body: { error: { message: error.message } } }
      this._options.log.error({ event: "plugin.failed", reason: id, message: messageOf(error) })
      return { status: 500, body: { error: { message: messageOf(error) } } }
    }
  }

  private plugin(id: string): GatewayPlugin {
    const plugin = this._byId.get(id)
    if (!plugin) throw new PluginError(`No plugin "${id}" is bundled.`, 404)
    return plugin
  }

  private summary(plugin: GatewayPlugin): PluginSummary {
    return {
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      enabled: this._running.has(plugin.id),
      shareable: !!plugin.memberRoutes
    }
  }

  private shares(plugin: GatewayPlugin, principal: string): boolean {
    return !!plugin.memberRoutes && grants(this._options.store.access(plugin.id), principal)
  }

  private run(id: string): void {
    const plugin = this.plugin(id)
    const dataDir = path.join(this._options.dataDir, "plugins", id)
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const instance = plugin.create({
      dataDir,
      log: this._options.log,
      fetch: this._options.fetch ?? fetch,
      now: this._options.now ?? Date.now,
      ...(this._options.inference
        ? { inference: this._options.inference(id) }
        : {}),
      ...(this._options.paths ? { paths: this._options.paths } : {}),
      events: this.events,
      ...(this._options.health ? { health: this._options.health } : {}),
      ...(this._options.invites ? { invites: this._options.invites } : {})
    })
    this._running.set(id, instance)
    instance.start?.()
    this._options.log.info({ event: "plugin.started", reason: id })
  }

  private async halt(id: string): Promise<void> {
    const instance = this._running.get(id)
    if (!instance) return
    this._running.delete(id)
    await instance.stop?.()
    this._options.log.info({ event: "plugin.stopped", reason: id })
  }
}

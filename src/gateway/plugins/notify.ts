/**
 * What the chat notifiers share (Slack, Discord, Teams): webhooks kept
 * secret, one per channel with its own event list, delivery to whichever
 * asked when an event lands on the bus, a test message, a delivery log,
 * and the backend-health poll that turns outages into events. A host
 * differs only in the JSON its webhooks take.
 *
 *   GET    api/                      → webhooks (never their URLs), recent deliveries, what can be sent
 *   POST   api/webhooks { name, url, events }
 *   PUT    api/webhooks/<id> { name?, url?, events? }
 *   DELETE api/webhooks/<id>
 *   POST   api/webhooks/<id>/test    → sends a hello
 */
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { isRecord } from "../../common/guards"
import { writePrivateJson } from "../private-file"

import { EVENT_KINDS, PluginEvent } from "./events"
import {
  json,
  notFound,
  PluginContext,
  PluginError,
  PluginInstance,
  PluginRequest,
  PluginResponse
} from "./host"

export const HEALTH_POLL_MS = 60_000
const MAX_WEBHOOKS = 20
const KEEP_DELIVERIES = 100
const POST_TIMEOUT_MS = 10_000
const NAME_PATTERN = /^[^\s][^\n]{0,63}$/

export interface WebhookRecord {
  id: string
  name: string
  url: string
  events: string[]
  createdAt: string
  createdBy: string
}

export interface WebhookView {
  id: string
  name: string
  /** The host the URL points at, so a page can tell hooks.slack.com from a Mattermost. */
  host: string
  events: string[]
  createdAt: string
  createdBy: string
}

export interface Delivery {
  at: string
  webhook: string
  webhookId: string
  event: string
  title: string
  ok: boolean
  status?: number
  error?: string
  ms: number
}

/** How one chat host wants its webhook called. */
export interface NotifyHost {
  /** The plugin id, also the source of the events it emits. */
  id: string
  /** What the page calls a webhook URL and where to get one. */
  urlExample: string
  /** Turns an event into the JSON body the host takes. */
  payload(event: PluginEvent): unknown
  /** Refuses URLs that are plainly not this host's, with a reason; nothing means fine. */
  checkUrl?(url: URL): string | undefined
}

interface WebhooksFile {
  version: 1
  webhooks: WebhookRecord[]
}

const KNOWN_EVENTS = new Set(EVENT_KINDS.map((kind) => kind.type))

const cleanEvents = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new PluginError("events is a list of event types.", 400)
  const events = [...new Set(value.filter((entry): entry is string => typeof entry === "string"))]
  const unknown = events.find((event) => !KNOWN_EVENTS.has(event))
  if (unknown) throw new PluginError(`"${unknown}" is not an event this gateway sends.`, 400)
  return events
}

const view = (record: WebhookRecord): WebhookView => ({
  id: record.id,
  name: record.name,
  host: new URL(record.url).host,
  events: record.events,
  createdAt: record.createdAt,
  createdBy: record.createdBy
})

export class WebhookStore {
  private _webhooks: WebhookRecord[] = []

  constructor(public readonly file: string) {}

  public static open(file: string): WebhookStore {
    const store = new WebhookStore(file)
    store.reload()
    return store
  }

  public all(): WebhookRecord[] {
    return this._webhooks.map((record) => ({ ...record }))
  }

  public get(id: string): WebhookRecord | undefined {
    const record = this._webhooks.find((entry) => entry.id === id)
    return record && { ...record }
  }

  public add(input: Omit<WebhookRecord, "id">): WebhookRecord {
    if (this._webhooks.length >= MAX_WEBHOOKS)
      throw new PluginError(`At most ${MAX_WEBHOOKS} webhooks.`, 429)
    let id = randomBytes(4).toString("hex")
    while (this._webhooks.some((entry) => entry.id === id)) id = randomBytes(4).toString("hex")
    const record: WebhookRecord = { id, ...input }
    this._webhooks.push(record)
    this.save()
    return { ...record }
  }

  public update(id: string, changes: Partial<Pick<WebhookRecord, "name" | "url" | "events">>): WebhookRecord {
    const record = this._webhooks.find((entry) => entry.id === id)
    if (!record) throw new PluginError("No such webhook.", 404)
    Object.assign(record, changes)
    this.save()
    return { ...record }
  }

  public remove(id: string): boolean {
    const before = this._webhooks.length
    this._webhooks = this._webhooks.filter((entry) => entry.id !== id)
    if (this._webhooks.length === before) return false
    this.save()
    return true
  }

  public reload(): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this._webhooks = []
        return
      }
      throw error
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.webhooks))
      throw new Error(`${this.file} is not a twinny-server webhooks file.`)
    this._webhooks = parsed.webhooks.flatMap((entry) =>
      isRecord(entry) && typeof entry.id === "string" && typeof entry.name === "string" && typeof entry.url === "string"
        ? [
            {
              id: entry.id,
              name: entry.name,
              url: entry.url,
              events: Array.isArray(entry.events) ? entry.events.filter((e): e is string => typeof e === "string") : [],
              createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
              createdBy: typeof entry.createdBy === "string" ? entry.createdBy : ""
            }
          ]
        : []
    )
  }

  private save(): void {
    const content: WebhooksFile = { version: 1, webhooks: this._webhooks }
    writePrivateJson(this.file, content)
  }
}

export class NotifierPlugin implements PluginInstance {
  public readonly store: WebhookStore
  private readonly _deliveries: Delivery[] = []
  private _unsubscribe: (() => void) | undefined
  private _healthTimer: NodeJS.Timeout | undefined
  /** Which backends answered at the last poll; absent until the first. */
  private _backendsOk: Map<string, boolean> | undefined
  private _inflight = new Set<Promise<unknown>>()

  constructor(
    private readonly _context: PluginContext,
    private readonly _host: NotifyHost,
    private readonly _healthPollMs = HEALTH_POLL_MS
  ) {
    this.store = WebhookStore.open(path.join(_context.dataDir, "webhooks.json"))
  }

  public start(): void {
    this._unsubscribe = this._context.events?.on((event) => this.dispatch(event))
    if (this._context.health && this._healthPollMs > 0) {
      this._healthTimer = setInterval(() => void this.pollHealth(), this._healthPollMs)
      this._healthTimer.unref()
      void this.pollHealth()
    }
  }

  public async stop(): Promise<void> {
    this._unsubscribe?.()
    if (this._healthTimer) clearInterval(this._healthTimer)
    await Promise.allSettled([...this._inflight])
  }

  public deliveries(): Delivery[] {
    return [...this._deliveries].reverse()
  }

  /**
   * Asks the gateway about its backends and reports the ones that changed.
   * Every notifier polls; the bus does not mind hearing the same outage
   * twice, but a channel would, so only the first notifier to notice
   * emits: the others see the event already on the bus within the minute.
   */
  public async pollHealth(): Promise<void> {
    if (!this._context.health) return
    let backends: Array<{ provider: string; ok: boolean; kind?: string }>
    try {
      backends = await this._context.health()
    } catch {
      return
    }
    const previous = this._backendsOk
    const current = new Map(backends.map((backend) => [backend.provider, backend.ok]))
    this._backendsOk = current
    if (!previous) return
    for (const backend of backends) {
      const was = previous.get(backend.provider)
      if (was === undefined || was === backend.ok) continue
      const type = backend.ok ? "backend.up" : "backend.down"
      const alreadySaid = this._context.events
        ?.recent(20)
        .some((event) => event.type === type && event.data?.provider === backend.provider && Date.parse(event.at) > this._context.now() - this._healthPollMs)
      if (alreadySaid) continue
      this._context.events?.emit({
        type,
        source: "gateway",
        level: backend.ok ? "info" : "error",
        title: backend.ok ? `Backend ${backend.provider} answers again` : `Backend ${backend.provider} is down`,
        text: backend.ok ? "" : `It stopped answering${backend.kind ? ` (${backend.kind})` : ""}. Aliases served by it fail until it is back.`,
        data: { provider: backend.provider }
      })
    }
  }

  private dispatch(event: PluginEvent): void {
    for (const webhook of this.store.all()) {
      if (!webhook.events.includes(event.type)) continue
      const job = this.send(webhook, event).finally(() => this._inflight.delete(job))
      this._inflight.add(job)
    }
  }

  private async send(webhook: WebhookRecord, event: PluginEvent): Promise<Delivery> {
    const started = this._context.now()
    const delivery: Delivery = {
      at: new Date(started).toISOString(),
      webhook: webhook.name,
      webhookId: webhook.id,
      event: event.type,
      title: event.title,
      ok: false,
      ms: 0
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS)
      try {
        const response = await this._context.fetch(webhook.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(this._host.payload(event)),
          signal: controller.signal
        })
        delivery.status = response.status
        const body = (await response.text()).slice(0, 200)
        if (!response.ok) throw new Error(`${new URL(webhook.url).host} answered ${response.status}${body ? `: ${body}` : ""}`)
        delivery.ok = true
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      delivery.error = error instanceof Error ? error.message : String(error)
      this._context.log.warn({ event: `plugin.${this._host.id}-failed`, reason: webhook.name, message: delivery.error })
    }
    delivery.ms = this._context.now() - started
    this._deliveries.push(delivery)
    if (this._deliveries.length > KEEP_DELIVERIES) this._deliveries.splice(0, this._deliveries.length - KEEP_DELIVERIES)
    return delivery
  }

  private cleanUrl(value: unknown): string {
    const url = typeof value === "string" ? value.trim() : ""
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new PluginError(`Paste the webhook URL (${this._host.urlExample}).`, 400)
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      throw new PluginError("The webhook URL must start with https://.", 400)
    const problem = this._host.checkUrl?.(parsed)
    if (problem) throw new PluginError(problem, 400)
    return parsed.toString()
  }

  private overview() {
    return {
      webhooks: this.store.all().map(view),
      kinds: EVENT_KINDS,
      deliveries: this.deliveries(),
      health: this._context.health !== undefined,
      backends: this._backendsOk ? [...this._backendsOk.entries()].map(([provider, ok]) => ({ provider, ok })) : [],
      urlExample: this._host.urlExample
    }
  }

  public async handle(request: PluginRequest): Promise<PluginResponse> {
    const { method, path: route } = request
    if (route === "" && method === "GET") return json(this.overview())
    if (route === "webhooks" && method === "POST") {
      const body = await request.body()
      const name = typeof body.name === "string" ? body.name.trim() : ""
      if (!NAME_PATTERN.test(name)) throw new PluginError("Give the webhook a name, such as the channel.", 400)
      const record = this.store.add({
        name,
        url: this.cleanUrl(body.url),
        events: body.events === undefined ? EVENT_KINDS.map((kind) => kind.type) : cleanEvents(body.events),
        createdAt: new Date(this._context.now()).toISOString(),
        createdBy: request.principal
      })
      this._context.log.info({ event: `plugin.${this._host.id}-webhook-added`, key: request.principal, reason: name })
      return json({ webhook: view(record) }, 201)
    }
    const match = /^webhooks\/([0-9a-f]{8})(?:\/(test))?$/.exec(route)
    if (!match) return notFound()
    const record = this.store.get(match[1])
    if (!record) return notFound("No such webhook.")
    if (match[2] === "test" && method === "POST") {
      const delivery = await this.send(record, {
        type: "test",
        source: this._host.id,
        at: new Date(this._context.now()).toISOString(),
        level: "info",
        title: "twinny-server can reach this channel",
        text: `Sent by ${request.principal} from the admin page. Events you picked for it will arrive here.`
      })
      if (!delivery.ok) throw new PluginError(delivery.error ?? "The webhook did not accept the message.", 502)
      return json({ delivery })
    }
    if (match[2]) return notFound()
    if (method === "PUT") {
      const body = await request.body()
      const changes: Partial<Pick<WebhookRecord, "name" | "url" | "events">> = {}
      if (body.name !== undefined) {
        const name = typeof body.name === "string" ? body.name.trim() : ""
        if (!NAME_PATTERN.test(name)) throw new PluginError("Give the webhook a name.", 400)
        changes.name = name
      }
      if (typeof body.url === "string" && body.url.trim()) changes.url = this.cleanUrl(body.url)
      if (body.events !== undefined) changes.events = cleanEvents(body.events)
      return json({ webhook: view(this.store.update(record.id, changes)) })
    }
    if (method === "DELETE") {
      this.store.remove(record.id)
      this._context.log.info({ event: `plugin.${this._host.id}-webhook-removed`, key: request.principal, reason: record.name })
      return json({ id: record.id, status: "removed" })
    }
    return notFound()
  }
}

/**
 * Page links: how a developer lands on the gateway's page signed in,
 * without their key ever being shown, pasted or put in a URL.
 *
 *   VS Code  → POST /twinny/v1/page-link { } with its key  → { code, expiresAt }
 *   VS Code  opens <gateway>/admin#link=<code>
 *   page     → POST /twinny/v1/page-link/open { code }     → { key, name }   (once)
 *
 * The code rides in the fragment, which the browser never sends, so no
 * proxy or access log sees it. It opens once, within a minute, and only
 * hands back the key that asked for it: a code proves nothing a key does
 * not. Everything lives in memory and is bounded, per key name and in
 * total, so a busy key cannot fill it.
 */
import { randomBytes } from "node:crypto"

export const PAGE_LINK_TTL_MS = 60_000
export const MAX_PAGE_LINKS = 200
export const MAX_PAGE_LINKS_PER_NAME = 5
const CODE_BYTES = 32
const CODE_PATTERN = /^[0-9a-f]{64}$/

interface Record_ {
  key: string
  name: string
  createdAt: number
  expiresAt: number
}

export interface PageLinkOpened {
  key: string
  name: string
}

export class PageLinks {
  private readonly _records = new Map<string, Record_>()

  constructor(private readonly _now: () => number = Date.now) {}

  public get size(): number {
    this.prune()
    return this._records.size
  }

  /** A fresh code for this key. The oldest outstanding code gives way when there are too many. */
  public mint(key: string, name: string): { code: string; expiresAt: string } {
    this.prune()
    const mine = [...this._records.entries()].filter(([, record]) => record.name === name)
    if (mine.length >= MAX_PAGE_LINKS_PER_NAME) this.dropOldest(mine)
    if (this._records.size >= MAX_PAGE_LINKS) this.dropOldest([...this._records.entries()])
    const now = this._now()
    const code = randomBytes(CODE_BYTES).toString("hex")
    this._records.set(code, { key, name, createdAt: now, expiresAt: now + PAGE_LINK_TTL_MS })
    return { code, expiresAt: new Date(now + PAGE_LINK_TTL_MS).toISOString() }
  }

  /** The key behind a code, once; undefined for a code that is used, expired, unknown or malformed. */
  public open(code: unknown): PageLinkOpened | undefined {
    this.prune()
    if (typeof code !== "string" || !CODE_PATTERN.test(code)) return undefined
    const record = this._records.get(code)
    if (!record) return undefined
    this._records.delete(code)
    return { key: record.key, name: record.name }
  }

  private dropOldest(entries: Array<[string, Record_]>) {
    const oldest = entries.sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
    if (oldest) this._records.delete(oldest[0])
  }

  private prune() {
    const now = this._now()
    for (const [code, record] of this._records) if (record.expiresAt <= now) this._records.delete(code)
  }
}

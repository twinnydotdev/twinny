/**
 * Quotas: how much a key may use per UTC day, in requests and in
 * tokens the backends reported. A default applies to every key; named
 * keys can have their own. Counted in memory, seeded from today's usage
 * file at start so a restart does not reset anyone. At the warning
 * share an event goes out once per key per day; at the cap the
 * request is refused with 429 before it reaches a backend.
 */
import { summarizeUsage } from "./usage"

export interface Quota {
  requestsPerDay?: number
  tokensPerDay?: number
}

export interface QuotasPolicy {
  /** Applies to every key that has no entry of its own. */
  default?: Quota
  /** By key name. */
  keys?: Record<string, Quota>
  /** Share of a cap at which a warning is raised, 0.5–0.99; 0.8 unless set. */
  warnAt?: number
}

export interface QuotaUse {
  requests: number
  tokens: number
}

export interface QuotaStanding extends QuotaUse {
  quota: Quota
  /** The larger of the two shares used, 0–1+, or undefined with no caps. */
  share?: number
  /** Which cap, if any, is exhausted. */
  exhausted?: "requests" | "tokens"
}

const DEFAULT_WARN_AT = 0.8

const dayOf = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10)

export class QuotaMeter {
  private _day: string
  private _use = new Map<string, QuotaUse>()
  private _warned = new Set<string>()

  constructor(
    private _policy: QuotasPolicy | undefined,
    private readonly _now: () => number = Date.now,
    /** Today's usage per key, read once at start; nothing when there is no usage dir. */
    seed?: () => Record<string, QuotaUse>
  ) {
    this._day = dayOf(_now())
    if (seed) for (const [key, use] of Object.entries(seed())) this._use.set(key, { ...use })
  }

  /** Today's use per key from the usage files, for seeding. */
  public static seedFrom(usageDir: string, now: () => number = Date.now): () => Record<string, QuotaUse> {
    return () => {
      const start = new Date(`${dayOf(now())}T00:00:00.000Z`)
      const summary = summarizeUsage(usageDir, start, new Date(now()))
      const out: Record<string, QuotaUse> = {}
      for (const [key, totals] of Object.entries(summary.byKey))
        out[key] = { requests: totals.requests, tokens: (totals.promptTokens ?? 0) + (totals.completionTokens ?? 0) }
      return out
    }
  }

  public update(policy: QuotasPolicy | undefined): void {
    this._policy = policy
  }

  public get policy(): QuotasPolicy | undefined {
    return this._policy
  }

  private roll(): void {
    const day = dayOf(this._now())
    if (day === this._day) return
    this._day = day
    this._use.clear()
    this._warned.clear()
  }

  public quotaFor(key: string): Quota {
    return this._policy?.keys?.[key] ?? this._policy?.default ?? {}
  }

  public standing(key: string): QuotaStanding {
    this.roll()
    const use = this._use.get(key) ?? { requests: 0, tokens: 0 }
    const quota = this.quotaFor(key)
    const shares: number[] = []
    let exhausted: QuotaStanding["exhausted"]
    if (quota.requestsPerDay !== undefined) {
      shares.push(use.requests / quota.requestsPerDay)
      if (use.requests >= quota.requestsPerDay) exhausted = "requests"
    }
    if (quota.tokensPerDay !== undefined) {
      shares.push(use.tokens / quota.tokensPerDay)
      if (use.tokens >= quota.tokensPerDay) exhausted = exhausted ?? "tokens"
    }
    return { ...use, quota, ...(shares.length ? { share: Math.max(...shares) } : {}), ...(exhausted ? { exhausted } : {}) }
  }

  /** Everyone with use or a quota today, for the page. */
  public standings(keys: string[]): Record<string, QuotaStanding> {
    this.roll()
    const names = new Set([...keys, ...this._use.keys(), ...Object.keys(this._policy?.keys ?? {})])
    const out: Record<string, QuotaStanding> = {}
    for (const name of names) out[name] = this.standing(name)
    return out
  }

  /**
   * Why a request from `key` may not start, or nothing. The cap counts
   * the request being asked for, so the last allowed one is the cap itself.
   */
  public refuse(key: string): string | undefined {
    const standing = this.standing(key)
    if (!standing.exhausted) return undefined
    const { quota } = standing
    return standing.exhausted === "requests"
      ? `Daily quota reached: ${quota.requestsPerDay} requests today. It resets at midnight UTC; ask your admin for more.`
      : `Daily quota reached: ${quota.tokensPerDay?.toLocaleString("en-US")} tokens today. It resets at midnight UTC; ask your admin for more.`
  }

  /**
   * Counts a finished request. Returns a warning to raise when the key
   * just crossed the warning share for the first time today.
   */
  public count(key: string, tokens: number): { warning?: string; standing: QuotaStanding } {
    this.roll()
    const use = this._use.get(key) ?? { requests: 0, tokens: 0 }
    use.requests++
    use.tokens += Math.max(0, tokens)
    this._use.set(key, use)
    const standing = this.standing(key)
    const warnAt = this._policy?.warnAt ?? DEFAULT_WARN_AT
    if (standing.share !== undefined && standing.share >= warnAt && !this._warned.has(key)) {
      this._warned.add(key)
      return {
        standing,
        warning: `${key} has used ${Math.round(standing.share * 100)}% of today's quota (${use.requests} requests, ${use.tokens.toLocaleString("en-US")} tokens).`
      }
    }
    return { standing }
  }
}

/** A `*` glob against a name, case-insensitive; `*` alone or an empty pattern matches everything. */
export const globMatch = (pattern: string, value: string): boolean => {
  const source = `^${pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")}$`
  return new RegExp(source, "i").test(value)
}

export interface RoutingRule {
  /** A glob on the workspace name the extension sends, e.g. `payments-*`. */
  workspace: string
  /** Only backends that run on the team's own machines may serve this workspace. */
  localOnly?: boolean
  /** Only these aliases may serve it. */
  aliases?: string[]
}

/**
 * The first rule whose workspace glob matches decides. Returns why the
 * alias may not serve the workspace, or nothing when it may.
 */
export const refuseByRouting = (
  rules: RoutingRule[] | undefined,
  workspace: string | undefined,
  alias: string,
  hosted: boolean
): string | undefined => {
  if (!rules?.length || !workspace) return undefined
  const rule = rules.find((entry) => globMatch(entry.workspace, workspace))
  if (!rule) return undefined
  if (rule.localOnly && hosted)
    return `Team policy: code from "${workspace}" may only go to models on the team's own machines, and "${alias}" is served by a hosted provider.`
  if (rule.aliases?.length && !rule.aliases.includes(alias))
    return `Team policy: "${workspace}" may only use ${rule.aliases.map((name) => `"${name}"`).join(", ")}, not "${alias}".`
  return undefined
}

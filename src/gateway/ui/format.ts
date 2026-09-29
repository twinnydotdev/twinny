/** Numbers and times as the admin page shows them. */

export const fmt = (n: number): string => n.toLocaleString("en-US")

export const pct = (part: number, whole: number): string => (whole ? `${Math.round((part / whole) * 100)}%` : "–")

/** `2026-09-15 14:03`, UTC as stored. */
export const when = (iso: string): string => iso.replace("T", " ").slice(0, 16)

/** `2026-09-15 14:03:27`. */
export const whenExact = (iso: string): string => iso.replace("T", " ").slice(0, 19)

/** "12s ago", "4 min ago", "3 h ago", "2 d ago", then the date. */
export const timeAgo = (iso: string, now: number = Date.now()): string => {
  const s = Math.round((now - Date.parse(iso)) / 1000)
  if (!Number.isFinite(s)) return "–"
  if (s < 0) return "just now"
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 14) return `${d} d ago`
  return iso.slice(0, 10)
}

/** "in 4 min", "in 30s", or "expired". */
export const timeUntil = (iso: string, now: number = Date.now()): string => {
  const s = Math.round((Date.parse(iso) - now) / 1000)
  if (!Number.isFinite(s)) return "–"
  if (s <= 0) return "expired"
  if (s < 60) return `in ${s}s`
  if (s < 3600) return `in ${Math.round(s / 60)} min`
  if (s < 86_400 * 2) return `in ${Math.round(s / 3600)} h`
  return `in ${Math.round(s / 86_400)} days`
}

/** Milliseconds as "840 ms" or "2.3 s". */
export const duration = (ms: number): string => (ms < 1000 ? `${fmt(Math.round(ms))} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`)

/** Tokens as "1,240" or "12.4k". */
export const compact = (n: number): string => (n < 10_000 ? fmt(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`)

export const plural = (n: number, one: string, many = `${one}s`): string => `${fmt(n)} ${n === 1 ? one : many}`

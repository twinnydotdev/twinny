/**
 * Secret shield: credentials in a prompt are swapped for placeholders
 * before it leaves the machine, and swapped back in what the model writes.
 *
 * A key pasted into a question, a `.env` file mentioned in chat, a token in
 * the code around the cursor: each becomes `REDACTED_<KIND>_<n>`. The same
 * secret gets the same placeholder everywhere in one request, so the model
 * can still reason about "the key on line 3" and write code that uses it.
 * When the reply names a placeholder, the developer sees their real value;
 * the model never did.
 *
 * Detection is deliberately conservative: well-known token shapes, private
 * key blocks, passwords in URLs, and quoted or `.env` values assigned to a
 * name that says it is secret. A value that looks like a placeholder
 * (`process.env.X`, `<your-key>`, `changeme`) is left alone.
 */

/** A kind of credential, as it is named in a placeholder and in the UI. */
export interface SecretKind {
  id: string
  label: string
}

interface Detector extends SecretKind {
  pattern: RegExp
  /**
   * For patterns that match surrounding text (`password = "…"`): the
   * capture groups before and after the secret, kept as they are.
   */
  around?: boolean
  /** Extra check on the secret itself, for the generic patterns. */
  accept?(secret: string): boolean
}

/** Bits per character; real keys are high, `aaaaaaaa` and `password` are low. */
const entropy = (text: string): number => {
  const counts = new Map<string, number>()
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const p = count / text.length
    bits -= p * Math.log2(p)
  }
  return bits
}

const PLACEHOLDER_VALUE =
  /\$\{|process\.env|os\.environ|getenv|<[^>]*>|\{\{|^x+$|your[_-]|example|changeme|placeholder|dummy|redacted|^\*+$|\.\.\.|^(true|false|null|none|undefined)$/i

const looksReal = (secret: string) =>
  !PLACEHOLDER_VALUE.test(secret) && entropy(secret) >= 3

const SECRET_NAME =
  "(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|credentials?)"

const DETECTORS: Detector[] = [
  {
    id: "private-key",
    label: "Private key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g
  },
  { id: "aws-access-key", label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    id: "github-token",
    label: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g
  },
  { id: "gitlab-token", label: "GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { id: "slack-token", label: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  {
    id: "slack-webhook",
    label: "Slack webhook",
    pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g
  },
  { id: "stripe-key", label: "Stripe key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { id: "anthropic-key", label: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  {
    id: "openai-key",
    label: "OpenAI key",
    pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
    accept: looksReal
  },
  { id: "google-api-key", label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "huggingface-token", label: "Hugging Face token", pattern: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { id: "npm-token", label: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    id: "jwt",
    label: "JSON web token",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
  },
  {
    id: "url-password",
    label: "Password in a URL",
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]{3,})(@)/gi,
    around: true,
    accept: (secret) => !PLACEHOLDER_VALUE.test(secret)
  },
  {
    // PASSWORD=hunter2hunter2 in a .env file or a shell export.
    id: "env-secret",
    label: "Secret in an environment file",
    pattern: new RegExp(
      `^(\\s*(?:export\\s+)?[A-Za-z0-9_]*${SECRET_NAME}[A-Za-z0-9_]*\\s*=\\s*["']?)([^\\s"'#]{8,})(["']?)`,
      "gim"
    ),
    around: true,
    accept: looksReal
  },
  {
    // apiKey: "…", "client_secret": "…", password = '…' in code or JSON.
    id: "assigned-secret",
    label: "Secret assigned in code",
    pattern: new RegExp(
      `(${SECRET_NAME}[A-Za-z0-9_]*["']?\\s*(?::|=|:=|=>)\\s*["'\`])([^"'\`\\s]{8,})(["'\`])`,
      "gi"
    ),
    around: true,
    accept: looksReal
  }
]

/** Every kind the shield knows, for settings and docs. */
export const SECRET_KINDS: SecretKind[] = DETECTORS.map(({ id, label }) => ({ id, label }))

const labelOf = (id: string) => DETECTORS.find((d) => d.id === id)?.label ?? id

const PLACEHOLDER = /REDACTED_[A-Z_]+_\d+/g

const placeholderFor = (kind: string, n: number) =>
  `REDACTED_${kind.toUpperCase().replace(/-/g, "_")}_${n}`

/** What was withheld from one request: kinds and counts, never the values. */
export interface ShieldReport {
  kind: string
  label: string
  count: number
}

/**
 * One request's worth of redaction. Redact everything the request sends
 * through the same shield, so a secret repeated in two messages gets one
 * placeholder, then restore what comes back.
 */
export class SecretShield {
  private readonly _bySecret = new Map<string, string>()
  private readonly _byPlaceholder = new Map<string, string>()
  private readonly _kindCounts = new Map<string, number>()

  public redact(text: string): string {
    if (!text) return text
    let out = text
    for (const detector of DETECTORS) {
      detector.pattern.lastIndex = 0
      out = out.replace(detector.pattern, (match: string, ...groups: unknown[]) => {
        if (detector.around) {
          const [before, secret, after] = groups as string[]
          if (detector.accept && !detector.accept(secret)) return match
          return `${before}${this.placeholder(detector.id, secret)}${after}`
        }
        if (detector.accept && !detector.accept(match)) return match
        return this.placeholder(detector.id, match)
      })
    }
    return out
  }

  /** Put the real values back wherever the model repeated a placeholder. */
  public restore(text: string): string {
    if (!this._byPlaceholder.size || !text) return text
    return text.replace(PLACEHOLDER, (p) => this._byPlaceholder.get(p) ?? p)
  }

  /**
   * A restorer for streamed text: holds back the tail of a chunk that could
   * be the start of a placeholder, so one split across chunks still comes
   * back whole. `flush()` returns whatever is left at the end.
   */
  public restoreStream(): { push(chunk: string): string; flush(): string } {
    let pending = ""
    return {
      push: (chunk) => {
        if (!this._byPlaceholder.size) return chunk
        pending += chunk
        const hold = heldTail(pending)
        const ready = pending.slice(0, pending.length - hold)
        pending = pending.slice(pending.length - hold)
        return this.restore(ready)
      },
      flush: () => {
        const rest = this.restore(pending)
        pending = ""
        return rest
      }
    }
  }

  public get withheld(): boolean {
    return this._bySecret.size > 0
  }

  public report(): ShieldReport[] {
    return [...this._kindCounts].map(([kind, count]) => ({ kind, label: labelOf(kind), count }))
  }

  private placeholder(kind: string, secret: string): string {
    const known = this._bySecret.get(secret)
    if (known) return known
    const n = (this._kindCounts.get(kind) ?? 0) + 1
    this._kindCounts.set(kind, n)
    const placeholder = placeholderFor(kind, n)
    this._bySecret.set(secret, placeholder)
    this._byPlaceholder.set(placeholder, secret)
    return placeholder
  }
}

const MARKER = "REDACTED_"

/**
 * How many characters at the end of `text` might still grow into a
 * placeholder: a partial `REDACTED_`, or a whole one whose number may not
 * have finished arriving.
 */
const heldTail = (text: string): number => {
  const tail = /REDACTED_[A-Z_]*\d*$/.exec(text)
  if (tail) return tail[0].length
  for (let n = Math.min(MARKER.length - 1, text.length); n > 0; n--) {
    if (MARKER.startsWith(text.slice(-n))) return n
  }
  return 0
}

/** "2 secrets" style summary for logs and tooltips. */
export const describeReport = (report: ShieldReport[]): string =>
  report.map(({ label, count }) => (count > 1 ? `${label} ×${count}` : label)).join(", ")

export const withheldCount = (report: ShieldReport[]): number =>
  report.reduce((sum, { count }) => sum + count, 0)

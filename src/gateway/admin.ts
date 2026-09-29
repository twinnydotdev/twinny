/**
 * The operator's commands: access keys and usage reports. They work on
 * the files directly, so the server need not be running, and pick up the
 * paths from the same configuration `serve` uses.
 *
 *   twinny-server keys create <name> [--config <file>]
 *   twinny-server keys list           [--config <file>]
 *   twinny-server keys revoke <name|id> [--config <file>]
 *   twinny-server invites create <name> --url <gateway> [--config <file>]
 *   twinny-server usage [--since 7d] [--by key|model|key-model] [--config <file>]
 *   twinny-server license [set <token>|remove] [--config <file>]
 */
import fs from "node:fs"

import { messageOf } from "../common/errors"
import { providerRegistry } from "../extension/inference/registry"
import { FREE_SEATS, LicenseError } from "../licensing"
import { inviteLink } from "../protocol/types"

import { exportLines } from "./recording/export"
import { openRecordingStore, RecordingQuery } from "./recording/store"
import {
  DEFAULT_KEYS_FILE,
  DEFAULT_LICENSE_FILE,
  DEFAULT_RECORDING,
  DEFAULT_USAGE,
  GatewayConfigError,
  loadGatewayConfig
} from "./config"
import { INVITE_TTL_MS, invitesFileFor,InviteStore } from "./invites"
import { KeyStore } from "./keys"
import { describePlan, LicenseStore } from "./license"
import { EXIT_CODE } from "./serve"
import { parseSince, summarizeUsage, UsageTotals } from "./usage"

export const KEYS_HELP = `Usage: twinny-server keys <command> [--config <file>]

  create <name>      Make a key for a developer. The key is printed once and never stored.
    --admin          The key may also open the admin page (usage for everyone, keys, status).
    --read-only      With --admin: may look at everything on the admin page but change nothing.
  list               Show every key: id, name, created, status.
  revoke <name|id>   Stop a key. Requests with it are refused from then on, without a restart.

Pass --config when the configuration moves keys away from the default
(${DEFAULT_KEYS_FILE}).
`

export const INVITES_HELP = `Usage: twinny-server invites <command> [--config <file>]

  create <name>      Make an invite link for a developer. Opening it in VS Code connects them:
                     the key is made then, under this name, so an unopened invite holds no seat.
    --url <gateway>  The address developers reach the gateway at, e.g. https://ai.example.com.
                     Without it only the code is printed.
    --admin          The key it makes may also open the admin page.
    --replace        The key it makes replaces the active key of the same name (a lost key).
  list               Open invites: id, name, who made it, when it expires.
  withdraw <id>      Cancel an open invite.

An invite lasts ${INVITE_TTL_MS / 86_400_000} days and opens once. The code is printed once; only
its hash is kept, in invites.json next to the keys file.
`

export const USAGE_HELP = `Usage: twinny-server usage [options] [--config <file>]

  --since <period>   How far back: 7d (default), 24h, 30m, or a date such as 2026-09-01.
  --by <grouping>    key-model (default), key, or model.

Reads the per-day usage files (default ${DEFAULT_USAGE.dir}); the server
need not be running. Token counts are whatever the backends reported.
`

export const LICENSE_HELP = `Usage: twinny-server license [command] [--config <file>]

  (no command)       Show the plan, the seats in use, and the licence if one is installed.
  set <token>        Install a licence token (twl1.…). Takes effect without a restart.
  set --file <path>  Install the token read from a file.
  remove             Remove the licence; the gateway goes back to the free plan.

Seats are active access keys. Without a licence a gateway may have up to
${FREE_SEATS} of them. A licence raises that for its term; see
https://docs.twinny.dev/teams/licensing/. The token is kept at auth.licenseFile
(default ${DEFAULT_LICENSE_FILE}).
`

export interface AdminIo {
  out(line: string): void
  err(line: string): void
}

interface Paths {
  keysFile: string
  usageDir: string
  licenseFile: string
  recording: { dir: string; store: "auto" | "sqlite" | "jsonl" }
}

/** Takes `--config <file>` out of the arguments and resolves the paths it implies. */
const takeConfig = (argv: string[]): { rest: string[]; paths: Paths } => {
  const rest: string[] = []
  let configFile: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--config" || arg === "-c") {
      configFile = argv[++i]
      if (!configFile) throw new Error(`${arg} needs a file path.`)
    } else if (arg.startsWith("--config=")) {
      configFile = arg.slice("--config=".length)
    } else {
      rest.push(arg)
    }
  }
  if (!configFile) {
    return {
      rest,
      paths: {
        keysFile: DEFAULT_KEYS_FILE,
        usageDir: DEFAULT_USAGE.dir,
        licenseFile: DEFAULT_LICENSE_FILE,
        recording: { dir: DEFAULT_RECORDING.dir, store: DEFAULT_RECORDING.store }
      }
    }
  }
  const config = loadGatewayConfig(configFile, providerRegistry.providerIds())
  return {
    rest,
    paths: {
      keysFile: config.auth.keysFile,
      usageDir: config.usage.dir,
      licenseFile: config.auth.licenseFile,
      recording: { dir: config.recording.dir, store: config.recording.store }
    }
  }
}

const describeError = (error: unknown): string[] =>
  error instanceof GatewayConfigError
    ? [`Cannot read the configuration (${error.code}):`, ...error.problems.map((p) => `  - ${p}`)]
    : [messageOf(error)]

/* -------------------------------------------------------------------------- */
/*  Tables                                                                    */
/* -------------------------------------------------------------------------- */

const table = (header: string[], rows: string[][], rightAlign: number[] = []): string[] => {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (rightAlign.includes(i) ? cell.padStart(widths[i]) : cell.padEnd(widths[i])))
      .join("  ")
      .trimEnd()
  return [line(header), ...rows.map(line)]
}

const when = (iso: string) => iso.replace("T", " ").slice(0, 16)

/* -------------------------------------------------------------------------- */
/*  keys                                                                      */
/* -------------------------------------------------------------------------- */

export const runKeys = (argv: string[], io: AdminIo): number => {
  let rest: string[]
  let paths: Paths
  try {
    ({ rest, paths } = takeConfig(argv))
  } catch (error) {
    for (const line of describeError(error)) io.err(line)
    return EXIT_CODE.config
  }
  const [command, ...args] = rest
  if (!command || command === "--help" || command === "-h") {
    io.out(KEYS_HELP)
    return command ? EXIT_CODE.ok : EXIT_CODE.config
  }

  let store: KeyStore
  try {
    store = KeyStore.open(paths.keysFile)
  } catch (error) {
    io.err(messageOf(error))
    return EXIT_CODE.config
  }

  try {
    switch (command) {
      case "create": {
        const admin = args.includes("--admin")
        const readOnly = args.includes("--read-only")
        const names = args.filter((arg) => arg !== "--admin" && arg !== "--read-only")
        const name = names[0]
        if (!name || names.length > 1) throw new Error("keys create takes exactly one name.")
        const refusal = LicenseStore.open(paths.licenseFile).refuseNewKey(store.active())
        if (refusal) throw new Error(refusal)
        const { key, record } = store.create(name, { admin, readOnly })
        io.out(`Created ${admin ? "admin " : ""}key "${record.name}" (id ${record.id}) in ${store.file}.`)
        io.out("")
        io.out(`  ${key}`)
        io.out("")
        io.out("This is the only time it is shown; only its hash is kept. Give it to")
        io.out(`${record.name} to paste into the "Gateway token" field of a Twinny gateway provider.`)
        return EXIT_CODE.ok
      }
      case "list": {
        if (args.length) throw new Error("keys list takes no arguments.")
        const keys = store.list()
        if (!keys.length) {
          io.out(`No keys in ${store.file}. Create one with: twinny-server keys create <name>`)
          return EXIT_CODE.ok
        }
        const rows = keys.map((key) => [
          key.id,
          key.name,
          key.admin ? "admin" : "",
          when(key.createdAt),
          key.revokedAt ? `revoked ${when(key.revokedAt)}` : "active"
        ])
        for (const line of table(["ID", "NAME", "ROLE", "CREATED", "STATUS"], rows)) io.out(line)
        return EXIT_CODE.ok
      }
      case "revoke": {
        const target = args[0]
        if (!target || args.length > 1) throw new Error("keys revoke takes exactly one name or id.")
        const record = store.revoke(target)
        if (!record) throw new Error(`No active key named or numbered "${target}". See: twinny-server keys list`)
        io.out(`Revoked key "${record.name}" (id ${record.id}). Requests with it are refused from now on.`)
        return EXIT_CODE.ok
      }
      default:
        throw new Error(`Unknown keys command "${command}". Try: twinny-server keys --help`)
    }
  } catch (error) {
    io.err(messageOf(error))
    return EXIT_CODE.config
  }
}

/* -------------------------------------------------------------------------- */
/*  invites                                                                   */
/* -------------------------------------------------------------------------- */

export const runInvites = (argv: string[], io: AdminIo): number => {
  let rest: string[]
  let paths: Paths
  try {
    ({ rest, paths } = takeConfig(argv))
  } catch (error) {
    for (const line of describeError(error)) io.err(line)
    return EXIT_CODE.config
  }
  const [command, ...args] = rest
  if (!command || command === "--help" || command === "-h") {
    io.out(INVITES_HELP)
    return command ? EXIT_CODE.ok : EXIT_CODE.config
  }
  try {
    const invites = InviteStore.open(invitesFileFor(paths.keysFile))
    switch (command) {
      case "create": {
        const admin = args.includes("--admin")
        const replace = args.includes("--replace")
        const at = args.indexOf("--url")
        const url = at >= 0 ? args[at + 1] : undefined
        if (at >= 0 && !url) throw new Error("--url takes the gateway address, e.g. --url https://ai.example.com")
        const names = args.filter((arg, i) => !arg.startsWith("--") && i !== at + 1)
        const name = names[0]
        if (!name || names.length > 1) throw new Error("invites create takes exactly one name.")
        const keys = KeyStore.open(paths.keysFile)
        const seated = keys.active().filter((key) => !(replace && key.name === name))
        const refusal = LicenseStore.open(paths.licenseFile).refuseNewKey(seated)
        if (refusal) throw new Error(refusal)
        const { code, record } = invites.create(
          { name, admin, replace, createdBy: "cli" },
          (candidate) => keys.active().some((key) => key.name === candidate)
        )
        io.out(`Invite for "${record.name}"${admin ? " (admin)" : ""}${replace ? ", replacing their current key" : ""}; expires ${when(record.expiresAt)}.`)
        io.out("")
        if (url) {
          io.out(`Send ${record.name} this link. It opens VS Code and connects them:`)
          io.out("")
          io.out(`  ${inviteLink(url, code)}`)
          io.out("")
          io.out("For Cursor or VSCodium, replace vscode:// with cursor:// or vscodium://.")
        } else {
          io.out(`  ${code}`)
          io.out("")
          io.out("Pass --url <gateway address> to print the link to send instead of the bare code.")
        }
        io.out("Shown once; only its hash is kept. Withdraw it with: twinny-server invites withdraw " + record.id)
        return EXIT_CODE.ok
      }
      case "list": {
        if (args.length) throw new Error("invites list takes no arguments.")
        const open = invites.pending()
        if (!open.length) {
          io.out(`No open invites in ${invites.file}. Make one with: twinny-server invites create <name> --url <gateway>`)
          return EXIT_CODE.ok
        }
        const rows = open.map((invite) => [
          invite.id,
          invite.name,
          [invite.admin ? "admin" : "", invite.replace ? "replace" : ""].filter(Boolean).join(", "),
          invite.createdBy,
          when(invite.expiresAt)
        ])
        for (const line of table(["ID", "NAME", "FLAGS", "MADE BY", "EXPIRES"], rows)) io.out(line)
        return EXIT_CODE.ok
      }
      case "withdraw": {
        const id = args[0]
        if (!id || args.length > 1) throw new Error("invites withdraw takes exactly one id.")
        if (!invites.revoke(id)) throw new Error(`No open invite with id "${id}". See: twinny-server invites list`)
        io.out(`Withdrew invite ${id}. Opening its link now does nothing.`)
        return EXIT_CODE.ok
      }
      default:
        throw new Error(`Unknown invites command "${command}". Try: twinny-server invites --help`)
    }
  } catch (error) {
    io.err(messageOf(error))
    return EXIT_CODE.config
  }
}

/* -------------------------------------------------------------------------- */
/*  license                                                                   */
/* -------------------------------------------------------------------------- */

export const runLicense = (argv: string[], io: AdminIo, now = new Date()): number => {
  let rest: string[]
  let paths: Paths
  try {
    ({ rest, paths } = takeConfig(argv))
  } catch (error) {
    for (const line of describeError(error)) io.err(line)
    return EXIT_CODE.config
  }
  const [command, ...args] = rest
  if (command === "--help" || command === "-h") {
    io.out(LICENSE_HELP)
    return EXIT_CODE.ok
  }
  try {
    const keys = KeyStore.open(paths.keysFile)
    const license = LicenseStore.open(paths.licenseFile)
    const show = () => {
      const summary = license.summary(keys.active(), now)
      io.out(`Plan: ${describePlan(summary)}`)
      io.out(`  ${summary.message}`)
      if (summary.licenseId) io.out(`  licence id: ${summary.licenseId}${summary.email ? `, contact ${summary.email}` : ""}`)
      io.out(`  file: ${license.file}${license.installed ? "" : " (none installed)"}`)
      if (summary.unseated.length) {
        io.out(`  no seat (refused until seats are added or keys revoked): ${summary.unseated.join(", ")}`)
      }
    }
    switch (command) {
      case undefined:
        show()
        return EXIT_CODE.ok
      case "set": {
        let token: string
        if (args[0] === "--file") {
          if (!args[1] || args.length > 2) throw new Error("license set --file takes exactly one path.")
          token = fs.readFileSync(args[1], "utf8").trim()
        } else {
          if (!args[0] || args.length > 1) throw new Error("license set takes exactly one token, or --file <path>.")
          token = args[0].trim()
        }
        license.install(token)
        io.out(`Installed the licence in ${license.file}. A running gateway picks it up within a second.`)
        show()
        return EXIT_CODE.ok
      }
      case "remove": {
        if (args.length) throw new Error("license remove takes no arguments.")
        io.out(license.remove() ? `Removed ${license.file}. The gateway is on the free plan.` : `No licence was installed at ${license.file}.`)
        show()
        return EXIT_CODE.ok
      }
      default:
        throw new Error(`Unknown license command "${command}". Try: twinny-server license --help`)
    }
  } catch (error) {
    io.err(error instanceof LicenseError ? `Not installed: ${error.message}` : messageOf(error))
    return EXIT_CODE.config
  }
}

/* -------------------------------------------------------------------------- */
/*  recordings                                                                */
/* -------------------------------------------------------------------------- */

export const RECORDINGS_HELP = `Usage: twinny-server recordings <command> [options] [--config <file>]

  export             Write recorded requests as JSON lines to stdout.
    --route <r>      chat, fim or embeddings (default: all)
    --key <name>     One developer's key
    --since <period> 7d, 24h, or a date (default: everything)
    --format <f>     training (default: chat → messages, fim → prompt/suffix/completion) or raw
  stats              How many records there are, by route and key.

Reads the store the configuration names (recording.dir, recording.store); the
server need not be running. Recording itself needs a licence with the
recording feature and the routes switched on under recording in the config.
`

export const runRecordings = (argv: string[], io: AdminIo, now = new Date()): number => {
  let rest: string[]
  let paths: Paths
  try {
    ({ rest, paths } = takeConfig(argv))
  } catch (error) {
    for (const line of describeError(error)) io.err(line)
    return EXIT_CODE.config
  }
  const [command, ...args] = rest
  if (!command || command === "--help" || command === "-h") {
    io.out(RECORDINGS_HELP)
    return command ? EXIT_CODE.ok : EXIT_CODE.config
  }
  try {
    const query: RecordingQuery = {}
    let format: "training" | "raw" = "training"
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      const value = () => {
        const v = args[++i]
        if (!v) throw new Error(`${arg} needs a value.`)
        return v
      }
      if (arg === "--route") {
        const route = value()
        if (!["chat", "fim", "embeddings"].includes(route)) throw new Error("--route must be chat, fim or embeddings.")
        query.route = route as RecordingQuery["route"]
      } else if (arg === "--key") query.key = value()
      else if (arg === "--since") query.since = parseSince(value(), now)
      else if (arg === "--format") {
        const f = value()
        if (f !== "training" && f !== "raw") throw new Error("--format must be training or raw.")
        format = f
      } else throw new Error(`Unknown option ${arg}. Try: twinny-server recordings --help`)
    }
    const store = openRecordingStore(paths.recording.store, paths.recording.dir)
    try {
      switch (command) {
        case "export": {
          let n = 0
          for (const line of exportLines(store.each(query), format)) {
            io.out(line)
            n++
          }
          io.err(`${n} line${n === 1 ? "" : "s"} (${format}) from ${store.kind} at ${store.location}.`)
          return EXIT_CODE.ok
        }
        case "stats": {
          io.out(`${store.count()} recording${store.count() === 1 ? "" : "s"} in ${store.kind} at ${store.location}.`)
          for (const route of ["chat", "fim", "embeddings"] as const) io.out(`  ${route.padEnd(11)} ${store.count({ route })}`)
          for (const key of store.keys()) io.out(`  ${key.padEnd(11)} ${store.count({ key })}`)
          return EXIT_CODE.ok
        }
        default:
          throw new Error(`Unknown recordings command "${command}". Try: twinny-server recordings --help`)
      }
    } finally {
      store.close()
    }
  } catch (error) {
    io.err(messageOf(error))
    return EXIT_CODE.config
  }
}

/* -------------------------------------------------------------------------- */
/*  usage                                                                     */
/* -------------------------------------------------------------------------- */

type Grouping = "key" | "model" | "key-model"

const totalsRow = (totals: UsageTotals): string[] => [
  String(totals.requests),
  String(totals.ok),
  String(totals.failed),
  String(totals.cancelled),
  totals.counted ? String(totals.promptTokens) : "-",
  totals.counted ? String(totals.completionTokens) : "-",
  totals.requests ? String(Math.round(totals.ms / totals.requests)) : "-",
  totals.indexing.runs ? `${totals.indexing.runs} (${totals.indexing.calls} calls)` : "-"
]

const COUNT_HEADER = ["REQUESTS", "OK", "FAILED", "CANCELLED", "PROMPT TOK", "OUTPUT TOK", "AVG MS", "INDEX RUNS"]

export const runUsage = (argv: string[], io: AdminIo, now = new Date()): number => {
  let rest: string[]
  let paths: Paths
  try {
    ({ rest, paths } = takeConfig(argv))
  } catch (error) {
    for (const line of describeError(error)) io.err(line)
    return EXIT_CODE.config
  }

  let sinceText = "7d"
  let by: Grouping = "key-model"
  try {
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]
      if (arg === "--help" || arg === "-h") {
        io.out(USAGE_HELP)
        return EXIT_CODE.ok
      }
      if (arg === "--since") {
        sinceText = rest[++i] ?? ""
        if (!sinceText) throw new Error("--since needs a period.")
      } else if (arg.startsWith("--since=")) {
        sinceText = arg.slice("--since=".length)
      } else if (arg === "--by") {
        by = (rest[++i] ?? "") as Grouping
      } else if (arg.startsWith("--by=")) {
        by = arg.slice("--by=".length) as Grouping
      } else {
        throw new Error(`Unknown option ${arg}. Try: twinny-server usage --help`)
      }
    }
    if (!["key", "model", "key-model"].includes(by)) {
      throw new Error("--by must be key, model or key-model.")
    }
    const since = parseSince(sinceText, now)
    const summary = summarizeUsage(paths.usageDir, since, now)
    const { total } = summary

    io.out(
      `Usage since ${since.toISOString().slice(0, 16).replace("T", " ")} UTC (${sinceText}) from ${paths.usageDir}:`
    )
    io.out(
      `  ${total.requests} request${total.requests === 1 ? "" : "s"}: ${total.ok} ok, ${total.failed} failed, ${total.cancelled} cancelled` +
        (total.counted
          ? `; ${total.promptTokens} prompt and ${total.completionTokens} output tokens reported on ${total.counted}`
          : "; no token counts reported") +
        (total.indexing.runs
          ? `. ${total.indexing.runs} of the requests are indexing runs (${total.indexing.calls} embedding calls, counted once per run).`
          : "")
    )
    if (!total.requests) return EXIT_CODE.ok
    io.out("")

    const rows: string[][] = []
    const keyHeader = by === "model" ? [] : ["KEY"]
    const modelHeader = by === "key" ? [] : ["MODEL"]
    if (by === "key") {
      for (const [key, totals] of Object.entries(summary.byKey).sort()) rows.push([key, ...totalsRow(totals)])
    } else if (by === "model") {
      for (const [model, totals] of Object.entries(summary.byModel).sort()) rows.push([model, ...totalsRow(totals)])
    } else {
      for (const [key, models] of Object.entries(summary.byKeyAndModel).sort()) {
        for (const [model, totals] of Object.entries(models).sort()) rows.push([key, model, ...totalsRow(totals)])
      }
    }
    const header = [...keyHeader, ...modelHeader, ...COUNT_HEADER]
    const labels = keyHeader.length + modelHeader.length
    const right = COUNT_HEADER.map((_, i) => labels + i)
    for (const line of table(header, rows, right)) io.out(line)
    return EXIT_CODE.ok
  } catch (error) {
    io.err(messageOf(error))
    return EXIT_CODE.config
  }
}

/**
 * `twinny-server serve --config <file>`: the gateway as a process.
 *
 * Loads and validates the configuration, reads the token from the
 * environment, builds the route table, listens, and prints where. SIGINT
 * or SIGTERM drains and stops within the configured grace. Nothing secret
 * and nothing a request carried is ever printed.
 */
import path from "node:path"

import { messageOf } from "../common/errors"
import { providerRegistry } from "../extension/inference/registry"
import { REMOTE_PROTOCOL_BASE } from "../protocol/types"

import { gatewayInference } from "./plugins/inference"
import { Recorder } from "./recording/recorder"
import { openRecordingStore } from "./recording/store"
import { AuditLog } from "./audit"
import {
  DEFAULT_LIMITS,
  DEFAULT_LISTEN,
  DEFAULT_TOKEN_ENV,
  GatewayConfig,
  GatewayConfigError,
  hasTeamPool,
  loadGatewayConfig,
  readGatewaySecrets,
  TEAM_PROVIDER_KIND,
  teamWantedModels
} from "./config"
import { GatewayConfiguration } from "./configuration"
import { DATA_FORMAT, DataFormatError, openDataDir } from "./data-format"
import { DEFAULT_DEMO } from "./demo"
import { invitesFileFor,InviteStore } from "./invites"
import { KeyStore } from "./keys"
import { describePlan, LicenseStore } from "./license"
import { createGatewayLog, GatewayLog, LogFormat } from "./log"
import { GatewayMetrics } from "./metrics"
import { PeerRegistry } from "./peers"
import { BUNDLED_PLUGINS, PluginHost, pluginsFileFor, PluginStore } from "./plugins"
import { buildRouteTable } from "./routes"
import {
  ADMIN_PATH,
  describeProtocol,
  GatewayListenError,
  GatewayServer,
  HEALTH_PATH
} from "./server"
import { teamPoolAdapter } from "./team-pool"
import { decorateBanner, prettyLogLine, Tui } from "./tui"
import { UsageRecorder } from "./usage"
import { SERVER_VERSION } from "./version"

/** Why the process ended, for scripts that start it. */
export const EXIT_CODE = {
  ok: 0,
  failure: 1,
  /** Bad arguments or an invalid configuration file. */
  config: 2,
  /** A named environment variable (the token, a provider key) is not set. */
  missingEnv: 3,
  /** A provider kind the gateway cannot serve. */
  unsupportedProvider: 4,
  /** The port is taken or the host cannot be bound. */
  listen: 5,
  /** The data directory was written by a newer server, or its marker is unreadable. */
  data: 6
} as const

export const SERVE_HELP = `Twinny gateway — serve configured models to Twinny extensions over HTTP.

Usage: twinny-server serve --config <file> [options]

  -c, --config <file>   The gateway configuration (JSON). Required.
  -p, --port <number>   Listen on this port instead of the configuration's
      --host <address>  Listen on this address instead of the configuration's
      --demo            Public demo: the admin page opens read-only without a
                        key, and visitors get one-hour guest keys for VS Code
  -h, --help            Show this help

The TWINNY_PORT and TWINNY_HOST environment variables do the same as --port
and --host; the flags win.

Clients authenticate with a named access key (\`twinny-server keys create\`)
or the shared token from the environment variable the configuration names
(default ${DEFAULT_TOKEN_ENV}). Secrets are never in the file. Every
inference request is recorded, without its content, for \`twinny-server usage\`.
The gateway listens on ${DEFAULT_LISTEN.host}:${DEFAULT_LISTEN.port} unless
"listen" says otherwise. Binding another interface is explicit and exposes
the gateway to that network: put HTTPS in front of it.

Limits (defaults): ${DEFAULT_LIMITS.maxActiveRequests} active requests, ${DEFAULT_LIMITS.requestDeadlineMs / 1000}s per request,
${DEFAULT_LIMITS.maxBodyBytes / 1024 / 1024} MiB request bodies, ${DEFAULT_LIMITS.shutdownGraceMs / 1000}s to finish on SIGINT/SIGTERM.

Exit codes: ${EXIT_CODE.config} invalid arguments or configuration, ${EXIT_CODE.missingEnv} missing environment
variable, ${EXIT_CODE.unsupportedProvider} unsupported provider, ${EXIT_CODE.listen} could not listen.

See docs/gateway.md for the configuration format and a quickstart.
`

export interface ServeArgs {
  config: string
  port?: number
  host?: string
  demo?: boolean
}

const parsePort = (value: string | undefined, from: string): number => {
  const port = Number(value)
  if (!value || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`${from} needs a port number between 0 and 65535.`)
  return port
}

export const parseServeArgs = (argv: string[]): ServeArgs | "help" => {
  let config: string | undefined
  let port: number | undefined
  let host: string | undefined
  let demo = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case "--config":
      case "-c": {
        const value = argv[++i]
        if (value === undefined || value.startsWith("-"))
          throw new Error(`${arg} needs a file path.`)
        config = value
        break
      }
      case "--port":
      case "-p":
        port = parsePort(argv[++i], arg)
        break
      case "--host": {
        const value = argv[++i]
        if (value === undefined || value.startsWith("-"))
          throw new Error("--host needs an address.")
        host = value
        break
      }
      case "--demo":
        demo = true
        break
      case "--help":
      case "-h":
        return "help"
      default:
        if (arg.startsWith("--config=")) {
          config = arg.slice("--config=".length)
          break
        }
        if (arg.startsWith("--port=")) {
          port = parsePort(arg.slice("--port=".length), "--port")
          break
        }
        if (arg.startsWith("--host=") && arg.length > "--host=".length) {
          host = arg.slice("--host=".length)
          break
        }
        throw new Error(
          `Unknown option ${arg}. Try: twinny-server serve --help`
        )
    }
  }
  if (!config)
    throw new Error(
      "A configuration file is required: twinny-server serve --config <file>"
    )
  return {
    config,
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(demo ? { demo } : {})
  }
}

export interface ServeIo {
  out(line: string): void
  err(line: string): void
  env: NodeJS.ProcessEnv
  /** Where to listen for stop signals; the real process by default. */
  signals: Pick<NodeJS.Process, "on" | "off">
  log?: GatewayLog
  /** How log lines are rendered when `log` is not supplied; the machine format by default. */
  logFormat?: LogFormat
}

/**
 * The real process: the banner is coloured and the log is readable on a
 * terminal; on a pipe, under systemd or in a container both stay plain and
 * the log keeps its `name=value` format.
 */
export const defaultServeIo = (): ServeIo => {
  const tui = new Tui()
  const prettyLog = tui.colour && !!process.stderr.isTTY
  return {
    out: (line) => process.stdout.write(`${decorateBanner(tui, line)}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    signals: process,
    logFormat: prettyLog
      ? (level, fields) => prettyLogLine(tui, level, fields)
      : undefined
  }
}

export const codeForConfigError = (error: GatewayConfigError): number => {
  switch (error.code) {
    case "missing-env":
      return EXIT_CODE.missingEnv
    case "unsupported-provider":
      return EXIT_CODE.unsupportedProvider
    default:
      return EXIT_CODE.config
  }
}

const describeQueue = (queue: GatewayConfig["limits"]["queue"]): string =>
  queue.maxWaiting === 0
    ? "no queue"
    : `${queue.maxWaiting} waiting (fim ${queue.fimWaitMs}ms, chat ${Math.round(queue.chatWaitMs / 1000)}s)`

/** A short, secret-free account of what will be served. */
const describeConfig = (config: GatewayConfig): string[] => [
  `  protocol: ${describeProtocol()} at ${REMOTE_PROTOCOL_BASE}`,
  `  models:   ${config.models.length} alias${config.models.length === 1 ? "" : "es"} (${config.models
    .map((m) => `${m.alias}: ${m.capabilities.join("/")}`)
    .join(", ")})`,
  `  limits:   ${config.limits.maxActiveRequests} active, ${describeQueue(config.limits.queue)}, ${Math.round(config.limits.requestDeadlineMs / 1000)}s deadline, ${config.limits.shutdownGraceMs / 1000}s grace`,
  ...(hasTeamPool(config)
    ? [
        `  pooling:  teammates' computers may serve ${teamWantedModels(config).join(", ") || "(no aliases yet)"}`
      ]
    : [])
]

/**
 * Runs the gateway until it is told to stop. Resolves with the exit code;
 * the caller decides whether to exit the process with it.
 */
export const runServe = async (
  argv: string[],
  io: ServeIo = defaultServeIo()
): Promise<number> => {
  let args: ServeArgs | "help"
  try {
    args = parseServeArgs(argv)
  } catch (error) {
    io.err(messageOf(error))
    return EXIT_CODE.config
  }
  if (args === "help") {
    io.out(SERVE_HELP)
    return EXIT_CODE.ok
  }

  // Where to listen can come from the process, so one configuration serves
  // several instances behind a reverse proxy.
  let listen: { port?: number; host?: string }
  try {
    const envPort = io.env.TWINNY_PORT?.trim()
    listen = {
      port:
        args.port ?? (envPort ? parsePort(envPort, "TWINNY_PORT") : undefined),
      host: args.host ?? (io.env.TWINNY_HOST?.trim() || undefined)
    }
  } catch (error) {
    io.err(messageOf(error))
    return EXIT_CODE.config
  }
  const demo = args.demo ? DEFAULT_DEMO : undefined

  const log = io.log ?? createGatewayLog((line) => io.err(line), io.logFormat)
  let config: GatewayConfig
  let server: GatewayServer
  let keys: KeyStore
  let license: LicenseStore
  let usage: UsageRecorder
  let recorder: Recorder | undefined
  let sharedToken = false
  let peers: PeerRegistry
  let plugins: PluginHost
  try {
    // The pool is an adapter like any other, registered before the
    // configuration names it. Its registry fills in as teammates connect.
    let currentConfig: () => GatewayConfig = () => config
    let currentKeys: () => KeyStore = () => keys
    peers = new PeerRegistry({
      log,
      wanted: () => teamWantedModels(currentConfig()),
      configured: () => hasTeamPool(currentConfig()),
      keyActive: (name) => {
        const store = currentKeys()
        store.refresh()
        return store.active().some((record) => record.name === name)
      }
    })
    providerRegistry.register(TEAM_PROVIDER_KIND, teamPoolAdapter(peers))
    config = loadGatewayConfig(args.config, providerRegistry.providerIds())
    // The data directory is checked before any store opens: an older layout
    // is migrated first, a newer one is never touched.
    const opened = openDataDir(path.dirname(config.auth.keysFile), {
      server: SERVER_VERSION,
      log: (event, fields) => log.info({ event, ...fields })
    })
    if (opened.legacy || opened.migrated.length) {
      log.info({
        event: "data.format",
        code: opened.format,
        message: opened.migrated.length
          ? `Migrated the data directory to format ${opened.format}.`
          : `Marked the data directory as format ${opened.format}.`
      })
    }
    keys = KeyStore.open(config.auth.keysFile)
    license = LicenseStore.open(config.auth.licenseFile)
    const secrets = readGatewaySecrets(config, io.env, keys.active().length)
    sharedToken = !!secrets.token
    const routes = buildRouteTable(config, secrets, providerRegistry)
    usage = new UsageRecorder(config.usage.dir, config.usage.retentionDays)
    usage.start()
    const configuration = new GatewayConfiguration(
      args.config,
      config,
      routes,
      io.env
    )
    // After the configuration has compared itself with the file: where to
    // listen is this process's business and is never written back.
    config.listen = {
      host: listen.host ?? config.listen.host,
      port: listen.port ?? config.listen.port
    }
    currentConfig = () => configuration.current
    currentKeys = () => keys
    const licensedForRecording = () =>
      license.current().features.includes("recording")
    try {
      recorder = new Recorder({
        store: openRecordingStore(config.recording.store, config.recording.dir),
        settings: config.recording,
        licensed: licensedForRecording,
        log: (event, fields) => log.info({ event, ...fields })
      })
      recorder.start()
    } catch (error) {
      io.err(
        `Recording is unavailable: ${messageOf(error)}`
      )
      recorder = undefined
    }
    const invites = InviteStore.open(invitesFileFor(config.auth.keysFile))
    const audit = AuditLog.open(path.join(path.dirname(config.auth.keysFile), "audit"))
    const metrics = new GatewayMetrics()
    plugins = new PluginHost({
      plugins: BUNDLED_PLUGINS,
      store: PluginStore.open(pluginsFileFor(config.auth.keysFile)),
      dataDir: path.dirname(config.auth.keysFile),
      log,
      licensed: () => license.current().features.includes("plugins"),
      invites: { create: (input) => server.inviteFor(input) },
      health: async () =>
        (await server.routes.checkBackends()).backends.map((backend) => ({
          provider: backend.provider,
          ok: backend.ok,
          ...(backend.kind ? { kind: backend.kind } : {})
        })),
      paths: {
        configFile: args.config,
        dataDir: path.dirname(config.auth.keysFile),
        keysFile: config.auth.keysFile,
        licenseFile: config.auth.licenseFile,
        usageDir: config.usage.dir,
        recordingsDir: config.recording.dir
      },
      // Plugins use the gateway's own models through the same gate as a
      // developer's request, recorded under the plugin's name; `server`
      // exists before any plugin starts.
      inference: (id) =>
        gatewayInference({
          routes: () => server.routes,
          gate: () => server.gate,
          usage,
          principal: `plugin:${id}`
        })
    })
    server = new GatewayServer({
      config,
      token: secrets.token,
      keys,
      license,
      routes,
      log,
      usage,
      configuration,
      recorder,
      peers,
      invites,
      demo,
      plugins,
      audit,
      metrics,
      version: SERVER_VERSION
    })
    plugins.events.on((event) => metrics.pluginEvent(event.type))
  } catch (error) {
    if (error instanceof GatewayConfigError) {
      io.err(`Cannot start the gateway (${error.code}):`)
      for (const problem of error.problems) io.err(`  - ${problem}`)
      return codeForConfigError(error)
    }
    if (error instanceof DataFormatError) {
      io.err(`Cannot start the gateway (data-format): ${error.message}`)
      return EXIT_CODE.data
    }
    io.err(
      `Cannot start the gateway: ${messageOf(error)}`
    )
    return EXIT_CODE.failure
  }

  let address
  try {
    address = await server.start()
    plugins.start()
  } catch (error) {
    io.err(
      `Cannot start the gateway: ${messageOf(error)}`
    )
    return error instanceof GatewayListenError
      ? EXIT_CODE.listen
      : EXIT_CODE.failure
  }

  io.out(`Twinny gateway ${SERVER_VERSION} listening on ${address.url}`)
  for (const line of describeConfig(config)) io.out(line)
  io.out(`  health:   ${address.url}${HEALTH_PATH}`)
  io.out(
    demo
      ? `  admin:    ${address.url}${ADMIN_PATH} (DEMO: opens read-only without a key; admin keys still sign in)`
      : `  admin:    ${address.url}${ADMIN_PATH} (sign in with an admin key)`
  )
  if (demo) {
    io.out(
      `  demo:     guest keys last ${demo.guestTtlMs / 60_000} min and hold no seat; up to ${demo.maxGuests} guests, ${demo.invitesPerHour} invites per address an hour` +
        (config.limits.maxOutputTokens === undefined
          ? ""
          : `, ${config.limits.maxOutputTokens} output tokens a request`)
    )
    if (config.limits.maxOutputTokens === undefined || !config.limits.perKey) {
      io.out(
        "  note:     a public demo should set limits.maxOutputTokens and limits.perKey, or guests can spend freely on your backend."
      )
    }
  }
  const activeKeys = keys.active().length
  io.out(
    `  access:   ${activeKeys} active key${activeKeys === 1 ? "" : "s"}` +
      (sharedToken ? ", plus the shared token" : "")
  )
  const plan = license.summary(keys.active())
  io.out(`  plan:     ${describePlan(plan)}`)
  io.out(`  data:     ${path.dirname(config.auth.keysFile)} (format ${DATA_FORMAT})`)
  io.out(
    `  usage:    ${config.usage.dir} (kept ${config.usage.retentionDays} days)`
  )
  if (recorder) {
    const summary = recorder.summary()
    const on = (["chat", "fim", "embeddings"] as const).filter(
      (r) => summary.settings[r]
    )
    io.out(
      `  recording: ${summary.active.length ? summary.active.join(", ") : "off"}` +
        (on.length && !summary.licensed
          ? ` (${on.join(", ")} switched on; needs a licence with recording)`
          : "") +
        ` · ${summary.store.kind} at ${summary.store.location}, kept ${summary.settings.retentionDays} days`
    )
  }
  if (
    plan.status === "invalid" ||
    plan.status === "expiring" ||
    plan.status === "grace" ||
    plan.status === "expired"
  ) {
    io.out(`  note:     ${plan.message}`)
    log.warn({
      event: "license.notice",
      status: plan.status,
      seats: plan.seats,
      used: plan.used
    })
  }
  if (plan.unseated.length) {
    io.out(
      `  note:     ${plan.unseated.length} key${plan.unseated.length === 1 ? " has" : "s have"} no seat and will be refused: ${plan.unseated.join(", ")}.`
    )
    log.warn({ event: "license.unseated", keys: plan.unseated.length })
  }
  if (sharedToken && activeKeys > 0) {
    io.out(
      "  note:     the shared token is still accepted; set auth.tokenEnv to null once every developer has a key."
    )
    log.warn({ event: "auth.shared-token-active", keys: activeKeys })
  }
  if (address.host !== "127.0.0.1" && address.host !== "::1") {
    io.out(
      "  note:     bound to a non-loopback address; use HTTPS (a reverse proxy or tunnel) across untrusted networks."
    )
  }
  log.info({
    event: "gateway.started",
    host: address.host,
    port: address.port,
    protocol: describeProtocol(),
    models: config.models.length,
    keys: activeKeys,
    plan: plan.status,
    seats: plan.seats
  })

  // Whether the backends answer, printed after the banner so a slow one
  // never delays "listening". A backend that is down is not a config
  // error: its aliases fail per request until it is back.
  void server.routes.checkBackends().then(({ backends }) => {
    for (const backend of backends) {
      const pool =
        config.providers[backend.provider]?.provider === TEAM_PROVIDER_KIND
      io.out(
        pool
          ? `  backend:  ${backend.provider} is the team pool; ${peers.online()} computer(s) sharing so far.`
          : backend.ok
            ? `  backend:  ${backend.provider} answers (${backend.ms} ms)`
            : `  backend:  ${backend.provider} is not answering (${backend.kind}); its aliases will fail until it is.`
      )
      log.info({
        event: "backend.probe",
        provider: backend.provider,
        ok: backend.ok,
        kind: backend.kind,
        ms: backend.ms
      })
    }
  })

  return new Promise<number>((resolve) => {
    let stopping = false
    const stop = (signal: NodeJS.Signals) => {
      if (stopping) return
      stopping = true
      io.signals.off("SIGINT", stop)
      io.signals.off("SIGTERM", stop)
      log.info({
        event: "gateway.stopping",
        signal,
        active: server.active,
        grace: config.limits.shutdownGraceMs
      })
      // Whatever a backend does, the process ends: the grace, then the
      // second `stop()` allows itself, then a little more.
      const hard = setTimeout(() => {
        log.error({ event: "gateway.forced-exit" })
        resolve(EXIT_CODE.failure)
      }, config.limits.shutdownGraceMs + 3_000)
      hard.unref()
      void server
        .stop()
        .then(() => plugins.stop())
        .then(() => usage.stop())
        .then(() => recorder?.stop())
        .then(() => {
          clearTimeout(hard)
          log.info({ event: "gateway.stopped" })
          resolve(EXIT_CODE.ok)
        })
    }
    io.signals.on("SIGINT", stop)
    io.signals.on("SIGTERM", stop)
  })
}

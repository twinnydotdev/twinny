/**
 * `twinny-server quickstart`: a gateway with an admin in one command.
 *
 *   quickstart [--fresh] [--admin <name>] [--config <file>]
 *
 * Writes the starter configuration when there is none, makes an admin key
 * when there is none, prints both, and serves. `--fresh` first removes
 * everything the gateway keeps (keys, licence, usage, recordings and the
 * configuration file) so the next run starts from nothing.
 *
 * `reset` is the removal on its own, for a gateway you want to wipe
 * without starting it again.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { messageOf } from "../common/errors"
import { providerRegistry } from "../extension/inference/registry"

import { AdminIo } from "./admin"
import {
  DEFAULT_KEYS_FILE,
  DEFAULT_LICENSE_FILE,
  DEFAULT_RECORDING,
  DEFAULT_USAGE,
  GatewayConfigError,
  loadGatewayConfig,
  TEAM_PROVIDER_KIND
} from "./config"
import { candidatesFor, describeCandidate, describeModel, DiscoveredServer, discoverServers, localCandidates, ModelPick, pickModels, Role } from "./discover"
import { applyBackendOption, DEFAULT_CONFIG_FILE, PLACEHOLDER_MODELS, starterConfig, starterModels, StarterOptions } from "./init"
import { KEY_NAME_PATTERN, KeyStore } from "./keys"
import { LicenseStore } from "./license"
import { codeForConfigError, EXIT_CODE, runServe, ServeIo } from "./serve"
import { Choice, Tui, TuiCancelled } from "./tui"
import { SERVER_VERSION } from "./version"

export const QUICKSTART_HELP = `Usage: twinny-server quickstart [options]

Starts a gateway with an admin key in one go:

  1. finds the model server on this machine (Ollama, LM Studio, llama.cpp, QVAC,
     any OpenAI-compatible server), asks it which models it has, and writes
     ./${DEFAULT_CONFIG_FILE} with them, if there is none (on a terminal you pick)
  2. makes an admin key if there is none, and prints it once
  3. serves; the banner shows the admin page address

  -c, --config <file>      Configuration to write or use (default ./${DEFAULT_CONFIG_FILE})
  --admin <name>           Name for the admin key (default: your username)
  -y, --yes                Take every default without asking
  --fresh                  First remove keys, licence, usage, recordings and the
                           configuration file, so this is a new gateway. Nothing
                           else is touched. Stop a running gateway first.
  --host <addr>            Interface to listen on, when writing the configuration
  --backend [kind=]host[:port]
                           Ask this server instead of looking: lmstudio=10.0.0.5,
                           llamacpp=gpu-box:8080, http://host:8000 (OpenAI-compatible), …
  --ollama <host[:port]>   Short for --backend ollama=host[:port]
  -h, --help               Show this help

The key is shown once. Open the admin page with it, then approve sign-in
requests from VS Code (Providers → Connect to team) or make keys under People.
`

export const RESET_HELP = `Usage: twinny-server reset --yes [--config <file>] [--all]

Removes what the gateway keeps on disk: the keys file, the licence, usage
records and recordings. Without --yes it only lists what would go.

  --yes                 Actually remove the files
  -c, --config <file>   Find the files where this configuration keeps them
                        (default: ${DEFAULT_KEYS_FILE} and beside it)
  --all                 Also remove the configuration file itself
  -h, --help            Show this help

Stop a running gateway first. Every key stops working; developers need a
new one. For a new gateway in one command, see: twinny-server quickstart --fresh
`

interface GatewayFiles {
  configFile: string
  keysFile: string
  licenseFile: string
  usageDir: string
  recordingsDir: string
}

const KNOWN_PROVIDERS = () => [...providerRegistry.providerIds(), TEAM_PROVIDER_KIND]

/**
 * Where a configuration keeps its files, or the defaults when it does not
 * exist or cannot be read (a broken file still has to be removable).
 */
const filesFor = (configFile: string): GatewayFiles => {
  const fallback: GatewayFiles = {
    configFile,
    keysFile: DEFAULT_KEYS_FILE,
    licenseFile: DEFAULT_LICENSE_FILE,
    usageDir: DEFAULT_USAGE.dir,
    recordingsDir: DEFAULT_RECORDING.dir
  }
  if (!fs.existsSync(configFile)) return fallback
  try {
    const config = loadGatewayConfig(configFile, KNOWN_PROVIDERS())
    return {
      configFile,
      keysFile: config.auth.keysFile,
      licenseFile: config.auth.licenseFile,
      usageDir: config.usage.dir,
      recordingsDir: config.recording.dir
    }
  } catch {
    return fallback
  }
}

/** Removes a file or directory if present; says whether anything was there. */
const removeIfPresent = (target: string): boolean => {
  if (!fs.existsSync(target)) return false
  fs.rmSync(target, { recursive: true, force: true })
  return true
}

const describeFiles = (files: GatewayFiles, includeConfig: boolean): Array<[string, string]> => [
  ["keys", files.keysFile],
  ["licence", files.licenseFile],
  ["usage", files.usageDir],
  ["recordings", files.recordingsDir],
  ...(includeConfig ? ([["configuration", files.configFile]] as Array<[string, string]>) : [])
]

/** Removes the gateway's files and reports each one. */
const wipe = (files: GatewayFiles, includeConfig: boolean, io: AdminIo): void => {
  let removed = 0
  for (const [what, target] of describeFiles(files, includeConfig)) {
    if (removeIfPresent(target)) {
      removed++
      io.out(`Removed ${what}: ${target}`)
    }
  }
  if (!removed) io.out("Nothing to remove; the gateway had no files on disk.")
}

const describeError = (error: unknown): string[] =>
  error instanceof GatewayConfigError
    ? [`Cannot read the configuration (${error.code}):`, ...error.problems.map((p) => `  - ${p}`)]
    : [messageOf(error)]

/* -------------------------------------------------------------------------- */
/*  reset                                                                     */
/* -------------------------------------------------------------------------- */

export const runReset = (argv: string[], io: AdminIo, cwd = process.cwd()): number => {
  let configFile: string | undefined
  let yes = false
  let all = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") {
      io.out(RESET_HELP)
      return EXIT_CODE.ok
    }
    if (arg === "--yes" || arg === "-y") yes = true
    else if (arg === "--all") all = true
    else if (arg === "--config" || arg === "-c") {
      configFile = argv[++i]
      if (!configFile || configFile.startsWith("-")) {
        io.err(`${arg} needs a file path.`)
        return EXIT_CODE.config
      }
    } else if (arg.startsWith("--config=")) configFile = arg.slice("--config=".length)
    else {
      io.err(`Unknown option ${arg}. Try: twinny-server reset --help`)
      return EXIT_CODE.config
    }
  }
  const files = filesFor(path.resolve(cwd, configFile || DEFAULT_CONFIG_FILE))
  if (all && !configFile && !fs.existsSync(files.configFile)) {
    // Nothing named and nothing in the working directory: --all has no target.
    io.err(`--all removes the configuration file, but there is no ${DEFAULT_CONFIG_FILE} here; pass --config <file>.`)
    return EXIT_CODE.config
  }
  if (!yes) {
    io.out("Would remove:")
    for (const [what, target] of describeFiles(files, all)) {
      io.out(`  ${what.padEnd(13)} ${target}${fs.existsSync(target) ? "" : "  (not there)"}`)
    }
    io.out("")
    io.out("Add --yes to remove them. Every key stops working; stop a running gateway first.")
    return EXIT_CODE.config
  }
  try {
    wipe(files, all, io)
    return EXIT_CODE.ok
  } catch (error) {
    io.err(messageOf(error))
    return EXIT_CODE.failure
  }
}


/* -------------------------------------------------------------------------- */
/*  quickstart                                                                */
/* -------------------------------------------------------------------------- */

interface QuickstartArgs {
  configFile: string
  admin?: string
  fresh: boolean
  /** Take every default without asking, even on a terminal. */
  yes: boolean
  starter: StarterOptions
}

const parseQuickstartArgs = (argv: string[], cwd: string): QuickstartArgs | "help" => {
  let configFile: string | undefined
  let admin: string | undefined
  let fresh = false
  let yes = false
  const starter: StarterOptions = {}
  const value = (arg: string, i: number): string => {
    const next = argv[i]
    if (next === undefined || next.startsWith("-") || /\s/.test(next)) throw new Error(`${arg} needs a value.`)
    return next
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case "--help":
      case "-h":
        return "help"
      case "--fresh":
        fresh = true
        break
      case "--yes":
      case "-y":
        yes = true
        break
      case "--config":
      case "-c":
        configFile = value(arg, ++i)
        break
      case "--admin":
        admin = value(arg, ++i)
        break
      case "--host":
        starter.host = value(arg, ++i)
        break
      case "--ollama":
      case "--backend":
        applyBackendOption(starter, arg, value(arg, ++i))
        break
      default:
        if (arg.startsWith("--config=")) {
          configFile = arg.slice("--config=".length)
          break
        }
        throw new Error(`Unknown option ${arg}. Try: twinny-server quickstart --help`)
    }
  }
  if (admin !== undefined && !KEY_NAME_PATTERN.test(admin)) {
    throw new Error(`"${admin}" is not a valid key name: letters, digits, . _ @ - and up to 64 characters.`)
  }
  return { configFile: path.resolve(cwd, configFile || DEFAULT_CONFIG_FILE), admin, fresh, yes, starter }
}

/** The OS user as a key name, or "admin" when it does not fit. */
export const defaultAdminName = (): string => {
  let name = ""
  try {
    name = os.userInfo().username
  } catch {
    name = ""
  }
  return KEY_NAME_PATTERN.test(name) ? name : "admin"
}

const ROLE_LABEL: Record<Role, string> = { chat: "Chat model", fim: "Autocomplete model", embeddings: "Embedding model" }
const ROLE_WHY: Record<Role, string> = {
  chat: "answers in the sidebar; an instruct model",
  fim: "fills in code as people type; a code model, base variants are best",
  embeddings: "indexes the workspace for search; an embedding model"
}

/**
 * Finds the model servers (or asks the one named with --backend), settles
 * on one, then on a model per role: asked on a terminal, best guess
 * otherwise. `undefined` for a role means "leave the placeholder", which
 * the admin page can fix later. The chosen server becomes the starter's
 * backend, so the file points at whatever answered.
 */
const chooseModels = async (tui: Tui, starter: StarterOptions, yes: boolean): Promise<{ pick: ModelPick; server?: DiscoveredServer }> => {
  const named = starter.backend
  const candidates = named ? [named] : localCandidates()
  const busy = tui.spinner(named ? `Asking ${describeCandidate(named)} for its models` : "Looking for a model server on this machine (Ollama, LM Studio, llama.cpp, QVAC, …)")
  const result = await discoverServers(candidates)
  if (!result.servers.length) {
    busy.done(
      "warn",
      named ? `${describeCandidate(named)} did not answer with a model list.` : "No model server answered on the usual ports.",
      "Placeholder model names go in the file for now."
    )
    tui.step("info", "Start your model server and load a model, then pick it on the admin page under Providers & models.")
    return { pick: {} }
  }
  let server = result.servers[0]
  if (result.servers.length > 1 && !yes && tui.interactive) {
    server = await tui.select(
      "Which server should the gateway serve?",
      result.servers.map((s) => ({ label: describeCandidate(s), hint: `${s.models.length} model${s.models.length === 1 ? "" : "s"}`, value: s })),
      0
    )
    busy.done("ok", `${describeCandidate(server)} answers`, `${server.models.length} model${server.models.length === 1 ? "" : "s"}; ${result.servers.length} servers found`)
  } else {
    const others = result.servers.length > 1 ? `; also ${result.servers.slice(1).map(describeCandidate).join(", ")}` : ""
    busy.done("ok", `${describeCandidate(server)} answers`, `${server.models.length} model${server.models.length === 1 ? "" : "s"}, ${result.ms} ms${others}`)
  }
  starter.backend = { provider: server.provider, apiHostname: server.apiHostname, apiPort: server.apiPort, apiProtocol: server.apiProtocol }
  const guess = pickModels(server.models)
  if (yes || !tui.interactive) {
    for (const role of ["chat", "fim", "embeddings"] as Role[]) {
      const chosen = guess[role]
      tui.step(chosen ? "ok" : "warn", ROLE_LABEL[role], chosen ?? `none of them fits; placeholder ${PLACEHOLDER_MODELS[role]} kept`)
    }
    return { pick: guess, server }
  }
  const pick: ModelPick = {}
  for (const role of ["chat", "fim", "embeddings"] as Role[]) {
    const fitting = candidatesFor(server.models, role)
    const others = server.models.filter((m) => !fitting.includes(m))
    const choices: Array<Choice<string | undefined>> = [
      ...fitting.map((m, i) => ({ label: m, hint: [i === 0 ? "recommended" : "", describeModel(m)].filter(Boolean).join(", "), value: m as string | undefined })),
      ...others.map((m) => ({ label: m, hint: describeModel(m) || "unlikely for this", value: m as string | undefined })),
      { label: "Skip for now", hint: `keeps the placeholder ${PLACEHOLDER_MODELS[role]}; change it on the admin page`, value: undefined }
    ]
    tui.line(`    ${tui.c.dim(ROLE_WHY[role])}`)
    pick[role] = await tui.select(ROLE_LABEL[role], choices, 0)
  }
  return { pick, server }
}

/**
 * Prepares the files, then serves. Resolves with the exit code, like
 * `runServe`; the key is printed before the server banner so it is the
 * first thing on screen.
 */
export const runQuickstart = async (argv: string[], io: ServeIo, cwd = process.cwd(), tui: Tui = new Tui()): Promise<number> => {
  let args: QuickstartArgs | "help"
  try {
    args = parseQuickstartArgs(argv, cwd)
  } catch (error) {
    io.err(messageOf(error))
    return EXIT_CODE.config
  }
  if (args === "help") {
    io.out(QUICKSTART_HELP)
    return EXIT_CODE.ok
  }
  const shown = path.relative(cwd, args.configFile) || args.configFile
  const c = tui.c

  try {
    tui.title(`twinny-server ${SERVER_VERSION}`, "quickstart")
    if (args.fresh) wipe(filesFor(args.configFile), true, io)

    if (fs.existsSync(args.configFile)) {
      tui.step("ok", `Loading ${shown}`, args.configFile)
      if (args.starter.host || args.starter.backend) {
        tui.step("info", "--host and --backend only apply when the configuration is written; edit the file instead.")
      }
    } else {
      const { pick, server } = await chooseModels(tui, args.starter, args.yes)
      const found = !!server
      const models = starterModels(pick)
      fs.mkdirSync(path.dirname(args.configFile), { recursive: true })
      fs.writeFileSync(args.configFile, starterConfig({ ...args.starter, models }), { flag: "wx" })
      const placeholders = (["chat", "fim", "embeddings"] as Role[]).filter((role) => !pick[role])
      tui.step(
        "ok",
        `Wrote ${shown}`,
        `${args.configFile} ${tui.g.bullet} ${models.length} aliases: ${models.map((m) => `${m.alias} (${m.capabilities.join("/")})`).join(", ")}`
      )
      if (found && placeholders.length) {
        tui.step("info", `Placeholder model names kept for ${placeholders.join(", ")}; change them on the admin page under Providers & models.`)
      } else if (!found) {
        tui.step("info", "Its model names are placeholders: change them on the admin page under Providers & models, or in the file.")
      }
    }

    const config = loadGatewayConfig(args.configFile, KNOWN_PROVIDERS())
    tui.step(
      "ok",
      `Serving ${config.models.length} alias${config.models.length === 1 ? "" : "es"} from ${Object.keys(config.providers).length} backend${Object.keys(config.providers).length === 1 ? "" : "s"}`,
      Object.entries(config.providers)
        .map(([name, p]) => `${name}: ${p.provider}${p.apiHostname ? ` at ${p.apiHostname}${p.apiPort ? `:${p.apiPort}` : ""}` : ""}`)
        .join(", ")
    )
    tui.step("ok", "Keys, usage and licence", `${path.dirname(config.auth.keysFile)} (keys.json, usage/, license)`)
    const keys = KeyStore.open(config.auth.keysFile)
    const admins = keys.active().filter((key) => key.admin)
    if (admins.length) {
      tui.step("ok", `Admin key${admins.length === 1 ? "" : "s"} already present: ${admins.map((k) => k.name).join(", ")}.`, "Sign in with it, or start over with --fresh.")
      io.out("")
    } else {
      const refusal = LicenseStore.open(config.auth.licenseFile).refuseNewKey(keys.active())
      if (refusal) throw new Error(refusal)
      const validate = (value: string) => (KEY_NAME_PATTERN.test(value) ? undefined : "Letters, digits, . _ @ - and up to 64 characters.")
      const name = args.admin ?? (args.yes ? defaultAdminName() : await tui.input("Admin key name", defaultAdminName(), validate))
      const { key, record } = keys.create(name, { admin: true })
      io.out("")
      io.out(`Admin key for "${record.name}" (shown once; only its hash is kept in ${keys.file}):`)
      io.out("")
      tui.box([c.bold(c.accent(key)), "", c.dim("Shown once. Sign in to the admin page with it, and keep it somewhere safe.")], "Admin key")
      io.out("")
    }
    const address = `http://${config.listen.host === "0.0.0.0" ? "<this machine>" : config.listen.host}:${config.listen.port || "<port>"}`
    tui.line(`  ${c.bold("Next")}`)
    tui.line(`    1. Open ${c.accent(`${address}/admin`)} and sign in with the admin key.`)
    tui.line(`    2. Check ${c.bold("Providers & models")}: the backend should say answering, and the team defaults name real models.`)
    tui.line(`    3. Under ${c.bold("People")}, make an invite link per developer. Opening it in VS Code connects them; nothing is pasted.`)
    io.out("")
  } catch (error) {
    if (error instanceof TuiCancelled) {
      io.err("Cancelled; nothing else was changed.")
      return EXIT_CODE.config
    }
    if (error instanceof GatewayConfigError) {
      for (const line of describeError(error)) io.err(line)
      return codeForConfigError(error)
    }
    io.err(messageOf(error))
    return EXIT_CODE.config
  }

  return runServe(["--config", args.configFile], io)
}

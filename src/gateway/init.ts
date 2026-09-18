/**
 * `twinny-server init [file]`: writes a starter configuration to edit.
 *
 * The starter points at one model server (an Ollama on this machine unless
 * told otherwise) and serves one chat alias, one autocomplete (FIM) alias
 * and one embedding alias. Model names are placeholders the person replaces
 * with what they have, unless quickstart discovered real ones and passes
 * them in.
 */
import fs from "node:fs"
import path from "node:path"

import { API_PROVIDERS, PROVIDER_DISPLAY_NAMES } from "../common/constants"
import { LocalServerCandidate } from "../common/provider-discovery"

import { DEFAULT_LIMITS, DEFAULT_LISTEN, DEFAULT_TOKEN_ENV } from "./config"
import { parseBackendOption } from "./discover"

export const DEFAULT_CONFIG_FILE = "twinny.gateway.json"

/** Where the starter points when nothing was found or named. */
export const DEFAULT_BACKEND: LocalServerCandidate = { provider: API_PROVIDERS.Ollama, apiHostname: "127.0.0.1", apiPort: 11434, apiProtocol: "http" }

/** Real Ollama tags that do the job, for a file written blind. */
export const PLACEHOLDER_MODELS = {
  chat: "qwen2.5-coder:7b",
  fim: "codellama:7b-code",
  embeddings: "nomic-embed-text"
} as const

export interface StarterModel {
  alias: string
  model: string
  capabilities: Array<"chat" | "fim" | "embeddings">
}

export interface StarterOptions {
  /** Interface to listen on; `0.0.0.0` inside a container. */
  host?: string
  /** The server to point at; the compose service name inside a container. */
  backend?: LocalServerCandidate
  /** Aliases to write instead of the placeholders. */
  models?: StarterModel[]
}

/** The provider entry's name in the file: `local-ollama`, `local-lmstudio`, … */
export const providerNameFor = (backend: LocalServerCandidate): string => `local-${backend.provider}`

/** The aliases quickstart writes for a set of chosen models; placeholders where nothing was chosen. */
export const starterModels = (pick: { chat?: string; fim?: string; embeddings?: string } = {}): StarterModel[] => {
  const chat = pick.chat ?? PLACEHOLDER_MODELS.chat
  const fim = pick.fim ?? PLACEHOLDER_MODELS.fim
  const embeddings = pick.embeddings ?? PLACEHOLDER_MODELS.embeddings
  const models: StarterModel[] = []
  if (chat === fim) models.push({ alias: "coder", model: chat, capabilities: ["chat", "fim"] })
  else {
    models.push({ alias: "chat", model: chat, capabilities: ["chat"] })
    models.push({ alias: "coder", model: fim, capabilities: ["fim"] })
  }
  models.push({ alias: "embed", model: embeddings, capabilities: ["embeddings"] })
  return models
}

/** Which alias serves each team role, from the aliases' capabilities. */
const teamDefaultsFor = (models: StarterModel[]) => ({
  chat: models.find((m) => m.capabilities.includes("chat"))?.alias,
  fim: models.find((m) => m.capabilities.includes("fim"))?.alias,
  embeddings: models.find((m) => m.capabilities.includes("embeddings"))?.alias
})

/** The example configuration, secret-free, as JSON text. */
export const starterConfig = (options: StarterOptions = {}): string => {
  const backend = options.backend ?? DEFAULT_BACKEND
  const name = providerNameFor(backend)
  const models = (options.models ?? starterModels()).map((m) => ({
    alias: m.alias,
    provider: name,
    model: m.model,
    capabilities: m.capabilities
  }))
  const defaults = teamDefaultsFor(options.models ?? starterModels())
  return `${JSON.stringify(
    {
      listen: { host: options.host ?? DEFAULT_LISTEN.host, port: DEFAULT_LISTEN.port },
      auth: { tokenEnv: DEFAULT_TOKEN_ENV },
      providers: {
        [name]: {
          provider: backend.provider,
          apiProtocol: backend.apiProtocol,
          apiHostname: backend.apiHostname,
          apiPort: backend.apiPort
        }
      },
      models,
      teamDefaults: Object.fromEntries(Object.entries(defaults).filter(([, alias]) => alias)),
      limits: { ...DEFAULT_LIMITS }
    },
    null,
    2
  )}\n`
}

export const STARTER_CONFIG = starterConfig()

export const INIT_HELP = `Usage: twinny-server init [file] [--host <addr>] [--backend [kind=]host[:port]]

Writes a starter configuration (default: ./${DEFAULT_CONFIG_FILE}) that serves
one model server, an Ollama on this machine unless --backend says otherwise.
Edit the model names, then start the server. An existing file is never
overwritten. (twinny-server quickstart does this and asks the server which
models it has.)

  --host <addr>                 Interface to listen on (default ${DEFAULT_LISTEN.host}; 0.0.0.0 in a container)
  --backend [kind=]host[:port]  The server to point at: lmstudio=10.0.0.5, llamacpp=gpu-box:8080,
                                qvac=127.0.0.1:11435, http://host:8000 (OpenAI-compatible), …
  --ollama <host[:port]>        Short for --backend ollama=host[:port] (the service name under Docker Compose)
`

export interface InitResult {
  file: string
  /** Lines to show the person afterwards. */
  next: string[]
}

/** `--backend [kind=]host[:port]`, or `--ollama host[:port]` as the Ollama shorthand. */
export const applyBackendOption = (options: StarterOptions, flag: "--backend" | "--ollama", value: string): void => {
  options.backend = parseBackendOption(value, flag === "--ollama" ? API_PROVIDERS.Ollama : undefined)
}

export const describeBackend = (backend: LocalServerCandidate): string =>
  `${PROVIDER_DISPLAY_NAMES[backend.provider] || backend.provider} at ${backend.apiHostname}:${backend.apiPort}`

export const runInit = (argv: string[], cwd = process.cwd()): InitResult | "help" => {
  let target: string | undefined
  const options: StarterOptions = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") return "help"
    if (arg === "--host" || arg === "--ollama" || arg === "--backend") {
      const value = argv[++i]
      if (!value || value.startsWith("-") || /\s/.test(value)) throw new Error(`${arg} needs a value.`)
      if (arg === "--host") options.host = value
      else applyBackendOption(options, arg, value)
      continue
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}. Try: twinny-server init --help`)
    if (target) throw new Error("init takes at most one file path.")
    target = arg
  }
  const file = path.resolve(cwd, target || DEFAULT_CONFIG_FILE)
  if (fs.existsSync(file)) {
    throw new Error(`${file} already exists; edit it, or pass another path.`)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, starterConfig(options), { flag: "wx" })
  const shown = path.relative(cwd, file) || file
  return {
    file,
    next: [
      `Wrote ${shown}.`,
      "",
      "Next:",
      `  1. Edit ${shown}: set "model" for each alias to a model ${describeBackend(options.backend ?? DEFAULT_BACKEND)} has`,
      "     (the admin page lists them and can pick them for you later).",
      "  2. Make your admin key:  twinny-server keys create you --admin",
      `  3. Start the server:     twinny-server serve --config ${shown}`,
      "  4. In VS Code: Twinny → Providers → Connect to team, then Request a key;",
      "     approve the code on the admin page under People."
    ]
  }
}

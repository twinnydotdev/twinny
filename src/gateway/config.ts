/**
 * The gateway's configuration file, read and judged before anything
 * listens. One file holds everything: where to listen, which environment
 * variable carries the access token, the backends, the public model
 * aliases that map onto them, and the limits.
 *
 * Secrets never appear in the file. The token and any provider API key
 * are named by environment variable and read from the environment here,
 * in these fields only; nothing else is expanded, and nothing is executed.
 *
 * Pure: no networking. A configuration that passes here can still point
 * at a backend that is down; that is a runtime failure, not a config one.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { providerForBackend } from "../common/backend-route"
import { API_PROVIDERS, DEFAULT_GATEWAY_PORT } from "../common/constants"
import { validateProvider } from "../common/provider-validation"
import { TwinnyProvider } from "../common/types"
import { InferenceCapability } from "../extension/inference/types"
import type { TeamDefaults, TeamPolicy, TeamTemplate } from "../protocol/types"
import { isInferenceCapability } from "../protocol/wire"

import type { Quota, QuotasPolicy, RoutingRule } from "./quotas"

export type GatewayConfigProblem =
  | "invalid-config"
  | "missing-env"
  | "unsupported-provider"

export class GatewayConfigError extends Error {
  constructor(
    public readonly code: GatewayConfigProblem,
    public readonly problems: string[]
  ) {
    super(problems.join("\n"))
    this.name = "GatewayConfigError"
  }
}

export interface GatewayListen {
  host: string
  port: number
}

export interface GatewayProviderConfig {
  /** The adapter kind: `ollama`, `lmstudio`, `openai-compatible`, `openai`… */
  provider: string
  apiHostname?: string
  apiPort?: number
  apiProtocol?: string
  /** The environment variable holding the backend's API key, if it wants one. */
  apiKeyEnv?: string
  /** The route for each job; the adapter's usual route when unset. */
  paths?: Partial<Record<InferenceCapability, string>>
}

export interface GatewayModelConfig {
  /** The public name clients ask for. */
  alias: string
  /** A key of `providers`. */
  provider: string
  /** The backend's own name for the model. */
  model: string
  capabilities: InferenceCapability[]
  contextWindow?: number
}

export interface PerKeyLimits {
  /** Inference requests one key may have running at once. */
  maxActiveRequests?: number
  /** Inference requests one key may start within any 60 seconds. */
  requestsPerMinute?: number
}

export interface GatewayLimits {
  /** Inference requests running at once; more are refused, not queued. */
  maxActiveRequests: number
  /** Limits applied per access key (the shared token counts as one key). */
  perKey?: PerKeyLimits
  /** How long one inference request may run before it is aborted. */
  requestDeadlineMs: number
  /** The largest request body accepted. */
  maxBodyBytes: number
  /** The most tokens one fim or chat request may generate, whatever it asks for. */
  maxOutputTokens?: number
  /** How long active requests get to finish after a stop signal. */
  shutdownGraceMs: number
}

export interface GatewayAuth {
  /**
   * The environment variable holding the shared token, or `null` once
   * every developer has a key of their own and the shared token is retired.
   */
  tokenEnv: string | null
  /** Where named access keys live (hashes only). */
  keysFile: string
  /** Where the licence token lives; absent file means the free plan. */
  licenseFile: string
}

export interface GatewayUsageConfig {
  /** Where the per-day usage files go. */
  dir: string
  /** Files older than this are deleted. */
  retentionDays: number
}

export interface GatewayRecordingConfig {
  chat: boolean
  fim: boolean
  embeddings: boolean
  retentionDays: number
  dir: string
  store: "auto" | "sqlite" | "jsonl"
}

export interface GatewayConfig {
  teamDefaults?: TeamDefaults
  /** Sent to connected developers when the licence allows it. */
  policy?: GatewayPolicy
  /** Which request content to keep; recorded only with the `recording` licence feature. */
  recording: GatewayRecordingConfig
  listen: GatewayListen
  auth: GatewayAuth
  providers: Record<string, GatewayProviderConfig>
  models: GatewayModelConfig[]
  limits: GatewayLimits
  usage: GatewayUsageConfig
}

/** What the environment supplied. Kept apart from the config so it is never printed with it. */
export interface GatewaySecrets {
  /** The shared token, when one is configured and set. */
  token?: string
  providerKeys: Record<string, string | undefined>
}

export const DEFAULT_LIMITS: GatewayLimits = {
  maxActiveRequests: 4,
  requestDeadlineMs: 120_000,
  maxBodyBytes: 8 * 1024 * 1024,
  shutdownGraceMs: 5_000
}

export const DEFAULT_LISTEN: GatewayListen = {
  host: "127.0.0.1",
  port: DEFAULT_GATEWAY_PORT
}

export const DEFAULT_TOKEN_ENV = "TWINNY_GATEWAY_TOKEN"

/** Where keys and usage live unless the configuration says otherwise. */
/** What the configuration may say under `policy`: what extensions enforce, plus what only the gateway enforces. */
export interface GatewayPolicy extends TeamPolicy {
  quotas?: QuotasPolicy
  routing?: RoutingRule[]
}

/** The part of the policy connected extensions are told; quotas and routing stay on the gateway. */
export const policyForExtensions = (policy: GatewayPolicy | undefined): TeamPolicy | undefined => {
  if (!policy) return undefined
  const { quotas: _quotas, routing: _routing, ...shared } = policy
  void _quotas
  void _routing
  return Object.keys(shared).length ? shared : undefined
}

const parseQuota = (value: unknown, where: string, problems: { add(message: string): void; unknownKeys(where: string, value: Record<string, unknown>, keys: string[]): void }): Quota | undefined => {
  if (!isRecord(value)) {
    problems.add(`${where} must be an object with requestsPerDay and/or tokensPerDay.`)
    return undefined
  }
  problems.unknownKeys(where, value, ["requestsPerDay", "tokensPerDay"])
  const quota: Quota = {}
  for (const field of ["requestsPerDay", "tokensPerDay"] as const) {
    const n = value[field]
    if (n === undefined) continue
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) problems.add(`${where}.${field} must be a whole number of at least 1.`)
    else quota[field] = n
  }
  return quota
}

const parseQuotas = (value: unknown, problems: { add(message: string): void; unknownKeys(where: string, value: Record<string, unknown>, keys: string[]): void }): QuotasPolicy | undefined => {
  if (!isRecord(value)) {
    problems.add("policy.quotas must be an object.")
    return undefined
  }
  problems.unknownKeys("policy.quotas", value, ["default", "keys", "warnAt"])
  const quotas: QuotasPolicy = {}
  if (value.default !== undefined) {
    const quota = parseQuota(value.default, "policy.quotas.default", problems)
    if (quota && Object.keys(quota).length) quotas.default = quota
  }
  if (value.keys !== undefined) {
    if (!isRecord(value.keys)) problems.add("policy.quotas.keys must map key names to quotas.")
    else {
      const keys: Record<string, Quota> = {}
      for (const [name, entry] of Object.entries(value.keys)) {
        const quota = parseQuota(entry, `policy.quotas.keys["${name}"]`, problems)
        if (quota) keys[name] = quota
      }
      if (Object.keys(keys).length) quotas.keys = keys
    }
  }
  if (value.warnAt !== undefined) {
    if (typeof value.warnAt !== "number" || value.warnAt < 0.5 || value.warnAt > 0.99) problems.add("policy.quotas.warnAt is a share between 0.5 and 0.99.")
    else quotas.warnAt = value.warnAt
  }
  return Object.keys(quotas).length ? quotas : undefined
}

export const DEFAULT_DATA_DIR = path.join(os.homedir(), ".twinny", "server")
export const DEFAULT_KEYS_FILE = path.join(DEFAULT_DATA_DIR, "keys.json")
export const DEFAULT_LICENSE_FILE = path.join(DEFAULT_DATA_DIR, "license")
export const DEFAULT_USAGE: GatewayUsageConfig = {
  dir: path.join(DEFAULT_DATA_DIR, "usage"),
  retentionDays: 30
}
export const DEFAULT_RECORDING: GatewayRecordingConfig = {
  chat: false,
  fim: false,
  embeddings: false,
  retentionDays: 90,
  dir: path.join(DEFAULT_DATA_DIR, "recordings"),
  store: "auto"
}

/** `~/x` means the home directory; nothing else in a path is expanded. */
export const expandHome = (value: string): string =>
  value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value

/** Provider kinds that only make sense inside the extension. */
const UNSERVABLE_PROVIDERS: string[] = [API_PROVIDERS.TwinnyP2P]

/**
 * The gateway's own provider kind: aliases served by whichever connected
 * teammate has the model. Takes no endpoint; the peers dial in.
 */
export const TEAM_PROVIDER_KIND = "team"
const ENDPOINT_FIELDS = ["apiHostname", "apiPort", "apiProtocol", "apiKeyEnv", "paths"]

const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

class Problems {
  public readonly list: string[] = []

  public add(message: string) {
    this.list.push(message)
  }

  public unknownKeys(where: string, value: Record<string, unknown>, allowed: string[]) {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) this.add(`${where}: unknown field "${key}".`)
    }
  }

  public integer(
    where: string,
    value: unknown,
    fallback: number,
    min: number,
    max = Number.MAX_SAFE_INTEGER
  ): number {
    if (value === undefined) return fallback
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      this.add(`${where} must be a whole number between ${min} and ${max}.`)
      return fallback
    }
    return value
  }

  public string(where: string, value: unknown, fallback = ""): string {
    if (value === undefined) return fallback
    if (typeof value !== "string") {
      this.add(`${where} must be a string.`)
      return fallback
    }
    return value
  }
}

/**
 * Reads a configuration object into a `GatewayConfig`, or throws with
 * every problem found. `knownProviders` says which adapter kinds exist;
 * whether an adapter can run each configured job is checked when the
 * route table is built, since that needs the adapter itself.
 */
export const parseGatewayConfig = (
  input: unknown,
  knownProviders: string[]
): GatewayConfig => {
  const problems = new Problems()
  if (!isRecord(input)) {
    throw new GatewayConfigError("invalid-config", ["The configuration must be a JSON object."])
  }
  problems.unknownKeys("config", input, ["listen", "auth", "providers", "models", "limits", "usage", "teamDefaults", "policy", "recording"])

  /* listen */
  const listenIn = input.listen ?? {}
  const listen: GatewayListen = { ...DEFAULT_LISTEN }
  if (!isRecord(listenIn)) {
    problems.add("listen must be an object.")
  } else {
    problems.unknownKeys("listen", listenIn, ["host", "port"])
    listen.host = problems.string("listen.host", listenIn.host, DEFAULT_LISTEN.host).trim()
    if (!listen.host) problems.add("listen.host must not be empty.")
    // 0 asks the OS for a free port; the real one is printed at startup.
    listen.port = problems.integer("listen.port", listenIn.port, DEFAULT_LISTEN.port, 0, 65535)
  }

  /* auth */
  const authIn = input.auth ?? {}
  const auth: GatewayAuth = { tokenEnv: DEFAULT_TOKEN_ENV, keysFile: DEFAULT_KEYS_FILE, licenseFile: DEFAULT_LICENSE_FILE }
  if (!isRecord(authIn)) {
    problems.add("auth must be an object.")
  } else {
    problems.unknownKeys("auth", authIn, ["tokenEnv", "keysFile", "licenseFile"])
    if (authIn.tokenEnv === null) {
      auth.tokenEnv = null
    } else {
      auth.tokenEnv = problems.string("auth.tokenEnv", authIn.tokenEnv, DEFAULT_TOKEN_ENV).trim()
      if (!ENV_NAME_PATTERN.test(auth.tokenEnv)) {
        problems.add(`auth.tokenEnv "${auth.tokenEnv}" is not an environment variable name (or null to disable the shared token).`)
      }
    }
    const keysFile = problems.string("auth.keysFile", authIn.keysFile, DEFAULT_KEYS_FILE).trim()
    if (!keysFile) problems.add("auth.keysFile must not be empty.")
    else auth.keysFile = path.resolve(expandHome(keysFile))
    const licenseFile = problems.string("auth.licenseFile", authIn.licenseFile, DEFAULT_LICENSE_FILE).trim()
    if (!licenseFile) problems.add("auth.licenseFile must not be empty.")
    else auth.licenseFile = path.resolve(expandHome(licenseFile))
  }

  /* usage */
  const usageIn = input.usage ?? {}
  const usage: GatewayUsageConfig = { ...DEFAULT_USAGE }
  if (!isRecord(usageIn)) {
    problems.add("usage must be an object.")
  } else {
    problems.unknownKeys("usage", usageIn, ["dir", "retentionDays"])
    const dir = problems.string("usage.dir", usageIn.dir, DEFAULT_USAGE.dir).trim()
    if (!dir) problems.add("usage.dir must not be empty.")
    else usage.dir = path.resolve(expandHome(dir))
    usage.retentionDays = problems.integer(
      "usage.retentionDays", usageIn.retentionDays, DEFAULT_USAGE.retentionDays, 1, 3650
    )
  }

  /* providers */
  const providers: Record<string, GatewayProviderConfig> = {}
  const providersIn = input.providers
  if (!isRecord(providersIn) || Object.keys(providersIn).length === 0) {
    problems.add("providers must be an object with at least one entry.")
  } else {
    for (const [name, raw] of Object.entries(providersIn)) {
      const where = `providers.${name}`
      if (!PROVIDER_NAME_PATTERN.test(name)) {
        problems.add(`${where}: "${name}" is not a valid provider name.`)
        continue
      }
      if (!isRecord(raw)) {
        problems.add(`${where} must be an object.`)
        continue
      }
      problems.unknownKeys(where, raw, [
        "provider", "apiHostname", "apiPort", "apiProtocol", "apiKeyEnv", "paths"
      ])
      const kind = problems.string(`${where}.provider`, raw.provider).trim()
      if (!kind) {
        problems.add(`${where}.provider must name an adapter kind.`)
        continue
      }
      if (UNSERVABLE_PROVIDERS.includes(kind) || (kind !== TEAM_PROVIDER_KIND && !knownProviders.includes(kind))) {
        throw new GatewayConfigError("unsupported-provider", [
          ...problems.list,
          `${where}.provider "${kind}" is not a provider kind this gateway can serve. ` +
            `Known kinds: ${[...knownProviders.filter((k) => !UNSERVABLE_PROVIDERS.includes(k)), TEAM_PROVIDER_KIND].join(", ")}.`
        ])
      }
      const entry: GatewayProviderConfig = { provider: kind }
      if (kind === TEAM_PROVIDER_KIND) {
        // The pool has no address: teammates' extensions dial the gateway.
        for (const field of ENDPOINT_FIELDS) {
          if (raw[field] !== undefined) problems.add(`${where}.${field}: a "${TEAM_PROVIDER_KIND}" provider has no endpoint; teammates connect to the gateway.`)
        }
        const other = Object.entries(providers).find(([, existing]) => existing.provider === TEAM_PROVIDER_KIND)
        if (other) problems.add(`${where}: only one "${TEAM_PROVIDER_KIND}" provider is allowed (already "${other[0]}").`)
        providers[name] = entry
        continue
      }
      const hostname = problems.string(`${where}.apiHostname`, raw.apiHostname).trim()
      if (hostname) entry.apiHostname = hostname
      if (raw.apiPort !== undefined) {
        entry.apiPort = problems.integer(`${where}.apiPort`, raw.apiPort, 0, 1, 65535)
      }
      const protocol = problems.string(`${where}.apiProtocol`, raw.apiProtocol).trim()
      if (protocol) {
        if (!/^https?$/.test(protocol)) problems.add(`${where}.apiProtocol must be http or https.`)
        entry.apiProtocol = protocol
      }
      const keyEnv = problems.string(`${where}.apiKeyEnv`, raw.apiKeyEnv).trim()
      if (keyEnv) {
        if (!ENV_NAME_PATTERN.test(keyEnv)) {
          problems.add(`${where}.apiKeyEnv "${keyEnv}" is not an environment variable name.`)
        }
        entry.apiKeyEnv = keyEnv
      }
      if (raw.paths !== undefined) {
        if (!isRecord(raw.paths)) {
          problems.add(`${where}.paths must be an object.`)
        } else {
          problems.unknownKeys(`${where}.paths`, raw.paths, ["fim", "chat", "embeddings"])
          entry.paths = {}
          for (const [capability, path] of Object.entries(raw.paths)) {
            if (!isInferenceCapability(capability)) continue
            if (typeof path !== "string" || (path && !path.startsWith("/")) || /\s/.test(path)) {
              problems.add(`${where}.paths.${capability} must be a path starting with /.`)
              continue
            }
            entry.paths[capability] = path.replace(/\/+$/, "")
          }
        }
      }
      providers[name] = entry
    }
  }

  /* models */
  const models: GatewayModelConfig[] = []
  const modelsIn = input.models
  if (!Array.isArray(modelsIn) || modelsIn.length === 0) {
    problems.add("models must be a list with at least one entry.")
  } else {
    const seen = new Map<string, number>()
    modelsIn.forEach((raw, index) => {
      const where = `models[${index}]`
      if (!isRecord(raw)) {
        problems.add(`${where} must be an object.`)
        return
      }
      problems.unknownKeys(where, raw, ["alias", "provider", "model", "capabilities", "contextWindow"])
      const alias = problems.string(`${where}.alias`, raw.alias).trim()
      if (!ALIAS_PATTERN.test(alias)) {
        problems.add(`${where}.alias "${alias}" is not a valid alias.`)
      }
      const lower = alias.toLowerCase()
      const earlier = seen.get(lower)
      if (earlier !== undefined) {
        problems.add(`${where}.alias "${alias}" is already used by models[${earlier}].`)
      } else {
        seen.set(lower, index)
      }
      const provider = problems.string(`${where}.provider`, raw.provider).trim()
      if (!provider) {
        problems.add(`${where}.provider must name an entry in providers.`)
      } else if (isRecord(providersIn) && !(provider in providersIn)) {
        problems.add(`${where}.provider "${provider}" is not in providers.`)
      }
      const model = problems.string(`${where}.model`, raw.model).trim()
      if (!model) problems.add(`${where}.model must name the backend model.`)
      const caps = raw.capabilities
      const capabilities: InferenceCapability[] = []
      if (!Array.isArray(caps) || caps.length === 0) {
        problems.add(`${where}.capabilities must list at least one of fim, chat, embeddings.`)
      } else {
        for (const cap of caps) {
          if (!isInferenceCapability(cap)) {
            problems.add(`${where}.capabilities: "${String(cap)}" is not one of fim, chat, embeddings.`)
          } else if (!capabilities.includes(cap)) {
            capabilities.push(cap)
          }
        }
      }
      const entry: GatewayModelConfig = { alias, provider, model, capabilities }
      if (raw.contextWindow !== undefined) {
        entry.contextWindow = problems.integer(`${where}.contextWindow`, raw.contextWindow, 0, 1)
      }
      models.push(entry)
    })
  }

  /* limits */
  const limitsIn = input.limits ?? {}
  const limits: GatewayLimits = { ...DEFAULT_LIMITS }
  if (!isRecord(limitsIn)) {
    problems.add("limits must be an object.")
  } else {
    problems.unknownKeys("limits", limitsIn, [
      "maxActiveRequests", "requestDeadlineMs", "maxBodyBytes", "maxOutputTokens", "shutdownGraceMs", "perKey"
    ])
    if (limitsIn.perKey !== undefined) {
      if (!isRecord(limitsIn.perKey)) {
        problems.add("limits.perKey must be an object.")
      } else {
        problems.unknownKeys("limits.perKey", limitsIn.perKey, ["maxActiveRequests", "requestsPerMinute"])
        const perKey: PerKeyLimits = {}
        if (limitsIn.perKey.maxActiveRequests !== undefined) {
          perKey.maxActiveRequests = problems.integer(
            "limits.perKey.maxActiveRequests", limitsIn.perKey.maxActiveRequests, 1, 1, 10_000
          )
        }
        if (limitsIn.perKey.requestsPerMinute !== undefined) {
          perKey.requestsPerMinute = problems.integer(
            "limits.perKey.requestsPerMinute", limitsIn.perKey.requestsPerMinute, 1, 1, 1_000_000
          )
        }
        if (Object.keys(perKey).length) limits.perKey = perKey
      }
    }
    limits.maxActiveRequests = problems.integer(
      "limits.maxActiveRequests", limitsIn.maxActiveRequests, DEFAULT_LIMITS.maxActiveRequests, 1, 10_000
    )
    limits.requestDeadlineMs = problems.integer(
      "limits.requestDeadlineMs", limitsIn.requestDeadlineMs, DEFAULT_LIMITS.requestDeadlineMs, 100
    )
    limits.maxBodyBytes = problems.integer(
      "limits.maxBodyBytes", limitsIn.maxBodyBytes, DEFAULT_LIMITS.maxBodyBytes, 1024
    )
    if (limitsIn.maxOutputTokens !== undefined) {
      limits.maxOutputTokens = problems.integer(
        "limits.maxOutputTokens", limitsIn.maxOutputTokens, 1, 1, 1_000_000
      )
    }
    limits.shutdownGraceMs = problems.integer(
      "limits.shutdownGraceMs", limitsIn.shutdownGraceMs, DEFAULT_LIMITS.shutdownGraceMs, 0
    )
  }

  /* recording */
  const recording: GatewayRecordingConfig = { ...DEFAULT_RECORDING }
  const recordingIn = input.recording ?? {}
  if (!isRecord(recordingIn)) {
    problems.add("recording must be an object.")
  } else {
    problems.unknownKeys("recording", recordingIn, ["chat", "fim", "embeddings", "retentionDays", "dir", "store"])
    for (const route of ["chat", "fim", "embeddings"] as const) {
      if (recordingIn[route] === undefined) continue
      if (typeof recordingIn[route] !== "boolean") problems.add(`recording.${route} must be true or false.`)
      else recording[route] = recordingIn[route] as boolean
    }
    recording.retentionDays = problems.integer("recording.retentionDays", recordingIn.retentionDays, DEFAULT_RECORDING.retentionDays, 1, 3650)
    const dir = problems.string("recording.dir", recordingIn.dir, DEFAULT_RECORDING.dir).trim()
    if (!dir) problems.add("recording.dir must not be empty.")
    else recording.dir = path.resolve(expandHome(dir))
    const store = problems.string("recording.store", recordingIn.store, DEFAULT_RECORDING.store).trim()
    if (!["auto", "sqlite", "jsonl"].includes(store)) problems.add("recording.store must be auto, sqlite or jsonl.")
    else recording.store = store as GatewayRecordingConfig["store"]
  }

  const config: GatewayConfig = { listen, auth, providers, models, limits, usage, recording }
  if (input.teamDefaults !== undefined) {
    config.teamDefaults = {}
    if (!isRecord(input.teamDefaults)) problems.add("teamDefaults must be an object.")
    else for (const [capability, alias] of Object.entries(input.teamDefaults)) {
      if (!isInferenceCapability(capability)) {
        problems.add(`teamDefaults.${capability}: choose chat, fim or embeddings.`)
        continue
      }
      const model = typeof alias === "string" ? models.find((m) => m.alias.toLowerCase() === alias.trim().toLowerCase()) : undefined
      if (!model || !model.capabilities.includes(capability)) {
        problems.add(`teamDefaults.${capability} must name a model alias that supports ${capability}.`)
      } else config.teamDefaults[capability] = model.alias
    }
  }

  /* policy */
  if (input.policy !== undefined) {
    if (!isRecord(input.policy)) {
      problems.add("policy must be an object.")
    } else {
      problems.unknownKeys("policy", input.policy, ["teamOnly", "lockDefaults", "systemPrompt", "templates", "quotas", "routing"])
      const policy: GatewayPolicy = {}
      if (input.policy.teamOnly !== undefined) {
        if (typeof input.policy.teamOnly !== "boolean") problems.add("policy.teamOnly must be true or false.")
        else policy.teamOnly = input.policy.teamOnly
      }
      if (input.policy.lockDefaults !== undefined) {
        if (typeof input.policy.lockDefaults !== "boolean") problems.add("policy.lockDefaults must be true or false.")
        else policy.lockDefaults = input.policy.lockDefaults
      }
      if (input.policy.systemPrompt !== undefined) {
        if (typeof input.policy.systemPrompt !== "string") problems.add("policy.systemPrompt must be a string.")
        else if (input.policy.systemPrompt.length > 20_000) problems.add("policy.systemPrompt is longer than 20,000 characters.")
        else if (input.policy.systemPrompt.trim()) policy.systemPrompt = input.policy.systemPrompt
      }
      if (input.policy.templates !== undefined) {
        if (!Array.isArray(input.policy.templates)) problems.add("policy.templates must be a list.")
        else {
          const templates: TeamTemplate[] = []
          const seen = new Set<string>()
          input.policy.templates.forEach((entry, i) => {
            if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.prompt !== "string") {
              problems.add(`policy.templates[${i}] needs a name and a prompt.`)
              return
            }
            if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(entry.name)) problems.add(`policy.templates[${i}].name "${entry.name}" may use letters, digits, - and _ (up to 40).`)
            else if (seen.has(entry.name.toLowerCase())) problems.add(`policy.templates has "${entry.name}" twice.`)
            else if (entry.prompt.length > 20_000) problems.add(`policy.templates "${entry.name}" is longer than 20,000 characters.`)
            else {
              seen.add(entry.name.toLowerCase())
              templates.push({ name: entry.name, prompt: entry.prompt, ...(typeof entry.description === "string" && entry.description ? { description: entry.description.slice(0, 200) } : {}) })
            }
          })
          if (templates.length > 100) problems.add("policy.templates holds at most 100 templates.")
          else if (templates.length) policy.templates = templates
        }
      }
      if (input.policy.quotas !== undefined) {
        const quotas = parseQuotas(input.policy.quotas, problems)
        if (quotas) policy.quotas = quotas
      }
      if (input.policy.routing !== undefined) {
        if (!Array.isArray(input.policy.routing)) problems.add("policy.routing must be a list of rules.")
        else {
          const rules: RoutingRule[] = []
          input.policy.routing.forEach((entry, i) => {
            if (!isRecord(entry) || typeof entry.workspace !== "string" || !entry.workspace.trim()) {
              problems.add(`policy.routing[${i}] needs a workspace pattern.`)
              return
            }
            problems.unknownKeys(`policy.routing[${i}]`, entry, ["workspace", "localOnly", "aliases"])
            const rule: RoutingRule = { workspace: entry.workspace.trim() }
            if (entry.localOnly !== undefined) {
              if (typeof entry.localOnly !== "boolean") problems.add(`policy.routing[${i}].localOnly must be true or false.`)
              else if (entry.localOnly) rule.localOnly = true
            }
            if (entry.aliases !== undefined) {
              if (!Array.isArray(entry.aliases) || !entry.aliases.every((a) => typeof a === "string")) problems.add(`policy.routing[${i}].aliases must be a list of alias names.`)
              else {
                const unknown = (entry.aliases as string[]).find((a) => !models.some((m) => m.alias === a))
                if (unknown) problems.add(`policy.routing[${i}].aliases names "${unknown}", which is not a configured alias.`)
                else if (entry.aliases.length) rule.aliases = [...(entry.aliases as string[])]
              }
            }
            if (!rule.localOnly && !rule.aliases) problems.add(`policy.routing[${i}] must set localOnly or aliases, or it does nothing.`)
            rules.push(rule)
          })
          if (rules.length) policy.routing = rules
        }
      }
      if (Object.keys(policy).length) config.policy = policy
    }
  }

  /* Every route as the adapter will see it must be a valid provider. */
  if (problems.list.length === 0) {
    for (const model of models) {
      if (isTeamProvider(config, model.provider)) continue
      for (const capability of model.capabilities) {
        const built = providerForRoute(config, model, capability, undefined)
        const { errors } = validateProvider(built)
        for (const [field, message] of Object.entries(errors)) {
          problems.add(`models "${model.alias}" (${capability}): ${field}: ${message}`)
        }
      }
    }
  }

  if (problems.list.length) throw new GatewayConfigError("invalid-config", problems.list)
  return config
}

/** Whether an alias's provider is the team pool. */
export const isTeamProvider = (config: GatewayConfig, providerName: string): boolean =>
  config.providers[providerName]?.provider === TEAM_PROVIDER_KIND

/** Backend model names the pool's aliases ask for: what sharers are told the team wants. */
export const teamWantedModels = (config: GatewayConfig): string[] =>
  [...new Set(config.models.filter((model) => isTeamProvider(config, model.provider)).map((model) => model.model))].sort()

/** Aliases that run on teammates' computers, for the disclosure to requesters. */
export const teamPooledAliases = (config: GatewayConfig): string[] =>
  config.models.filter((model) => isTeamProvider(config, model.provider)).map((model) => model.alias)

/** Whether the configuration has a team pool at all. */
export const hasTeamPool = (config: GatewayConfig): boolean =>
  Object.values(config.providers).some((provider) => provider.provider === TEAM_PROVIDER_KIND)

/**
 * The `TwinnyProvider` an adapter is given for one alias and job: the
 * backend's address, the route for the job (configured, or the adapter's
 * usual one), the backend model, and the key when the environment has one.
 */
export const providerForRoute = (
  config: GatewayConfig,
  model: GatewayModelConfig,
  capability: InferenceCapability,
  apiKey: string | undefined
): TwinnyProvider =>
  providerForBackend(config.providers[model.provider], model.model, capability, {
    id: `${model.alias}:${capability}`,
    label: model.alias,
    apiKey
  })

/**
 * The shared token and provider keys the configuration names, from the
 * environment. `activeKeys` is how many named access keys exist: with at
 * least one, the shared token becomes optional (the transition away from
 * it); with none, something must let a client in.
 */
export const readGatewaySecrets = (
  config: GatewayConfig,
  env: NodeJS.ProcessEnv,
  activeKeys = 0
): GatewaySecrets => {
  const missing: string[] = []
  const tokenEnv = config.auth.tokenEnv
  const token = tokenEnv ? (env[tokenEnv] || "").trim() : ""
  if (!token && activeKeys === 0) {
    missing.push(
      tokenEnv
        ? `No way in: set the ${tokenEnv} environment variable to a shared token ` +
          "(for example: openssl rand -hex 32), or create a named key with " +
          "`twinny-server keys create <name>`."
        : "No way in: auth.tokenEnv is null and there are no active keys. " +
          "Create one with `twinny-server keys create <name>`."
    )
  }
  const providerKeys: Record<string, string | undefined> = {}
  for (const [name, backend] of Object.entries(config.providers)) {
    if (!backend.apiKeyEnv) continue
    const key = env[backend.apiKeyEnv]
    if (!key) {
      missing.push(
        `providers.${name} names ${backend.apiKeyEnv} for its API key, but that environment variable is not set.`
      )
    }
    providerKeys[name] = key
  }
  if (missing.length) throw new GatewayConfigError("missing-env", missing)
  return { ...(token ? { token } : {}), providerKeys }
}

/** Reads and parses a file; a missing or unreadable file is a configuration problem. */
export const loadGatewayConfig = (
  file: string,
  knownProviders: string[]
): GatewayConfig => {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (error) {
    throw new GatewayConfigError("invalid-config", [
      `Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`
    ])
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new GatewayConfigError("invalid-config", [
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    ])
  }
  return parseGatewayConfig(parsed, knownProviders)
}

/** Admin edits are limited to inference configuration; secrets stay in the environment. */
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { API_PROVIDERS, PROVIDER_DISPLAY_NAMES } from "../common/constants/providers"
import { getEndpointDefaults, validateProvider } from "../common/provider-validation"
import { providerRegistry } from "../extension/inference/registry"
import type { TeamDefaults, TeamPolicy } from "../protocol/types"

import {
  GatewayConfig,
  GatewayModelConfig,
  GatewayProviderConfig,
  GatewayRecordingConfig,
  parseGatewayConfig,
  providerForRoute,
  readGatewaySecrets,
  TEAM_PROVIDER_KIND
} from "./config"
import { buildRouteTable, RouteTable } from "./routes"

export interface ProviderKind {
  id: string
  label: string
  defaults: GatewayProviderConfig
}

export interface InferenceConfiguration {
  teamDefaults?: TeamDefaults
  policy?: TeamPolicy
  /** As written in the file; every field optional there. */
  recording?: Partial<GatewayRecordingConfig>
  providers: Record<string, GatewayProviderConfig>
  models: GatewayModelConfig[]
}

export interface ConfigurationSnapshot extends InferenceConfiguration {
  revision: string
  kinds: ProviderKind[]
}

export class ConfigurationConflict extends Error {}

const revisionOf = (text: string) => createHash("sha256").update(text).digest("hex")

/** Only ever the gateway's own pool kind; the label is what the admin page shows. */
const TEAM_KIND_LABEL = "Team members' computers"

/**
 * Computed when asked, not at import: the team pool kind is registered
 * when the gateway starts serving, after this module is loaded.
 */
const listKinds = (): ProviderKind[] =>
  providerRegistry.providerIds()
    .filter((id) => id !== API_PROVIDERS.TwinnyP2P)
    .map((id) => {
      if (id === TEAM_PROVIDER_KIND) return { id, label: TEAM_KIND_LABEL, defaults: { provider: id } }
      const chat = getEndpointDefaults(id, "chat")
      return {
        id,
        label: PROVIDER_DISPLAY_NAMES[id] ?? id,
        defaults: {
          provider: id,
          ...(chat?.apiHostname ? { apiHostname: chat.apiHostname } : {}),
          ...(chat?.apiPort ? { apiPort: chat.apiPort } : {}),
          apiProtocol: chat?.apiProtocol ?? "http"
        }
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

export class GatewayConfiguration {
  private _text: string
  private _raw: Record<string, unknown>
  public routes: RouteTable
  /** The parsed configuration in force, updated on every save. */
  public current: GatewayConfig

  constructor(
    private readonly file: string,
    config: GatewayConfig,
    routes: RouteTable,
    private readonly env: NodeJS.ProcessEnv
  ) {
    this.file = fs.realpathSync(path.resolve(file))
    this._text = fs.readFileSync(this.file, "utf8")
    this._raw = JSON.parse(this._text)
    // Do not show or overwrite a file changed between startup reads.
    if (JSON.stringify(parseGatewayConfig(this._raw, providerRegistry.providerIds())) !== JSON.stringify(config)) {
      throw new ConfigurationConflict("The configuration changed during startup. Start the gateway again.")
    }
    this.routes = routes
    this.current = config
  }

  public snapshot(): ConfigurationSnapshot {
    return JSON.parse(JSON.stringify({
      revision: revisionOf(this._text),
      providers: this._raw.providers,
      models: this._raw.models,
      teamDefaults: this._raw.teamDefaults ?? {},
      policy: this._raw.policy ?? {},
      recording: this._raw.recording ?? {},
      kinds: listKinds()
    })) as ConfigurationSnapshot
  }

  /** Uses the same adapter as inference, including its model-list API and authentication. */
  public async listModels(input: Record<string, unknown>, activeKeys: number) {
    if (Object.keys(input).some((key) => key !== "provider")) throw new Error("Only a provider configuration is accepted.")
    const config = parseGatewayConfig({
      ...this._raw,
      teamDefaults: {},
      providers: { selected: input.provider },
      models: [{ alias: "discovery", provider: "selected", model: "discovery", capabilities: ["chat"] }]
    }, providerRegistry.providerIds())
    const secrets = readGatewaySecrets(config, this.env, activeKeys)
    const provider = providerForRoute(config, config.models[0], "chat", secrets.providerKeys.selected)
    const client = providerRegistry.resolve(provider)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    try {
      const models = await client.models({ signal: controller.signal })
      return { models: models.map(({ id, name }) => ({ id, name })) }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Synchronous validation + atomic replacement prevents concurrent admin saves interleaving. */
  public save(input: Record<string, unknown>, activeKeys: number): ConfigurationSnapshot {
    if (Object.keys(input).some((key) => !["revision", "providers", "models", "teamDefaults", "policy", "recording"].includes(key))) {
      throw new Error("Only providers, models, team defaults, policy and recording can be changed here.")
    }
    if (typeof input.revision !== "string" || input.revision !== revisionOf(this._text)) {
      throw new ConfigurationConflict("Another admin saved changes. Reload the configuration before editing again.")
    }
    if (fs.readFileSync(this.file, "utf8") !== this._text) {
      throw new ConfigurationConflict("The config file changed outside the admin page. Restart the gateway to load it before saving here.")
    }
    const raw = { ...this._raw,
      providers: input.providers ?? this._raw.providers,
      models: input.models ?? this._raw.models,
      ...(input.teamDefaults !== undefined ? { teamDefaults: input.teamDefaults } : {}),
      ...(input.policy !== undefined ? { policy: input.policy } : {}),
      ...(input.recording !== undefined ? { recording: input.recording } : {}) }
    const config = parseGatewayConfig(raw, providerRegistry.providerIds())
    // A provider can be added before its first model; validate its endpoint too.
    for (const name of Object.keys(config.providers)) {
      if (config.providers[name].provider === TEAM_PROVIDER_KIND) continue
      const provider = providerForRoute(config, { alias: "validation", provider: name, model: "validation", capabilities: ["chat"] }, "chat", undefined)
      const result = validateProvider(provider)
      if (!result.valid) throw new Error(`providers.${name}: ${Object.values(result.errors).join(" ")}`)
    }
    const secrets = readGatewaySecrets(config, this.env, activeKeys)
    const routes = buildRouteTable(config, secrets, providerRegistry)
    // Store validated inference fields, preserving auth, listen, limits and usage exactly.
    raw.providers = config.providers
    raw.models = config.models
    if (config.teamDefaults) raw.teamDefaults = config.teamDefaults
    if (input.policy !== undefined) {
      if (config.policy) raw.policy = config.policy
      else delete raw.policy
    }
    const text = `${JSON.stringify(raw, null, 2)}\n`
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, text, { flag: "wx", mode: fs.statSync(this.file).mode & 0o777 })
      fs.renameSync(temporary, this.file)
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    }
    this._raw = raw
    this._text = text
    this.routes = routes
    this.current = config
    return this.snapshot()
  }
}

/**
 * The route table: each public alias, for each capability it allows, is
 * one inference client from the registry pointed at one backend model.
 * Built once at startup so a request only ever looks an entry up.
 */
import { messageOf } from "../common/errors"
import { TwinnyProvider } from "../common/types"
import { InferenceError, toInferenceError } from "../extension/inference/errors"
import { ProviderRegistry } from "../extension/inference/registry"
import { shieldClient, shouldShield } from "../extension/inference/shield"
import {
  InferenceCapability,
  InferenceClient,
  InferenceModel
} from "../extension/inference/types"
import { RemoteRouteTarget } from "../protocol/handler"
import type { TeamDefaults } from "../protocol/types"
import { RemoteBackendStatus, RemoteStatus } from "../protocol/types"

import {
  GatewayConfig,
  GatewayConfigError,
  GatewayPolicy,
  GatewaySecrets,
  providerForRoute,
  TEAM_PROVIDER_KIND
} from "./config"

export interface RouteTable {
  teamDefaults(): TeamDefaults
  /** The configured policy, or nothing. Whether to send it is the caller's decision. */
  policy(): GatewayPolicy | undefined
  models(): InferenceModel[]
  route(alias: string, capability: InferenceCapability): RemoteRouteTarget
  /** How many alias/capability pairs are served. */
  readonly size: number
  /** The configured provider name behind an alias. */
  providerOf(alias: string): string | undefined
  /**
   * Asks every backend whether it answers, each within `timeoutMs`. A
   * check in flight is shared with concurrent callers.
   */
  checkBackends(timeoutMs?: number): Promise<Omit<RemoteStatus, "protocol">>
}

const DEFAULT_CHECK_TIMEOUT_MS = 5_000

const probe = async (
  provider: string,
  client: InferenceClient,
  timeoutMs: number
): Promise<RemoteBackendStatus> => {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new InferenceError("timeout", "The backend did not answer in time.")),
    timeoutMs
  )
  try {
    await client.models({ signal: controller.signal })
    return { provider, ok: true, ms: Date.now() - started }
  } catch (error) {
    const failure = toInferenceError(error)
    const kind =
      failure.kind === "cancelled" && controller.signal.aborted ? "timeout" : failure.kind
    return { provider, ok: false, kind, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether prompts to this backend go through the secret shield. The same
 * rule as the extension's, from the gateway's side: a backend on another
 * machine, a hosted API, or the team pool (a colleague's computer) is off
 * this machine.
 */
export const shieldsBackend = (
  provider: TwinnyProvider,
  policy: GatewayPolicy | undefined
): boolean => {
  const mode = policy?.secretShield ?? "offMachine"
  if (provider.provider === TEAM_PROVIDER_KIND) return mode !== "off"
  return shouldShield(provider, mode)
}

const key = (alias: string, capability: InferenceCapability) =>
  `${alias.toLowerCase()}|${capability}`

export const buildRouteTable = (
  config: GatewayConfig,
  secrets: GatewaySecrets,
  registry: ProviderRegistry
): RouteTable => {
  const targets = new Map<string, RemoteRouteTarget>()
  const advertised: InferenceModel[] = []
  const problems: string[] = []
  const aliases = new Map<string, string>()
  const providerOfAlias = new Map<string, string>()
  /** One client per configured provider, for health checks. */
  const backendClients = new Map<string, InferenceClient>()

  for (const model of config.models) {
    aliases.set(model.alias.toLowerCase(), model.alias)
    for (const capability of model.capabilities) {
      const provider = providerForRoute(
        config,
        model,
        capability,
        secrets.providerKeys[model.provider]
      )
      let client: InferenceClient
      try {
        client = registry.resolve(provider)
        if (shieldsBackend(provider, config.policy)) client = shieldClient(client, provider)
      } catch (error) {
        problems.push(
          `models "${model.alias}": ${messageOf(error)}`
        )
        continue
      }
      if (!client.capabilities().includes(capability)) {
        problems.push(
          `models "${model.alias}": provider "${model.provider}" (${provider.provider}) cannot serve ${capability}.`
        )
        continue
      }
      targets.set(key(model.alias, capability), { client, model: model.model, provider: model.provider })
      if (!backendClients.has(model.provider)) backendClients.set(model.provider, client)
    }
    providerOfAlias.set(model.alias.toLowerCase(), model.provider)
    advertised.push({
      id: model.alias,
      name: model.alias,
      capabilities: [...model.capabilities],
      model: model.model,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {})
    })
  }
  if (problems.length) throw new GatewayConfigError("invalid-config", problems)

  let inflight: Promise<Omit<RemoteStatus, "protocol">> | undefined

  return {
    teamDefaults: () => ({ ...config.teamDefaults }),
    policy: () => (config.policy ? { ...config.policy } : undefined),
    size: targets.size,
    providerOf: (alias) => providerOfAlias.get(alias.toLowerCase()),
    checkBackends: (timeoutMs = DEFAULT_CHECK_TIMEOUT_MS) => {
      if (inflight) return inflight
      inflight = Promise.all(
        [...backendClients].map(([provider, client]) => probe(provider, client, timeoutMs))
      )
        .then((backends) => {
          const okByProvider = new Map(backends.map((b) => [b.provider, b.ok]))
          return {
            backends,
            models: config.models.map((model) => ({
              id: model.alias,
              provider: model.provider,
              ok: okByProvider.get(model.provider) === true
            }))
          }
        })
        .finally(() => {
          inflight = undefined
        })
      return inflight
    },
    models: () =>
      advertised.map((model) => ({ ...model, capabilities: [...model.capabilities] })),
    route: (alias, capability) => {
      const target = targets.get(key(alias, capability))
      if (target) return target
      const known = aliases.get(alias.toLowerCase())
      if (!known) {
        throw new InferenceError(
          "model-unavailable",
          `The gateway does not serve a model called "${alias.slice(0, 128)}".`
        )
      }
      throw new InferenceError(
        "unsupported-capability",
        `The model "${known}" is not configured for ${capability}.`
      )
    }
  }
}

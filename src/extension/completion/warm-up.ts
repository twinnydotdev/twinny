import { API_PROVIDERS } from "../../common/constants"
import { logger } from "../../common/logger"
import { TwinnyProvider } from "../../common/types"
import { resolveInferenceProvider } from "../inference"
import { LOOPBACK } from "../inference/shield"

/**
 * No warm-up within this long of the last request to the same model: the
 * server still has it loaded. Just under Ollama's default five-minute
 * keep-alive, so a model it is about to unload gets touched again.
 */
export const WARM_INTERVAL_MS = 4 * 60 * 1000
/** A warm-up that takes longer than this is abandoned; the server is stuck or gone. */
const WARM_TIMEOUT_MS = 120 * 1000

/** Servers that load models on demand and keep them in memory a while. */
const LOADS_ON_DEMAND = new Set<string>([
  API_PROVIDERS.Ollama,
  API_PROVIDERS.LMStudio,
  API_PROVIDERS.LlamaCpp,
  API_PROVIDERS.Oobabooga,
  API_PROVIDERS.TwinnyP2P
])

/**
 * Whether warming this provider is worth a request. Local model servers
 * only: a hosted API is always warm and bills every call. A generic
 * OpenAI-compatible server counts when it runs on this machine.
 */
export const shouldWarm = (provider: TwinnyProvider): boolean => {
  if (LOADS_ON_DEMAND.has(provider.provider)) return true
  if (provider.provider !== API_PROVIDERS.OpenAICompatible) return false
  return LOOPBACK.test((provider.apiHostname || "localhost").trim())
}

const modelKey = (provider: TwinnyProvider) =>
  `${provider.provider}|${provider.apiHostname}|${provider.apiPort}|${provider.modelName}`

/**
 * Loads the completion model before the first keystroke needs it. A cold
 * local model takes seconds to load, and the first completion of the day
 * (or after lunch) waits for all of it. An empty prompt with a one-token
 * cap makes the server load the model and answer at once.
 */
export class ModelWarmer {
  private _lastUse = new Map<string, number>()
  private _inFlight: string | undefined

  constructor(
    private readonly _getProvider: () => TwinnyProvider | undefined,
    private readonly _keepAlive: () => string | undefined,
    private readonly _send: (provider: TwinnyProvider, keepAlive?: string) => Promise<void> =
      sendWarmUp,
    private readonly _now: () => number = Date.now
  ) {}

  /** A real request just went to this model; it is warm for a while. */
  public touch(provider: TwinnyProvider) {
    this._lastUse.set(modelKey(provider), this._now())
  }

  /** Warms the active completion model, unless it is warm already. */
  public async warm(reason: string): Promise<void> {
    const provider = this._getProvider()
    if (!provider?.modelName || !shouldWarm(provider)) return
    const key = modelKey(provider)
    if (this._inFlight === key) return
    const last = this._lastUse.get(key)
    if (last !== undefined && this._now() - last < WARM_INTERVAL_MS) return

    this._inFlight = key
    const started = this._now()
    try {
      await this._send(provider, this._keepAlive())
      this.touch(provider)
      logger.debug(`Warmed ${provider.modelName} (${reason}) in ${this._now() - started}ms`)
    } catch (error) {
      // The next completion reports a server that is down; this stays quiet.
      logger.debug(`Warm-up of ${provider.modelName} skipped: ${error}`)
    } finally {
      this._inFlight = undefined
    }
  }
}

const sendWarmUp = async (provider: TwinnyProvider, keepAlive?: string) => {
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), WARM_TIMEOUT_MS)
  try {
    const chunks = resolveInferenceProvider(provider).fim(
      {
        model: provider.modelName,
        prompt: "",
        prefix: "",
        suffix: "",
        maxTokens: 1,
        temperature: 0,
        keepAlive
      },
      { signal: abort.signal }
    )
    for await (const chunk of chunks) void chunk
  } finally {
    clearTimeout(timeout)
  }
}

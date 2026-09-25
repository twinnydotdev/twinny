/**
 * Live checks against a provider: "does this configuration actually answer?"
 * and "which models does it serve?".
 *
 * Both go through the inference layer, so a probe exercises exactly the
 * adapter the feature will use. Every function resolves — failures come
 * back as a result, never as a rejection — because the caller is a UI that
 * wants to show the reason, not a stack trace.
 */
import { deadline } from "../../common/deadline"
import {
  ProviderModelList,
  ProviderTestResult
} from "../../common/messaging/protocol"
import { isRemoteProvider, usesEndpoint } from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"
import { fetchRemoteIdentity } from "../../protocol/client"
import { InferenceClient, readText, resolveInferenceProvider } from "../inference"

import { describeProviderErrorPlain } from "./errors"

const PROBE_TIMEOUT_MS = 20_000

const FIM_PROBE_PROMPT = "def add(a, b):\n    return"
const EMBED_PROBE_INPUT = "hello"

/* -------------------------------------------------------------------------- */
/*  Testing                                                                   */
/* -------------------------------------------------------------------------- */

const testChat = (
  client: InferenceClient,
  provider: TwinnyProvider,
  signal: AbortSignal
): Promise<string> =>
  readText(
    client.chat(
      {
        model: provider.modelName,
        messages: [{ role: "user", content: "Say hi." }],
        maxTokens: 8
      },
      { signal }
    )
  )

/**
 * Sends the same request the completion provider will send and reads the
 * first streamed chunk. Whether a real token came back is what tells the
 * user their model and template are wired up, not just that the port is
 * open. Stopping after one chunk cancels the stream so the server does not
 * keep generating for a probe.
 */
const testFim = async (
  client: InferenceClient,
  provider: TwinnyProvider,
  signal: AbortSignal
): Promise<string> => {
  const chunks = client.fim(
    { model: provider.modelName, prompt: FIM_PROBE_PROMPT, maxTokens: 8, temperature: 0 },
    { signal }
  )
  for await (const chunk of chunks) {
    if (chunk.text) return chunk.text
  }
  return ""
}

const testEmbedding = async (
  client: InferenceClient,
  provider: TwinnyProvider,
  signal: AbortSignal
): Promise<string> => {
  const { vectors } = await client.embeddings(
    { model: provider.modelName, input: EMBED_PROBE_INPUT },
    { signal }
  )
  return `${vectors[0].length} dimensions`
}

export const testProvider = async (
  provider: TwinnyProvider,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<ProviderTestResult> => {
  const started = Date.now()
  const { signal, done } = deadline(timeoutMs)
  try {
    const client = resolveInferenceProvider(provider)
    let sample: string
    switch (provider.type) {
      case "fim":
        sample = await testFim(client, provider, signal)
        break
      case "embedding":
        sample = await testEmbedding(client, provider, signal)
        break
      default:
        sample = await testChat(client, provider, signal)
    }
    const latencyMs = Date.now() - started
    // A gateway also says which key it took the test for; worth showing,
    // since the key is the only thing that tells developers apart.
    let identity: string | undefined
    if (isRemoteProvider(provider.provider)) {
      try {
        const who = await fetchRemoteIdentity(provider, { signal })
        identity = who.shared ? "shared token" : who.key
      } catch {
        // An older gateway without the route; the test itself passed.
      }
    }
    return {
      success: true,
      latencyMs,
      sample: sample.trim().slice(0, 60),
      ...(identity ? { identity } : {})
    }
  } catch (error) {
    return {
      success: false,
      latencyMs: Date.now() - started,
      error: describeProviderErrorPlain(error, provider)
    }
  } finally {
    done()
  }
}

/* -------------------------------------------------------------------------- */
/*  Listing models                                                            */
/* -------------------------------------------------------------------------- */

/** Asks the provider what it has, for the model dropdown. */
export const listProviderModels = async (
  provider: TwinnyProvider
): Promise<ProviderModelList> => {
  if (usesEndpoint(provider.provider, provider.type) && !provider.apiHostname) {
    return { models: [], error: "No hostname set." }
  }
  try {
    const models = await resolveInferenceProvider(provider).models()
    return models.length
      ? { models: models.map((model) => model.id) }
      : { models: [], error: "The server did not list any models." }
  } catch (error) {
    return { models: [], error: describeProviderErrorPlain(error, provider) }
  }
}

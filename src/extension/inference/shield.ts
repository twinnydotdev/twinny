/**
 * The secret shield at the inference boundary. Every request a feature
 * makes to a provider that is not on this machine goes out with its
 * credentials swapped for placeholders (see `common/secret-shield`), and
 * what comes back has the real values put back. Chat, completions, inline
 * edit and embeddings all go through here, so none of them has to think
 * about it.
 */
import { API_PROVIDERS } from "../../common/constants"
import { logger } from "../../common/logger"
import { HOSTED_PROVIDERS } from "../../common/provider-validation"
import {
  describeReport,
  SecretShield,
  ShieldReport,
  withheldCount
} from "../../common/secret-shield"
import { TwinnyProvider } from "../../common/types"

import { ChatMessage, InferenceClient, InferenceOptions } from "./types"

/**
 * `offMachine`: shield requests to anything but a server on this machine.
 * `always`: shield local servers too. `off`: send prompts as they are.
 */
export type SecretShieldMode = "offMachine" | "always" | "off"

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|\[::1\])$/i

/**
 * Whether a request to this provider leaves the machine. Hosted APIs, a
 * teammate's device over P2P and a Twinny gateway always do (a gateway on
 * localhost may still forward to a hosted API); an HTTP server does unless
 * it listens on loopback.
 */
export const leavesMachine = (provider: TwinnyProvider): boolean => {
  if (HOSTED_PROVIDERS.includes(provider.provider)) return true
  if (
    provider.provider === API_PROVIDERS.TwinnyP2P ||
    provider.provider === API_PROVIDERS.TwinnyRemote
  ) {
    return true
  }
  const host = (provider.apiHostname || "localhost").trim()
  return !LOOPBACK.test(host)
}

export const shouldShield = (provider: TwinnyProvider, mode: SecretShieldMode) =>
  mode === "always" || (mode === "offMachine" && leavesMachine(provider))

const redactMessages = (shield: SecretShield, messages: ChatMessage[]): ChatMessage[] =>
  messages.map((message) => {
    if (typeof message.content === "string") {
      return { ...message, content: shield.redact(message.content) }
    }
    if (!Array.isArray(message.content)) return message
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "text" ? { ...part, text: shield.redact(part.text) } : part
      )
    } as ChatMessage
  })

const tell = (
  shield: SecretShield,
  what: string,
  provider: TwinnyProvider,
  options?: InferenceOptions
) => {
  if (!shield.withheld) return
  const report = shield.report()
  logger.info(
    `Secret shield: withheld ${withheldCount(report)} from ${provider.label} (${what}): ${describeReport(report)}`
  )
  options?.onShield?.(report)
}

/** The client with every outgoing prompt redacted and every reply restored. */
export const shieldClient = (
  client: InferenceClient,
  provider: TwinnyProvider
): InferenceClient => ({
  ...client,
  fim: (request, options) => {
    const shield = new SecretShield()
    const shielded = {
      ...request,
      prompt: shield.redact(request.prompt),
      prefix: request.prefix === undefined ? undefined : shield.redact(request.prefix),
      suffix: request.suffix === undefined ? undefined : shield.redact(request.suffix),
      messages: request.messages && redactMessages(shield, request.messages)
    }
    tell(shield, "completion", provider, options)
    const chunks = client.fim(shielded, options)
    if (!shield.withheld) return chunks
    return (async function* () {
      const restore = shield.restoreStream()
      for await (const chunk of chunks) {
        const text = restore.push(chunk.text)
        if (text || chunk.usage) yield { ...chunk, text }
      }
      const rest = restore.flush()
      if (rest) yield { text: rest }
    })()
  },
  chat: (request, options) => {
    const shield = new SecretShield()
    const shielded = { ...request, messages: redactMessages(shield, request.messages) }
    tell(shield, "chat", provider, options)
    const chunks = client.chat(shielded, options)
    if (!shield.withheld) return chunks
    return (async function* () {
      const restore = shield.restoreStream()
      for await (const chunk of chunks) {
        const content = restore.push(chunk.content)
        if (content || chunk.usage || chunk.reasoning || chunk.finishReason) {
          yield { ...chunk, content }
        }
      }
      const rest = restore.flush()
      if (rest) yield { content: rest }
    })()
  },
  embeddings: (request, options) => {
    const shield = new SecretShield()
    const input = Array.isArray(request.input)
      ? request.input.map((text) => shield.redact(text))
      : shield.redact(request.input)
    tell(shield, "embeddings", provider, options)
    return client.embeddings({ ...request, input }, options)
  }
})

export type { ShieldReport }

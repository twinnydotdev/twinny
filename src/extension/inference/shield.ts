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

export const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|\[::1\])$/i

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

/**
 * A JSON text with every string inside it passed through `change`, for a
 * tool call's arguments: the values are what holds a secret or a
 * placeholder, and a value put back may need escaping the raw text would
 * not give it (a private key has line breaks). Text that is not JSON is
 * changed whole.
 */
export const mapJsonStrings = (json: string, change: (text: string) => string): string => {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return change(json)
  }
  const walk = (value: unknown): unknown =>
    typeof value === "string"
      ? change(value)
      : Array.isArray(value)
        ? value.map(walk)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]))
          : value
  return JSON.stringify(walk(parsed))
}

type CallsMessage = { tool_calls?: { function: { name: string; arguments: string } }[] }

/**
 * The model's own tool calls go back to it with each later request. Their
 * arguments were written with placeholders and restored for the tool, so
 * they hold real values again and are redacted like any other text.
 */
const redactToolCalls = (shield: SecretShield, message: ChatMessage): ChatMessage => {
  const calls = (message as CallsMessage).tool_calls
  if (!Array.isArray(calls) || !calls.length) return message
  return {
    ...message,
    tool_calls: calls.map((call) => ({
      ...call,
      function: {
        ...call.function,
        arguments: mapJsonStrings(call.function.arguments, (text) => shield.redact(text))
      }
    }))
  } as ChatMessage
}

const redactMessages = (shield: SecretShield, messages: ChatMessage[]): ChatMessage[] =>
  messages.map((original) => {
    const message = redactToolCalls(shield, original)
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
        // A tool is given the real value, as the reader of a reply is: an
        // edit that names a placeholder has to find the text in the file.
        const toolCalls = chunk.toolCalls?.map((call) => ({
          ...call,
          arguments: mapJsonStrings(call.arguments, (text) => shield.restore(text))
        }))
        if (content || chunk.usage || chunk.reasoning || chunk.finishReason || toolCalls) {
          yield { ...chunk, content, ...(toolCalls ? { toolCalls } : {}) }
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

/**
 * The gateway's side of a team's agent rules (`policy.agent`). Extensions
 * enforce them on the developer's machine; an extension from before the
 * rules would ignore them, so while a team sets any, an agent request
 * from a client that does not say it follows them is refused, with the way
 * out in the message.
 */
import { isRecord } from "../common/guards"
import { AGENT_PROMPT_MARKER } from "../extension/tools/protocol"

/**
 * What an outdated extension is told. It names no tools on purpose: an
 * agent that reads "tools" in a refusal falls back to writing its calls as
 * text, and would carry on.
 */
export const OUTDATED_AGENT_CLIENT =
  "Your team's agent rules need a newer twinny extension. Update twinny in VS Code, or switch agent mode off, and send this again."

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n")
      : ""

/** A chat request an agent made: tools offered or answered, or the agent's own prompt in its system message. */
export const isAgentRequest = (body: unknown): boolean => {
  if (!isRecord(body)) return false
  if (Array.isArray(body.tools) && body.tools.length) return true
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages.some(
    (message) =>
      isRecord(message) &&
      (message.role === "tool" || (message.role === "system" && textOf(message.content).includes(AGENT_PROMPT_MARKER)))
  )
}

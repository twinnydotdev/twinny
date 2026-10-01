/**
 * Tool calls written as text in the reply, for providers without native
 * tool-calling: the gateway, P2P and servers that refuse `tools` carry them
 * as ordinary chat, and the secret shield sees the results like any other
 * message.
 *
 * The model is asked for a fenced block, which no tokenizer treats as a
 * special token:
 *
 *     ```tool
 *     {"name": "grep", "arguments": {"pattern": "foo"}}
 *     ```
 *
 * `<tool_call>` is read too, and Qwen's `<function=grep><parameter=…>` form,
 * since models trained on them drift back to them; a server that hides
 * those tags as special tokens leaves bare JSON at the end of the reply,
 * which is read as a call when it has both a name and arguments.
 */

export interface ToolCall {
  name: string
  args: Record<string, string>
}

/** Where a call sits in the reply, and what it said or why it could not be read. */
export interface FoundCall {
  /** Index of the opening marker: the text before it is the model's prose. */
  start: number
  /** Index just past the closing marker, or the end of the text. */
  end: number
  call?: ToolCall
  error?: string
}

const OPENERS = ["```tool\n", "<tool_call>", "<function="] as const

const CLOSERS: Record<(typeof OPENERS)[number], string> = {
  "```tool\n": "```",
  "<tool_call>": "</tool_call>",
  "<function=": "</function>"
}

const firstOpener = (text: string) => {
  let best: { index: number; opener: (typeof OPENERS)[number] } | undefined
  for (const opener of OPENERS) {
    const index = text.indexOf(opener)
    if (index !== -1 && (!best || index < best.index)) best = { index, opener }
  }
  return best
}

/**
 * How much of a streaming reply can be shown: everything before a tool
 * call, less any tail that may be the start of one still arriving.
 */
export const displayableLength = (text: string): number => {
  const opener = firstOpener(text)
  if (opener) return opener.index
  for (let keep = Math.min(text.length, 12); keep > 0; keep--) {
    const tail = text.slice(text.length - keep)
    if (OPENERS.some((marker) => marker.startsWith(tail))) return text.length - keep
  }
  return text.length
}

const asArgs = (value: unknown): Record<string, string> | undefined => {
  if (typeof value === "string") {
    try {
      return asArgs(JSON.parse(value))
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])
  )
}

const parseJsonCall = (body: string): ToolCall | string => {
  const json = body.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return "the call was not valid JSON"
  }
  const { name, arguments: args, parameters } = (parsed ?? {}) as Record<string, unknown>
  if (typeof name !== "string" || !name) return "the call had no \"name\""
  return { name, args: asArgs(args ?? parameters ?? {}) ?? {} }
}

const parseFunctionCall = (body: string): ToolCall | string => {
  const name = body.match(/<function=([\w.-]+)>/)?.[1]
  if (!name) return "the call had no function name"
  const args: Record<string, string> = {}
  for (const match of body.matchAll(/<parameter=([\w.-]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) {
    args[match[1]] = match[2]
  }
  return { name, args }
}

/** Where the JSON object starting at `start` ends, strings respected. */
const objectEnd = (text: string, start: number): number | undefined => {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (char === "\\") i++
      else if (char === "\"") inString = false
    } else if (char === "\"") inString = true
    else if (char === "{") depth++
    else if (char === "}" && --depth === 0) return i + 1
  }
  return undefined
}

/** A bare `{"name": …, "arguments": …}` closing the reply, left by servers that hide the call's tags. */
const trailingJsonCall = (text: string): FoundCall | undefined => {
  const trimmed = text.trimEnd()
  if (!trimmed.endsWith("}")) return undefined
  for (const match of [...trimmed.matchAll(/\{\s*"name"\s*:/g)].reverse()) {
    const start = match.index ?? 0
    if (objectEnd(trimmed, start) !== trimmed.length) continue
    const body = trimmed.slice(start)
    if (!/"(arguments|parameters)"\s*:/.test(body)) return undefined
    const call = parseJsonCall(body)
    return typeof call === "string" ? undefined : { start, end: trimmed.length, call }
  }
  return undefined
}

/**
 * The first tool call in `text`. While the reply is still streaming only a
 * closed call counts; once it has `ended`, an unclosed one is read as far as
 * it goes, since servers often stop on the closing tag.
 */
export const findToolCall = (text: string, ended = false): FoundCall | undefined => {
  const opener = firstOpener(text)
  if (!opener) return ended ? trailingJsonCall(text) : undefined
  const closer = CLOSERS[opener.opener]
  const closeAt = text.indexOf(closer, opener.index + opener.opener.length)
  if (closeAt === -1 && !ended) return undefined
  const end = closeAt === -1 ? text.length : closeAt + closer.length
  const inner = text.slice(opener.index, end)
  const body = inner.includes("<function=")
    ? parseFunctionCall(inner)
    : parseJsonCall(
        inner
          .slice(opener.opener.length)
          .replace(/(<\/tool_call>|```)$/, "")
      )
  return typeof body === "string"
    ? { start: opener.index, end, error: body }
    : { start: opener.index, end, call: body }
}

export interface ToolParameter {
  name: string
  description: string
  optional?: boolean
  type?: "string" | "integer"
}

export interface ToolSpec {
  name: string
  description: string
  parameters: ToolParameter[]
  /** A sentence for the system prompt on when and how to use the tool. */
  guidance?: string
}

/** `name(arg, optional?)`, as the model is shown it in text mode. */
const signature = (tool: ToolSpec) =>
  `${tool.name}(${tool.parameters.map((p) => `${p.name}${p.optional ? "?" : ""}`).join(", ")})`

/** A tool as a JSON schema, for providers with native tool-calling. */
export const toolDefinition = (tool: ToolSpec) => ({
  name: tool.name,
  description: tool.description,
  parameters: {
    type: "object",
    properties: Object.fromEntries(
      tool.parameters.map((p) => [p.name, { type: p.type ?? "string", description: p.description }])
    ),
    required: tool.parameters.filter((p) => !p.optional).map((p) => p.name)
  }
})

const GUIDANCE =
  "Paths are relative to the workspace root. Use tools when the answer depends on code you have not seen, and call them straight away rather than saying what you will look for. When you know enough, answer without a tool call and name the files you used as path:line."

/**
 * The system prompt section that offers the tools. With `native`, the
 * server describes them to the model and only the guidance is needed.
 */
export const toolInstructions = (tools: ToolSpec[], orientation = "", native = false) => {
  const edits = tools.flatMap((tool) => (tool.guidance ? [tool.guidance] : []))
  return (native
    ? ["You can look at the user's workspace with the tools you have before answering.", GUIDANCE, ...edits, orientation]
    : [
        "You can look at the user's workspace before answering. To use a tool, write one call in exactly this form and then stop writing:",
        "",
        "```tool",
        "{\"name\": \"grep\", \"arguments\": {\"pattern\": \"createServer\"}}",
        "```",
        "",
        "The result comes back in the next message. Tools:",
        ...tools.map((tool) => `- ${signature(tool)}: ${tool.description}`),
        "",
        `${GUIDANCE} One call per message.`,
        ...edits,
        orientation
      ]
  )
    .join("\n")
    .trim()
}

export const toolResultMessage = (name: string, output: string) =>
  `<tool_result name="${name}">\n${output}\n</tool_result>`

export const FINAL_ANSWER_PROMPT =
  "You have used all your tool calls. Answer now from what you have found, without calling a tool."

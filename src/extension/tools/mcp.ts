/**
 * Model Context Protocol servers as agent tools: a server the user names
 * in `twinny.chatToolsMcpServers` is started as a process and spoken to
 * over its standard input and output, newline-delimited JSON-RPC 2.0, as
 * the protocol's stdio transport has it. Only what the agent needs is
 * spoken: the handshake, listing tools (page by page) and calling one.
 * Resources, prompts, sampling and the HTTP transport are not.
 *
 * Plain Node, no SDK, so it runs in the extension, the tests and the eval
 * alike; what a call needs from the editor (approval) comes from the host.
 */
import { ChildProcess, spawn } from "child_process"

import type { ToolParameter, ToolSpec } from "./protocol"

export const MCP_PROTOCOL_VERSION = "2025-06-18"
const START_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 30_000
/** A description longer than this is cut: the tool list is in every request. */
const MAX_DESCRIPTION_CHARS = 200
/** More tools than this from one server, and small models start to pick badly; the host says so. */
export const MANY_MCP_TOOLS = 20
/** Pages of `tools/list` read at most, against a server that pages for ever. */
const MAX_LIST_PAGES = 20
const MAX_STDERR_CHARS = 4000

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

/** A JSON schema, as far as the tools read one. */
export interface JsonSchema {
  type?: string | string[]
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  [key: string]: unknown
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: JsonSchema
}

export interface McpCallResult {
  /** The text the server returned; other content named in brackets. */
  text: string
  isError: boolean
}

interface Pending {
  resolve(result: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export interface McpClientOptions {
  /** Where the server runs when its configuration names no folder. */
  cwd: string
  startTimeoutMs?: number
  callTimeoutMs?: number
  /** What the server writes to its standard error, for the log. */
  onStderr?(text: string): void
}

/** One server: its process and the requests in flight to it. */
export class McpClient {
  private _child?: ChildProcess
  private _nextId = 1
  private readonly _pending = new Map<number, Pending>()
  private _buffer = ""
  private _ended?: string
  private _started?: Promise<void>

  constructor(
    readonly name: string,
    private readonly _config: McpServerConfig,
    private readonly _options: McpClientOptions
  ) {}

  /** Start the server and shake hands with it, once; later calls wait on the first. */
  start(): Promise<void> {
    this._started ??= this.begin().catch((error) => {
      this.close()
      throw error
    })
    return this._started
  }

  private async begin() {
    const child = spawn(this._config.command, this._config.args ?? [], {
      cwd: this._config.cwd ?? this._options.cwd,
      env: { ...process.env, ...this._config.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    })
    this._child = child
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => this.receive(chunk))
    child.stderr?.on("data", (chunk: string) => this._options.onStderr?.(chunk.slice(-MAX_STDERR_CHARS)))
    child.on("error", (error) => this.end(`it could not start: ${error.message}`))
    child.on("exit", (code, signal) => this.end(`it exited${signal ? ` on ${signal}` : ` with code ${code}`}`))
    child.stdin?.on("error", () => undefined)
    await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "twinny", version: "1" }
      },
      this._options.startTimeoutMs ?? START_TIMEOUT_MS
    )
    this.notify("notifications/initialized")
  }

  /** Every tool the server offers, page by page. */
  async listTools(): Promise<McpTool[]> {
    await this.start()
    const tools: McpTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = (await this.request("tools/list", cursor ? { cursor } : {})) as {
        tools?: McpTool[]
        nextCursor?: string
      }
      for (const tool of result?.tools ?? []) if (tool && typeof tool.name === "string") tools.push(tool)
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined
      if (!cursor) break
    }
    return tools
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    await this.start()
    const result = (await this.request("tools/call", { name, arguments: args }, undefined, signal)) as {
      content?: unknown[]
      isError?: boolean
      structuredContent?: unknown
    }
    return { text: contentText(result), isError: result?.isError === true }
  }

  /** Stop the server; whatever is in flight fails with the reason. */
  close() {
    this.end("it was closed")
    const child = this._child
    if (child && child.exitCode === null && !child.killed) {
      child.stdin?.end()
      child.kill()
    }
  }

  private request(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    if (this._ended) return Promise.reject(new Error(`The MCP server ${this.name} is not running: ${this._ended}.`))
    const id = this._nextId++
    return new Promise((resolve, reject) => {
      const limit = timeoutMs ?? this._options.callTimeoutMs ?? CALL_TIMEOUT_MS
      const settle = () => {
        this._pending.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
      const onAbort = () => {
        settle()
        this.notify("notifications/cancelled", { requestId: id, reason: "The user stopped the reply." })
        reject(new Error("Stopped by the user."))
      }
      const timer = setTimeout(() => {
        settle()
        this.notify("notifications/cancelled", { requestId: id, reason: "Timed out." })
        reject(new Error(`The MCP server ${this.name} did not answer ${method} within ${Math.round(limit / 1000)} s.`))
      }, limit)
      this._pending.set(id, {
        resolve: (result) => {
          settle()
          resolve(result)
        },
        reject: (error) => {
          settle()
          reject(error)
        },
        timer
      })
      if (signal?.aborted) return onAbort()
      signal?.addEventListener("abort", onAbort, { once: true })
      this.send({ jsonrpc: "2.0", id, method, params })
    })
  }

  private notify(method: string, params?: unknown) {
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })
  }

  private send(message: unknown) {
    const stdin = this._child?.stdin
    if (!stdin || stdin.destroyed || this._ended) return
    stdin.write(`${JSON.stringify(message)}\n`)
  }

  private receive(chunk: string) {
    this._buffer += chunk
    let newline = this._buffer.indexOf("\n")
    while (newline !== -1) {
      const line = this._buffer.slice(0, newline).trim()
      this._buffer = this._buffer.slice(newline + 1)
      if (line) this.handle(line)
      newline = this._buffer.indexOf("\n")
    }
  }

  private handle(line: string) {
    let message: { id?: number | string; method?: string; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(line)
    } catch {
      // Not ours: a server that prints to its output besides the protocol.
      return
    }
    if (message.method !== undefined) {
      // A request from the server: a ping is answered; the rest are not spoken here.
      if (message.id !== undefined) {
        this.send(
          message.method === "ping"
            ? { jsonrpc: "2.0", id: message.id, result: {} }
            : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `twinny does not offer ${message.method}.` } }
        )
      }
      return
    }
    const pending = typeof message.id === "number" ? this._pending.get(message.id) : undefined
    if (!pending) return
    if (message.error) pending.reject(new Error(message.error.message || "The MCP server reported an error."))
    else pending.resolve(message.result)
  }

  private end(reason: string) {
    if (this._ended) return
    this._ended = reason
    for (const pending of this._pending.values()) pending.reject(new Error(`The MCP server ${this.name} stopped: ${reason}.`))
    this._pending.clear()
  }
}

/** What a call returned, as text: text items in order, the rest named in brackets. */
export const contentText = (result: { content?: unknown[]; structuredContent?: unknown } | undefined): string => {
  const parts = (result?.content ?? []).map((item) => {
    const part = item as { type?: string; text?: string; name?: string; uri?: string; resource?: { uri?: string; text?: string } }
    if (part.type === "text" && typeof part.text === "string") return part.text
    if (part.type === "image") return "[image]"
    if (part.type === "audio") return "[audio]"
    if (part.type === "resource") return part.resource?.text ?? `[resource ${part.resource?.uri ?? ""}]`.trim()
    if (part.type === "resource_link") return `[resource ${part.name ?? part.uri ?? ""}]`.trim()
    return ""
  })
  const text = parts.filter(Boolean).join("\n")
  if (text) return text
  return result?.structuredContent === undefined ? "" : JSON.stringify(result.structuredContent)
}

/** `<server>__<tool>`, in the characters and length tool names may have everywhere (OpenAI's rule is the narrowest). */
export const qualifiedToolName = (server: string, tool: string) =>
  `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)

const clipDescription = (text: string | undefined) => {
  const flat = (text ?? "").replace(/\s+/g, " ").trim()
  return flat.length > MAX_DESCRIPTION_CHARS ? `${flat.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : flat
}

const typeOf = (schema: JsonSchema | undefined) => (Array.isArray(schema?.type) ? schema?.type[0] : schema?.type)

/**
 * Arguments as the tools receive them (every value a string; a native
 * call's numbers and objects arrive as their JSON) turned back into what
 * the server's schema asks for.
 */
export const coerceArguments = (schema: JsonSchema | undefined, args: Record<string, string>): Record<string, unknown> => {
  const properties = schema?.properties ?? {}
  return Object.fromEntries(
    Object.entries(args).map(([name, value]) => {
      const type = typeOf(properties[name])
      if (type === "number" || type === "integer") {
        const number = Number(value)
        return [name, Number.isFinite(number) && value.trim() !== "" ? number : value]
      }
      if (type === "boolean") return [name, value === "true" ? true : value === "false" ? false : value]
      if (type === "object" || type === "array" || type === "null") {
        try {
          return [name, JSON.parse(value)]
        } catch {
          return [name, value]
        }
      }
      return [name, value]
    })
  )
}

/** An MCP tool as the agent is offered it. */
export interface McpToolSpec extends ToolSpec {
  server: string
  /** The tool's own name, as the server knows it. */
  tool: string
}

/** A server's tools as the agent sees them; `taken` holds names already in use, so two servers never clash. */
export const mcpToolSpecs = (server: string, tools: McpTool[], taken: Set<string>): McpToolSpec[] =>
  tools.flatMap((tool) => {
    let name = qualifiedToolName(server, tool.name)
    for (let n = 2; taken.has(name); n++) name = `${qualifiedToolName(server, tool.name).slice(0, 60)}_${n}`
    taken.add(name)
    const schema: JsonSchema = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object" }
    const required = new Set(Array.isArray(schema.required) ? schema.required : [])
    const parameters: ToolParameter[] = Object.entries(schema.properties ?? {}).map(([parameter, property]) => ({
      name: parameter,
      description: clipDescription(property?.description) || parameter,
      ...(required.has(parameter) ? {} : { optional: true })
    }))
    return [
      {
        name,
        server,
        tool: tool.name,
        description: `${clipDescription(tool.description) || tool.name} (from the MCP server ${server})`,
        parameters,
        schema: { type: "object", ...schema }
      }
    ]
  })

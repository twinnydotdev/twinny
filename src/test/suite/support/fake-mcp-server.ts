/**
 * A Model Context Protocol server over standard input and output, for the
 * tests: two pages of tools, one that says its arguments back, one that
 * adds numbers (so typed arguments can be seen arriving typed), one that
 * reports an error, one that never answers and one that exits mid-call.
 * It also prints a line that is not the protocol, as real servers do.
 */
import * as readline from "readline"

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)

const tools = [
  {
    name: "echo",
    description: "Says the text back.",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "What to say." } }, required: ["text"] }
  },
  {
    name: "add",
    description: "Adds two numbers.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" }, options: { type: "object" }, loud: { type: "boolean" } },
      required: ["a", "b"]
    }
  },
  { name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
  { name: "slow", description: "Never answers.", inputSchema: { type: "object", properties: {} } },
  { name: "crash", description: "Exits mid-call.", inputSchema: { type: "object", properties: {} } },
  { name: "odd.name/x", description: "A name tools may not have as it is.", inputSchema: { type: "object", properties: {} } }
]

process.stdout.write("fake MCP server starting (not JSON)\n")
process.stderr.write("fake MCP server: a line on stderr\n")

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> }
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result })
  switch (message.method) {
    case "initialize":
      reply({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } })
      // A server may ask its client things; this one pings.
      send({ jsonrpc: "2.0", id: "server-1", method: "ping" })
      return
    case "tools/list":
      return message.params?.cursor === "2" ? reply({ tools: tools.slice(3) }) : reply({ tools: tools.slice(0, 3), nextCursor: "2" })
    case "tools/call": {
      const name = message.params?.name
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>
      if (name === "echo") return reply({ content: [{ type: "text", text: String(args.text) }, { type: "image", data: "", mimeType: "image/png" }] })
      if (name === "add") {
        const kinds = Object.entries(args).map(([key, value]) => `${key}:${typeof value}`).join(",")
        return reply({ content: [{ type: "text", text: `${Number(args.a) + Number(args.b)} (${kinds})` }] })
      }
      if (name === "fail") return reply({ content: [{ type: "text", text: "no such issue" }], isError: true })
      if (name === "slow") return
      if (name === "crash") process.exit(3)
      return reply({ content: [{ type: "text", text: `called ${name}` }] })
    }
    default:
      // Notifications and anything else: no answer.
      return
  }
})

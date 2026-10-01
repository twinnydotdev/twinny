/**
 * A fake Ollama for gateway tests: speaks the generate, chat and embed
 * dialects, records what it was asked, and can stall on request so
 * cancellation paths are reachable. Nothing here needs a model.
 */
import * as http from "http"
import { AddressInfo } from "net"

export interface BackendRequest {
  path: string
  model?: string
  authorization?: string
  /** Set when the gateway dropped the connection before the reply finished. */
  cancelled: boolean
  body?: Record<string, unknown>
}

export interface Backend {
  port: number
  requests: BackendRequest[]
  close(): Promise<void>
}

/** A prompt or message containing this never gets its reply. */
export const STALL = "STALL"

/** A chat containing this is refused when it offers tools, the way Ollama refuses a model without them. */
export const NO_TOOLS = "NOTOOLS"

export const startBackend = (): Promise<Backend> =>
  new Promise((resolve) => {
    const requests: BackendRequest[] = []
    const server = http.createServer((req, res) => {
      let text = ""
      req.on("data", (chunk) => (text += chunk))
      req.on("end", () => {
        // Listings answer the gateway's health probes; they are not inference.
        if (req.url === "/api/tags") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ models: [{ name: "backend-coder:7b" }, { name: "backend-embed" }] }))
          return
        }
        if (req.url === "/v1/models") {
          res.writeHead(404).end()
          return
        }
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
        const entry: BackendRequest = {
          path: req.url || "",
          model: body.model as string | undefined,
          authorization: req.headers.authorization,
          cancelled: false,
          body
        }
        requests.push(entry)
        let finished = false
        res.on("close", () => {
          if (!finished) entry.cancelled = true
        })
        const stalls = JSON.stringify(body).includes(STALL)

        if (req.url === "/api/generate") {
          res.writeHead(200, { "Content-Type": "application/x-ndjson" })
          res.write(`${JSON.stringify({ response: "def", done: false })}\n`)
          if (stalls) return
          res.write(`${JSON.stringify({ response: " add", done: false })}\n`)
          finished = true
          res.end(
            `${JSON.stringify({ response: "", done: true, prompt_eval_count: 12, eval_count: 2 })}\n`
          )
          return
        }
        if (req.url === "/v1/chat/completions") {
          if (Array.isArray(body.tools) && JSON.stringify(body).includes(NO_TOOLS)) {
            finished = true
            res.writeHead(400, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ error: { message: `${String(body.model)} does not support tools` } }))
            return
          }
          res.writeHead(200, { "Content-Type": "text/event-stream" })
          const chunk = (content: string) =>
            `data: ${JSON.stringify({
              id: "c1",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices: [{ index: 0, delta: { content }, finish_reason: null }]
            })}\n\n`
          const messages = (Array.isArray(body.messages) ? body.messages : []) as Array<{ role?: string }>
          // Offered tools and not yet answered by one: read a file, or call whatever comes first.
          if (Array.isArray(body.tools) && body.tools.length && !messages.some((m) => m.role === "tool")) {
            const names = (body.tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name)
            const tool = names.includes("read_file") ? "read_file" : names[0]
            const frame = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>) =>
              `data: ${JSON.stringify({
                id: "c1",
                object: "chat.completion.chunk",
                created: 1,
                model: body.model,
                choices: [{ index: 0, delta, finish_reason: finish }],
                ...(usage ? { usage } : {})
              })}\n\n`
            res.write(
              frame(
                { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: tool, arguments: "{\"path\":" } }] },
                null
              )
            )
            res.write(frame({ tool_calls: [{ index: 0, function: { arguments: "\"src/a.ts\"}" } }] }, null))
            finished = true
            res.end(`${frame({}, "tool_calls", { prompt_tokens: 40, completion_tokens: 9 })}data: [DONE]\n\n`)
            return
          }
          res.write(chunk("Hello"))
          if (stalls) return
          res.write(chunk(" there"))
          finished = true
          res.end("data: [DONE]\n\n")
          return
        }
        if (req.url === "/api/embed") {
          const inputs = Array.isArray(body.input) ? body.input : [body.input]
          finished = true
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ embeddings: inputs.map(() => [0.1, 0.2, 0.3]) }))
          return
        }
        finished = true
        res.writeHead(404).end()
      })
    })
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        requests,
        close: () =>
          new Promise((done) => {
            const closable = server as unknown as { closeAllConnections?: () => void }
            closable.closeAllConnections?.()
            server.close(() => done())
          })
      })
    })
  })

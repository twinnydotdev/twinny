/**
 * The two tools that reach past the workspace: a question put to the
 * user, and a web page read. Each goes through a sink the host gives, so
 * the user is asked in the chat and nothing leaves the machine unseen.
 */
import { plural, ToolInputError } from "./view"
import type { Tool } from "./workspace"

/** Puts a question to the user; resolves with their answer, or undefined when they give none. */
export interface AskSink {
  ask(question: string, choices: string[], signal?: AbortSignal): Promise<string | undefined>
}

const MAX_QUESTION_CHARS = 600
const MAX_CHOICES = 4
const MAX_CHOICE_CHARS = 80

/** The answers offered with a question: a JSON list, or one a line. */
export const choicesOf = (choices: string | undefined): string[] => {
  const text = choices?.trim()
  if (!text) return []
  let items: string[] | undefined
  if (text.startsWith("[")) {
    try {
      const list: unknown = JSON.parse(text)
      if (Array.isArray(list)) items = list.map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
    } catch {
      items = undefined
    }
  }
  items ??= text.split("\n").map((item) => item.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ""))
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))]
    .slice(0, MAX_CHOICES)
    .map((item) => (item.length > MAX_CHOICE_CHARS ? `${item.slice(0, MAX_CHOICE_CHARS)}…` : item))
}

export const askUser = (sink: AskSink): Tool => ({
  name: "ask_user",
  description:
    "Ask the user one short question and wait for the answer, when the request can be read two ways that lead to different work and nothing in the workspace settles it.",
  guidance:
    "Use ask_user only for a decision that is the user's and that you cannot settle by reading the code: never to confirm what you were asked to do, never for permission, and at most once or twice in a reply. Offer two to four choices when you can.",
  parameters: [
    { name: "question", description: "The question, in a sentence." },
    {
      name: "choices",
      description: `Up to ${MAX_CHOICES} short answers to pick from; the user may also write their own.`,
      optional: true,
      schema: { type: "array", items: { type: "string" } }
    }
  ],
  async run({ question, choices }, context) {
    const asked = question?.trim()
    if (!asked) throw new ToolInputError("ask_user needs a question.")
    if (asked.length > MAX_QUESTION_CHARS) throw new ToolInputError("That question is too long; ask it in a sentence or two.")
    const answer = (await sink.ask(asked, choicesOf(choices), context?.signal))?.trim()
    const short = asked.length > 70 ? `${asked.slice(0, 70)}…` : asked
    if (!answer) {
      return {
        output: "The user did not answer. Go on with the reading you think most likely, and say in your reply what you assumed.",
        summary: `asked: ${short} · no answer`
      }
    }
    return {
      output: `The user answered: ${answer}`,
      summary: `asked: ${short} · ${answer.length > 60 ? `${answer.slice(0, 60)}…` : answer}`
    }
  }
})

/** Reads web pages for the model, each one only after the user says so. */
export interface FetchSink {
  /** Put the address to the user; false when they skip it. */
  approve(url: string): Promise<boolean>
  /** The request itself; the platform's `fetch` unless a test gives another. */
  fetch?: typeof fetch
}

const FETCH_TIMEOUT_MS = 20_000
/** Bytes read of a page; the rest is not downloaded. */
const MAX_PAGE_BYTES = 1_500_000
/** Characters of a page given to the model when its context's room is not known. */
const DEFAULT_PAGE_CHARS = 12_000
const TEXT_TYPES = /^(?:text\/|application\/(?:json|xml|xhtml\+xml|javascript|x-yaml|yaml|rss\+xml|atom\+xml|ld\+json))/i

/** An address the tool will ask for: http or https, with a host, and no name and password in it. */
export const fetchableUrl = (text: string | undefined): URL => {
  const written = text?.trim()
  if (!written) throw new ToolInputError("fetch_url needs a url.")
  let url: URL
  try {
    url = new URL(written)
  } catch {
    throw new ToolInputError(`${written} is not a web address; give the whole of it, starting with https://.`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolInputError("fetch_url reads http and https addresses only; use read_file for a file in the workspace.")
  }
  if (url.username || url.password) throw new ToolInputError("fetch_url does not take an address with a name or password in it.")
  return url
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©" }

const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole
    const code = name[1].toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })

/**
 * A page's HTML as the text a reader would see: the main part when the
 * page marks one, headings and list items kept as such, code blocks as
 * they are, and everything that is not content (scripts, styles,
 * navigation) left out.
 */
export const pageText = (html: string): { title?: string; text: string } => {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim()
  let body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|head|iframe)\b[\s\S]*?<\/\1\s*>/gi, "")
  const main = /<(main|article)\b[^>]*>([\s\S]*)<\/\1\s*>/i.exec(body)
  if (main && main[2].replace(/<[^>]+>/g, "").trim().length > 200) body = main[2]
  body = body.replace(/<(nav|footer|aside|form|button)\b[\s\S]*?<\/\1\s*>/gi, "")
  // Code keeps its line breaks; they are put back after the rest is tidied.
  const blocks: string[] = []
  body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, code: string) => {
    blocks.push(decodeEntities(code.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/^\n+|\s+$/g, ""))
    return `\n\n\u0000${blocks.length - 1}\u0000\n\n`
  })
  const text = decodeEntities(
    body
      .replace(/<h([1-6])\b[^>]*>/gi, (_, level: string) => `\n\n${"#".repeat(Number(level))} `)
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|section|h[1-6]|ul|ol|table|tr|blockquote|dl|dd|dt)\s*>/gi, "\n\n")
      .replace(/<\/t[dh]\s*>/gi, " | ")
      .replace(/<[^>]+>/g, "")
  )
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    // eslint-disable-next-line no-control-regex
    .replace(/\u0000(\d+)\u0000/g, (_, index: string) => `\`\`\`\n${blocks[Number(index)]}\n\`\`\``)
    .trim()
  return { ...(title ? { title } : {}), text }
}

/** A response's body as text, read no further than the most a page is worth. */
const bodyText = async (response: Response): Promise<{ text: string; cut: boolean }> => {
  const reader = response.body?.getReader()
  if (!reader) return { text: await response.text(), cut: false }
  const chunks: Uint8Array[] = []
  let size = 0
  let cut = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
    if (size >= MAX_PAGE_BYTES) {
      cut = true
      await reader.cancel().catch(() => undefined)
      break
    }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), cut }
}

export const fetchUrl = (sink: FetchSink): Tool => ({
  name: "fetch_url",
  description:
    "Read a web page as text: documentation, an issue, a link the user gave. The user is asked before each address is fetched and may skip it.",
  guidance:
    "Use fetch_url for an address the user gave you, or for the documentation of a library when the code does not answer the question. Never put anything from the workspace (code, names, keys) into an address.",
  parameters: [{ name: "url", description: "The whole address, starting with https://." }],
  async run({ url: written }, context) {
    const url = fetchableUrl(written)
    const shown = `${url.host}${url.pathname === "/" ? "" : url.pathname}`
    if (!(await sink.approve(url.href))) {
      return { output: "The user chose not to fetch this address. Carry on without it.", summary: `\`${shown}\` skipped` }
    }
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), FETCH_TIMEOUT_MS)
    const stop = () => timeout.abort()
    context?.signal?.addEventListener("abort", stop, { once: true })
    try {
      let response: Response
      try {
        response = await (sink.fetch ?? fetch)(url.href, {
          signal: timeout.signal,
          // Where a page sends the reader on to is another address, and the user has not seen it.
          redirect: "manual",
          headers: { accept: "text/html, text/plain, text/markdown, application/json;q=0.9, */*;q=0.5", "user-agent": "twinny" }
        })
      } catch (error) {
        if (context?.signal?.aborted) throw error
        throw new ToolInputError(
          timeout.signal.aborted
            ? `${url.host} did not answer within ${FETCH_TIMEOUT_MS / 1000} seconds.`
            : `${url.host} could not be reached: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`
        )
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location")
        let target: string | undefined
        try {
          target = location ? new URL(location, url).href : undefined
        } catch {
          target = undefined
        }
        return {
          output: target
            ? `${url.href} redirects to ${target}. It was not followed: call fetch_url with that address if you want the page.`
            : `${url.href} redirects (${response.status}) without saying where to.`,
          summary: `\`${shown}\` redirects${target ? ` to \`${new URL(target).host}\`` : ""}`
        }
      }
      if (!response.ok) throw new ToolInputError(`${shown} answered ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`)
      const type = (response.headers.get("content-type") ?? "text/plain").split(";")[0].trim()
      if (!TEXT_TYPES.test(type)) throw new ToolInputError(`${shown} is ${type}, not text; fetch_url reads pages and text only.`)
      const body = await bodyText(response)
      const page = /html/i.test(type) ? pageText(body.text) : { text: body.text.trim() }
      const room = Math.max(2000, (context?.roomChars ?? DEFAULT_PAGE_CHARS) - 300)
      const text = page.text.length > room ? `${page.text.slice(0, room)}\n… (${page.text.length - room} more characters not shown)` : page.text
      const header = `${url.href}${page.title ? `\n${page.title}` : ""}`
      return {
        output: `${header}\n\n${text || "(the page has no text)"}${body.cut ? "\n… (the page is longer than was downloaded)" : ""}`,
        summary: `fetched \`${shown}\` · ${plural(page.text.split("\n").filter((line) => line.trim()).length, "line")}`,
        digest: `${header}\n(a web page; fetch it again if you need it)`
      }
    } finally {
      clearTimeout(timer)
      context?.signal?.removeEventListener("abort", stop)
    }
  }
})

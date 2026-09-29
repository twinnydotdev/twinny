/**
 * The "Twinny" output channel.
 *
 * Built on VS Code's log channel, so every line carries a timestamp and a
 * level, and the panel's own level picker (or "Developer: Set Log Level…")
 * chooses how much to see. Info is the narrative: one line when a request
 * goes out, one when it comes back, with timings and sizes. Debug adds the
 * prompts and replies themselves. Warnings and errors are always written;
 * the `twinny.enableLogging` setting turns everything else off.
 */
import type * as VsCode from "vscode"

/**
 * The gateway CLI shares the inference adapters, and so this logger, with
 * no VS Code around. There the channel is stderr, warnings and errors
 * only: what a request carried is never written by a headless process.
 */
const loadVsCode = (): typeof VsCode | undefined => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("vscode") as typeof VsCode
  } catch {
    return undefined
  }
}
const vscode = loadVsCode()

interface LogSink {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  debug(message: string): void
  show(preserveFocus?: boolean): void
}

const headlessSink = (): LogSink => ({
  info: () => undefined,
  debug: () => undefined,
  warn: (message) => process.stderr.write(`[twinny] warn ${message}\n`),
  error: (message) => process.stderr.write(`[twinny] error ${message}\n`),
  show: () => undefined
})

/** Text a prompt or reply is cut to in the log. */
const MAX_BLOCK_CHARS = 8000

/** Keys and headers that must never reach the log. */
const SECRET_KEY = /("?(?:api[_-]?key|authorization|token|secret|password)"?\s*[:=]\s*)("?)(?!Bearer\b)[^"\s,}&]+/gi
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/g

export const redact = (text: string): string =>
  text
    .replace(BEARER, "Bearer ***")
    .replace(SECRET_KEY, (_, key: string, quote: string) => `${key}${quote}***`)

const describe = (error: unknown): string => {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause
    const causeText = cause instanceof Error ? ` (${cause.message})` : ""
    return `${error.message}${causeText}`
  }
  return String(error)
}

/** `1.2s` or `840ms`. */
export const formatMs = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`

/** `12.3k` or `840`. */
export const formatCount = (n: number): string =>
  n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n)

/** A block cut to size, every line indented so it reads as one entry. */
const indent = (text: string, max = MAX_BLOCK_CHARS): string => {
  const cut =
    text.length > max
      ? `${text.slice(0, max)}\n… ${formatCount(text.length - max)} more characters`
      : text
  return cut
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
}

export class Logger {
  private static instance: Logger
  private readonly channel: LogSink

  private constructor() {
    this.channel = vscode
      ? vscode.window.createOutputChannel("Twinny", { log: true })
      : headlessSink()
  }

  public static getInstance(): Logger {
    if (!Logger.instance) Logger.instance = new Logger()
    return Logger.instance
  }

  private get enabled() {
    if (!vscode) return false
    return vscode.workspace
      .getConfiguration("twinny")
      .get<boolean>("enableLogging", true)
  }

  /** Bring the channel into view. */
  public show() {
    this.channel.show(true)
  }

  public info(message: string) {
    if (this.enabled) this.channel.info(redact(message))
  }

  public warn(message: string) {
    this.channel.warn(redact(message))
  }

  public error(message: string | Error, error?: unknown) {
    const text =
      typeof message === "string"
        ? error === undefined
          ? message
          : `${message}: ${describe(error)}`
        : describe(message)
    this.channel.error(redact(text))
    if (vscode) console.error(`[twinny] ${redact(text)}`)
  }

  /** Detail worth having when something is wrong: prompts, replies, bodies. */
  public debug(message: string) {
    if (this.enabled) this.channel.debug(redact(message))
  }

  /** A titled block of text at debug level: a prompt, a reply, a request body. */
  public block(title: string, text: string) {
    if (!this.enabled || !text) return
    this.channel.debug(`${redact(title)}\n${indent(redact(text))}`)
  }

  /** Start a stopwatch; the returned function gives elapsed time as text. */
  public timer(): () => string {
    const started = Date.now()
    return () => formatMs(Date.now() - started)
  }
}

export const logger = Logger.getInstance()

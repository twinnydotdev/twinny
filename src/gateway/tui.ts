/**
 * A small terminal toolkit for the CLI: colour, steps, a spinner, a boxed
 * message and two prompts (pick from a list, type a value). No dependencies,
 * so it bundles into the single-file `twinny-server`.
 *
 * Everything degrades: without a TTY (pipes, CI, tests) colour is off, the
 * spinner prints one line, and prompts are never shown, callers pick the
 * default instead. `NO_COLOR` and `TERM=dumb` turn colour off on a TTY too.
 */
import type { ReadStream, WriteStream } from "node:tty"

export interface TuiStreams {
  stdin: NodeJS.ReadStream & Partial<ReadStream>
  stdout: NodeJS.WriteStream & Partial<WriteStream>
  env: NodeJS.ProcessEnv
}

/** Built from code points so the source never holds raw control characters. */
const ESC = String.fromCharCode(0x1b)
const CTRL_C = String.fromCharCode(0x03)
const CSI = `${ESC}[`
/** Cursor up n lines; clear the line; hide and show the cursor. */
const up = (n: number) => `${CSI}${n}A`
const CLEAR = `${CSI}2K`
const HIDE = `${CSI}?25l`
const SHOW = `${CSI}?25h`
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g")

const defaultStreams = (): TuiStreams => ({ stdin: process.stdin, stdout: process.stdout, env: process.env })

/** Colour on a terminal that wants it. `FORCE_COLOR` overrides, as elsewhere. */
export const wantsColour = ({ stdout, env }: Pick<TuiStreams, "stdout" | "env">): boolean => {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true
  if (env.NO_COLOR !== undefined || env.TERM === "dumb") return false
  return !!stdout.isTTY
}

/** Prompts need a keyboard and a screen; CI and pipes get the defaults. */
export const isInteractive = ({ stdin, stdout, env }: TuiStreams): boolean =>
  !!stdin.isTTY && !!stdout.isTTY && !env.CI && env.TERM !== "dumb"

export interface Palette {
  bold(text: string): string
  dim(text: string): string
  accent(text: string): string
  good(text: string): string
  bad(text: string): string
  warn(text: string): string
  info(text: string): string
  underline(text: string): string
}

const wrap = (open: number, close: number) => (text: string) => `${CSI}${open}m${text}${CSI}${close}m`
const plain = (text: string) => text

export const palette = (colour: boolean): Palette =>
  colour
    ? {
        bold: wrap(1, 22),
        dim: wrap(2, 22),
        accent: wrap(36, 39),
        good: wrap(32, 39),
        bad: wrap(31, 39),
        warn: wrap(33, 39),
        info: wrap(34, 39),
        underline: wrap(4, 24)
      }
    : { bold: plain, dim: plain, accent: plain, good: plain, bad: plain, warn: plain, info: plain, underline: plain }

/** Characters that need a terminal font; ASCII stands in on a dumb one. */
export const glyphs = (fancy: boolean) =>
  fancy
    ? { ok: "✓", bad: "✗", warn: "!", info: "•", pointer: "❯", bullet: "·", tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" }
    : { ok: "+", bad: "x", warn: "!", info: "*", pointer: ">", bullet: "-", tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" }

/** Length on screen, ignoring escape codes. Wide glyphs are rare here. */
export const visibleLength = (text: string): number => text.replace(ANSI, "").length

export class TuiCancelled extends Error {
  constructor() {
    super("Cancelled.")
    this.name = "TuiCancelled"
  }
}

/** Frames for a busy line; one line, redrawn in place on a TTY. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export class Tui {
  public readonly colour: boolean
  public readonly interactive: boolean
  public readonly c: Palette
  public readonly g: ReturnType<typeof glyphs>
  private readonly _streams: TuiStreams

  constructor(streams: TuiStreams = defaultStreams()) {
    this._streams = streams
    this.colour = wantsColour(streams)
    this.interactive = isInteractive(streams)
    this.c = palette(this.colour)
    this.g = glyphs(streams.env.TERM !== "dumb" && !streams.env.TWINNY_ASCII)
  }

  public write(text: string): void {
    this._streams.stdout.write(text)
  }

  public line(text = ""): void {
    this.write(`${text}\n`)
  }

  /** A titled heading: `twinny-server 4.0.18 · quickstart`. */
  public title(name: string, detail: string): void {
    this.line("")
    this.line(`  ${this.c.bold(name)} ${this.c.dim(this.g.bullet)} ${this.c.dim(detail)}`)
    this.line("")
  }

  /** One finished step: a coloured mark and a sentence. */
  public step(status: "ok" | "bad" | "warn" | "info", text: string, detail?: string): void {
    const mark =
      status === "ok"
        ? this.c.good(this.g.ok)
        : status === "bad"
          ? this.c.bad(this.g.bad)
          : status === "warn"
            ? this.c.warn(this.g.warn)
            : this.c.info(this.g.info)
    this.line(`  ${mark} ${text}${detail ? ` ${this.c.dim(detail)}` : ""}`)
  }

  /** A framed block, for the one thing on screen that must not be missed. */
  public box(lines: string[], title?: string): void {
    const inner = Math.max(...lines.map(visibleLength), title ? visibleLength(title) + 2 : 0) + 4
    const { tl, tr, bl, br, h, v } = this.g
    const top = title ? `${h} ${this.c.bold(title)} ${h.repeat(Math.max(0, inner - visibleLength(title) - 3))}` : h.repeat(inner)
    this.line(`  ${this.c.dim(tl)}${this.c.dim(top)}${this.c.dim(tr)}`)
    for (const text of lines) {
      const pad = " ".repeat(Math.max(0, inner - visibleLength(text) - 4))
      this.line(`  ${this.c.dim(v)}  ${text}${pad}  ${this.c.dim(v)}`)
    }
    this.line(`  ${this.c.dim(bl)}${this.c.dim(h.repeat(inner))}${this.c.dim(br)}`)
  }

  /** A busy indicator; `done()` replaces it with a finished step. */
  public spinner(text: string): Spinner {
    return new Spinner(this, text)
  }

  /**
   * Pick one entry with the arrow keys (or j/k), Enter to confirm, Esc or
   * Ctrl-C to cancel. Without a terminal the initial choice is returned.
   */
  public async select<T>(question: string, choices: Array<Choice<T>>, initial = 0): Promise<T> {
    if (!choices.length) throw new Error(`No choices for "${question}".`)
    let index = Math.min(Math.max(initial, 0), choices.length - 1)
    if (!this.interactive) {
      this.step("info", question, choices[index].label)
      return choices[index].value
    }
    const { stdin } = this._streams
    const render = (first: boolean) => {
      if (!first) this.write(up(choices.length + 1))
      this.line(`  ${this.c.accent("?")} ${this.c.bold(question)}`)
      choices.forEach((choice, i) => {
        const on = i === index
        const label = on ? this.c.accent(choice.label) : choice.label
        const hint = choice.hint ? ` ${this.c.dim(choice.hint)}` : ""
        this.line(`${CLEAR}    ${on ? this.c.accent(this.g.pointer) : " "} ${label}${hint}`)
      })
    }
    const answer = await new Promise<number>((resolve, reject) => {
      const raw = stdin.isRaw
      stdin.setRawMode?.(true)
      stdin.resume()
      stdin.setEncoding("utf8")
      this.write(HIDE)
      render(true)
      const finish = (result: number | Error) => {
        stdin.off("data", onData)
        stdin.setRawMode?.(raw ?? false)
        stdin.pause()
        this.write(SHOW)
        if (result instanceof Error) reject(result)
        else resolve(result)
      }
      const onData = (chunk: string) => {
        for (const key of chunk.split(new RegExp(`(?=${ESC})`))) {
          if (key === CTRL_C || key === ESC || key === "q") return finish(new TuiCancelled())
          if (key === "\r" || key === "\n") return finish(index)
          if (key === `${CSI}A` || key === "k") index = (index - 1 + choices.length) % choices.length
          else if (key === `${CSI}B` || key === "j") index = (index + 1) % choices.length
          else if (/^[1-9]$/.test(key) && Number(key) <= choices.length) index = Number(key) - 1
          else continue
          render(false)
        }
      }
      stdin.on("data", onData)
    })
    // Collapse the list into one settled line.
    this.write(up(choices.length + 1))
    for (let i = 0; i <= choices.length; i++) this.line(CLEAR)
    this.write(up(choices.length + 1))
    this.step("ok", question, choices[answer].label)
    return choices[answer].value
  }

  /** Type a value; Enter keeps the default. Without a terminal the default is used. */
  public async input(question: string, fallback: string, validate?: (value: string) => string | undefined): Promise<string> {
    if (!this.interactive) {
      this.step("info", question, fallback)
      return fallback
    }
    const readline = await import("node:readline")
    const { stdin, stdout } = this._streams
    for (;;) {
      const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true })
      const typed = await new Promise<string | undefined>((resolve) => {
        rl.on("SIGINT", () => resolve(undefined))
        rl.question(`  ${this.c.accent("?")} ${this.c.bold(question)} ${this.c.dim(`(${fallback})`)} `, (answer) => resolve(answer))
      })
      rl.close()
      if (typed === undefined) throw new TuiCancelled()
      const value = typed.trim() || fallback
      const problem = validate?.(value)
      if (problem) {
        this.step("bad", problem)
        continue
      }
      this.write(`${up(1)}${CLEAR}`)
      this.step("ok", question, value)
      return value
    }
  }
}

export interface Choice<T> {
  label: string
  hint?: string
  value: T
}

export class Spinner {
  private _timer: NodeJS.Timeout | undefined
  private _frame = 0
  private _text: string

  constructor(
    private readonly _tui: Tui,
    text: string
  ) {
    this._text = text
    if (_tui.interactive) {
      this._tui.write(`  ${this._tui.c.accent(FRAMES[0])} ${this._text}`)
      this._timer = setInterval(() => this._draw(), 80)
      this._timer.unref()
    } else {
      this._tui.line(`  ${this._tui.g.info} ${this._text}`)
    }
  }

  private _draw(): void {
    this._frame = (this._frame + 1) % FRAMES.length
    this._tui.write(`\r${CLEAR}  ${this._tui.c.accent(FRAMES[this._frame])} ${this._text}`)
  }

  public update(text: string): void {
    this._text = text
    if (this._timer) this._draw()
  }

  /** Ends the spinner and leaves a finished step in its place. */
  public done(status: "ok" | "bad" | "warn" | "info", text: string, detail?: string): void {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = undefined
      this._tui.write(`\r${CLEAR}`)
    }
    this._tui.step(status, text, detail)
  }
}

/* -------------------------------------------------------------------------- */
/*  Serve output                                                              */
/* -------------------------------------------------------------------------- */

/** Colours the serve banner on a terminal; the text itself is unchanged. */
export const decorateBanner = (tui: Tui, line: string): string => {
  if (!tui.colour) return line
  const listening = /^(Twinny gateway )(\S+ )?(listening on )(\S+)(.*)$/.exec(line)
  if (listening) {
    return `${tui.c.bold(listening[1])}${listening[2] ? tui.c.dim(listening[2]) : ""}${tui.c.bold(listening[3])}${tui.c.accent(tui.c.underline(listening[4]))}${listening[5]}`
  }
  const field = /^( {2})(\w+:)(\s+)(.*)$/.exec(line)
  if (!field) return line
  let value = field[4]
  if (field[2] === "admin:") value = value.replace(/^(\S+)/, (url) => tui.c.accent(tui.c.underline(url)))
  else if (field[2] === "backend:") value = / answers /.test(value) ? tui.c.good(value) : /not answering/.test(value) ? tui.c.bad(value) : value
  else if (field[2] === "note:") value = tui.c.warn(value)
  else if (field[2] === "plan:" && /expir|grace|no seat/i.test(value)) value = tui.c.warn(value)
  return `${field[1]}${tui.c.dim(field[2])}${field[3]}${value}`
}

/**
 * A log line for people rather than log shippers: local time, a coloured
 * level, the event in bold, the fields dimmed, and the outcome of a request
 * coloured by how it went. Same fields as the machine format, same order.
 */
export const prettyLogLine = (tui: Tui, level: string, fields: Array<[string, string]>): string => {
  const c = tui.c
  const now = new Date()
  const time = c.dim(now.toTimeString().slice(0, 8))
  const tag = level === "error" ? c.bad("error") : level === "warn" ? c.warn("warn ") : c.info("info ")
  let event = ""
  const rest: string[] = []
  for (const [name, value] of fields) {
    if (name === "event") {
      event = value
      continue
    }
    let shown = value
    if (name === "outcome" || name === "ok") {
      shown = /^(ok|true)$/.test(value) ? c.good(value) : /^(cancelled)$/.test(value) ? c.warn(value) : c.bad(value)
      rest.push(`${c.dim(`${name}=`)}${shown}`)
      continue
    }
    rest.push(c.dim(`${name}=${value}`))
  }
  return `${time} ${tag} ${c.bold(event.padEnd(16))} ${rest.join(" ")}`.trimEnd()
}

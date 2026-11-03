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
        // twinny green, as on the admin page.
        accent: wrap(32, 39),
        good: wrap(32, 39),
        bad: wrap(31, 39),
        warn: wrap(33, 39),
        info: wrap(2, 22),
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
  public async select<T>(question: string, choices: Array<Choice<T>>, initial = 0, why?: string): Promise<T> {
    if (!choices.length) throw new Error(`No choices for "${question}".`)
    let index = Math.min(Math.max(initial, 0), choices.length - 1)
    if (!this.interactive) {
      this.step("info", question, choices[index].label)
      return choices[index].value
    }
    const { stdin } = this._streams
    // The question, what it is for, then the list; all of it folds into one line once answered.
    const height = choices.length + 1 + (why ? 1 : 0)
    const render = (first: boolean) => {
      if (!first) this.write(up(height))
      this.line(`${CLEAR}  ${this.c.accent("?")} ${this.c.bold(question)}  ${this.c.dim("↑↓ to move, Enter to pick")}`)
      if (why) this.line(`${CLEAR}    ${this.c.dim(why)}`)
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
    this.write(up(height))
    for (let i = 0; i < height; i++) this.line(CLEAR)
    this.write(up(height))
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

/** `/home/me/x` → `~/x` inside a value, for showing only. */
const tildeIn = (text: string, home: string | undefined): string => {
  if (!home || home === "/") return text
  return text
    .split(home)
    .map((part, i) => (i === 0 ? part : `${/^($|[/\s),])/.test(part) ? "~" : home}${part}`))
    .join("")
}

/** The order fields are shown in on a terminal; the rest follow in arrival order. */
const PRIMARY = ["admin", "models", "access", "plan", "demo", "pooling", "recording"]
const SECONDARY = ["limits", "config", "data", "usage", "health", "protocol"]
const LABEL: Record<string, string> = { admin: "Admin page", models: "Models", access: "Access", plan: "Plan", demo: "Demo", pooling: "Pooling", recording: "Recording", limits: "Limits", config: "Config", data: "Data", usage: "Usage", health: "Health", protocol: "Protocol" }
const LABEL_WIDTH = 12

/**
 * The serve banner, laid out for a person at a terminal. The gateway prints
 * it as plain `  name: value` lines (what pipes, logs and tests read); here
 * they are held until the banner is complete, then shown grouped: the
 * address and what people need first, the plumbing dimmed below, notes
 * last. Lines that are not banner lines pass straight through, after the
 * banner. Off a colour terminal, use the lines as they are.
 */
export class BannerPrinter {
  private _held: Array<[string, string]> | undefined
  private _header: { version: string; url: string } | undefined
  private _flushTimer: NodeJS.Immediate | undefined

  constructor(
    private readonly _tui: Tui,
    private readonly _home: string | undefined = process.env.HOME
  ) {}

  /** One line the gateway printed to stdout. */
  public out(line: string): void {
    const header = /^Twinny gateway (\S+) listening on (\S+)$/.exec(line)
    if (header) {
      this.flush()
      this._header = { version: header[1], url: header[2] }
      this._held = []
      // Everything after the header is printed in the same tick; a slow
      // caller still gets the banner on the next one.
      this._flushTimer = setImmediate(() => this.flush())
      this._flushTimer.unref?.()
      return
    }
    const field = /^ {2}([a-z]+):\s+(.*)$/.exec(line)
    if (field && this._held) {
      this._held.push([field[1], field[2]])
      return
    }
    this.flush()
    if (field?.[1] === "backend") {
      this._tui.line(this._backend(field[2]))
      return
    }
    if (field?.[1] === "note") {
      this._tui.line(`  ${this._tui.c.warn(this._tui.g.warn)} ${tildeIn(field[2], this._home)}`)
      return
    }
    this._tui.line(line)
  }

  /** Before anything else reaches the screen (a log line on stderr), the banner goes first. */
  public flush(): void {
    if (this._flushTimer) clearImmediate(this._flushTimer)
    this._flushTimer = undefined
    const held = this._held
    const header = this._header
    this._held = undefined
    this._header = undefined
    if (!held || !header) return
    const { c, g } = this._tui
    const value = (name: string) => held.find(([n]) => n === name)?.[1]
    const row = (name: string, text: string, dim = false) => {
      const label = (LABEL[name] ?? name.charAt(0).toUpperCase() + name.slice(1)).padEnd(LABEL_WIDTH)
      this._tui.line(`  ${c.dim(label)}${dim ? c.dim(text) : text}`)
    }
    const protocol = value("protocol")?.split(" at ")[0]
    this._tui.line("")
    this._tui.line(`  ${c.bold("twinny-server")} ${c.dim(header.version)}`)
    this._tui.line(`  ${c.good("●")} ${c.bold("Listening")} on ${c.bold(c.underline(header.url))}${protocol ? c.dim(`  ${g.bullet} ${protocol}`) : ""}`)
    this._tui.line("")

    const shown = new Set<string>(["protocol", "note"])
    const notes = held.filter(([n]) => n === "note").map(([, v]) => v)
    for (const name of PRIMARY) {
      const text = value(name)
      if (text === undefined) continue
      shown.add(name)
      row(name, this._primary(name, text))
    }
    for (const [name, text] of held) {
      if (shown.has(name) || SECONDARY.includes(name)) continue
      shown.add(name)
      row(name, tildeIn(text, this._home))
    }
    const rest = SECONDARY.filter((name) => !shown.has(name) && value(name) !== undefined)
    if (rest.length) this._tui.line("")
    for (const name of rest) row(name, tildeIn(value(name) ?? "", this._home), true)
    if (notes.length) this._tui.line("")
    for (const note of notes) this._tui.line(`  ${c.warn(g.warn)} ${tildeIn(note, this._home)}`)
    this._tui.line("")
  }

  private _primary(name: string, text: string): string {
    const { c, g } = this._tui
    const sep = c.dim(` ${g.bullet} `)
    if (name === "admin") {
      const match = /^(\S+)\s*(?:\((.*)\))?$/.exec(text)
      return match ? `${c.accent(c.bold(c.underline(match[1])))}${match[2] ? c.dim(`  ${match[2]}`) : ""}` : text
    }
    if (name === "models") {
      // `3 aliases (chat: chat, coder: fim, embed: embeddings)`
      const list = /\((.*)\)$/.exec(text)?.[1]
      if (!list) return text
      return list
        .split(", ")
        .map((entry) => {
          const [alias, caps] = entry.split(": ")
          return caps ? `${alias} ${c.dim(caps)}` : alias
        })
        .join(sep)
    }
    if (name === "plan") return /expir|grace|no seat|invalid/i.test(text) ? c.warn(text) : text.split(", ").join(sep)
    if (name === "recording") return tildeIn(text, this._home).replace(/ · /g, sep)
    return tildeIn(text, this._home)
  }

  private _backend(text: string): string {
    const { c, g } = this._tui
    const answers = /^(\S+) answers \((\d+) ms\)$/.exec(text)
    if (answers) return `  ${c.good(g.ok)} ${c.bold(answers[1])} answers ${c.dim(`in ${answers[2]} ms`)}`
    const down = /^(\S+) is not answering (.*)$/.exec(text)
    if (down) return `  ${c.bad(g.bad)} ${c.bold(down[1])} is not answering ${c.dim(down[2])}`
    return `  ${c.dim(g.info)} ${text}`
  }
}

/** Events the terminal banner shows already; the machine log keeps them. */
const BANNER_EVENTS = new Set(["gateway.started", "backend.probe"])

const OUTCOME_MARK = (tui: Tui, outcome: string): string =>
  /^(ok|true)$/.test(outcome) ? tui.c.good(tui.g.ok) : outcome === "cancelled" ? tui.c.dim("○") : tui.c.bad(tui.g.bad)

const duration = (ms: string): string => {
  const n = Number(ms)
  if (!Number.isFinite(n)) return ms
  return n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} s`
}

/**
 * A log line for people rather than log shippers: local time, then the
 * event. A request reads as one row (outcome, route, alias, who, how long);
 * anything else as the event and its fields, dimmed. Warnings and errors
 * say so in colour. Same fields as the machine format, same order, except
 * the startup events the banner shows already.
 */
export const prettyLogLine = (tui: Tui, level: string, fields: Array<[string, string]>): string | undefined => {
  const c = tui.c
  const time = c.dim(new Date().toTimeString().slice(0, 8))
  const get = (name: string) => fields.find(([n]) => n === name)?.[1]
  const event = get("event") ?? ""
  // The banner already says these, a line above.
  if (level === "info" && BANNER_EVENTS.has(event)) return undefined
  const tag = level === "error" ? `${c.bad("error")} ` : level === "warn" ? `${c.warn("warn")} ` : ""
  if (event === "request" && get("outcome")) {
    const outcome = get("outcome") ?? ""
    const route = (get("route") ?? "").padEnd(10)
    const alias = (get("alias") ?? "").padEnd(10)
    const who = (get("key") ?? "").padEnd(14)
    const took = duration(get("ms") ?? "").padStart(7)
    const skip = new Set(["event", "outcome", "route", "alias", "key", "ms", "id"])
    const extra = fields
      .filter(([name]) => !skip.has(name))
      .map(([name, value]) => (name === "kind" || name === "status") && outcome !== "ok" ? c.bad(value) : c.dim(`${name}=${value}`))
    return `  ${time}  ${tag}${OUTCOME_MARK(tui, outcome)} ${route} ${alias} ${c.dim(who)} ${took}  ${extra.join(" ")}`.trimEnd()
  }
  const rest: string[] = []
  for (const [name, value] of fields) {
    if (name === "event") continue
    if (name === "outcome" || name === "ok") {
      rest.push(`${c.dim(`${name}=`)}${/^(ok|true)$/.test(value) ? c.good(value) : value === "cancelled" ? c.dim(value) : c.bad(value)}`)
      continue
    }
    rest.push(c.dim(`${name}=${value}`))
  }
  const name = level === "info" ? c.dim(event.padEnd(18)) : c.bold(event.padEnd(18))
  return `  ${time}  ${tag}${name} ${rest.join(" ")}`.trimEnd()
}

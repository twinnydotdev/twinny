/**
 * Markdown and code for the admin page. Chat replies are markdown with
 * fenced code; autocomplete records are code with no fence at all. Both
 * end up in `CodeBlock`, which highlights with the light Prism build and
 * only the languages developers actually paste into an editor, so the
 * page stays a few hundred kilobytes rather than a few megabytes.
 *
 * The theme is VS Code's dark+, with its background dropped so the block
 * sits on the page's own panel colour.
 */
import React, { Children, createContext, isValidElement, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import Markdown, { Components } from "react-markdown"
import createElement from "react-syntax-highlighter/dist/esm/create-element"
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash"
import c from "react-syntax-highlighter/dist/esm/languages/prism/c"
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp"
import csharp from "react-syntax-highlighter/dist/esm/languages/prism/csharp"
import dart from "react-syntax-highlighter/dist/esm/languages/prism/dart"
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff"
import docker from "react-syntax-highlighter/dist/esm/languages/prism/docker"
import go from "react-syntax-highlighter/dist/esm/languages/prism/go"
import graphql from "react-syntax-highlighter/dist/esm/languages/prism/graphql"
import ini from "react-syntax-highlighter/dist/esm/languages/prism/ini"
import java from "react-syntax-highlighter/dist/esm/languages/prism/java"
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript"
import json from "react-syntax-highlighter/dist/esm/languages/prism/json"
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx"
import kotlin from "react-syntax-highlighter/dist/esm/languages/prism/kotlin"
import lua from "react-syntax-highlighter/dist/esm/languages/prism/lua"
import makefile from "react-syntax-highlighter/dist/esm/languages/prism/makefile"
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown"
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup"
import php from "react-syntax-highlighter/dist/esm/languages/prism/php"
import powershell from "react-syntax-highlighter/dist/esm/languages/prism/powershell"
import python from "react-syntax-highlighter/dist/esm/languages/prism/python"
import ruby from "react-syntax-highlighter/dist/esm/languages/prism/ruby"
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust"
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql"
import swift from "react-syntax-highlighter/dist/esm/languages/prism/swift"
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml"
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx"
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript"
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml"
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light"
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism"
import remarkGfm from "remark-gfm"

import { ExternalLink, httpUrl } from "./links"

import css from "react-syntax-highlighter/dist/esm/languages/prism/css"
import scss from "react-syntax-highlighter/dist/esm/languages/prism/scss"

const LANGUAGES: Record<string, unknown> = {
  bash, c, cpp, csharp, css, dart, diff, docker, go, graphql, ini, java, javascript, json, jsx, kotlin, lua,
  makefile, markdown, markup, php, powershell, python, ruby, rust, scss, sql, swift, toml, tsx, typescript, yaml
}
for (const [name, grammar] of Object.entries(LANGUAGES)) SyntaxHighlighter.registerLanguage(name, grammar)
SyntaxHighlighter.alias({
  bash: ["sh", "shell", "zsh", "console"],
  csharp: ["cs", "c#"],
  javascript: ["js", "mjs", "cjs"],
  typescript: ["ts", "mts", "cts"],
  markup: ["html", "xml", "svg", "vue", "svelte"],
  markdown: ["md"],
  python: ["py"],
  ruby: ["rb"],
  rust: ["rs"],
  kotlin: ["kt"],
  yaml: ["yml"],
  docker: ["dockerfile"],
  powershell: ["ps1", "pwsh"],
  makefile: ["make"],
  cpp: ["c++", "cc", "hpp"]
})

/** Fence names this page can colour; anything else renders as plain text. */
const KNOWN = new Set([
  ...Object.keys(LANGUAGES),
  "sh", "shell", "zsh", "console", "cs", "c#", "js", "mjs", "cjs", "ts", "mts", "cts", "html", "xml", "svg", "vue",
  "svelte", "md", "py", "rb", "rs", "kt", "yml", "dockerfile", "ps1", "pwsh", "make", "c++", "cc", "hpp"
])

export const normalizeLanguage = (name: string | undefined): string => {
  const lower = (name ?? "").trim().toLowerCase()
  return lower && KNOWN.has(lower) ? lower : "text"
}

/**
 * A guess for code that arrived with no language, which is every
 * autocomplete record. Looks for a few unmistakable shapes; a wrong guess
 * only miscolours, so the list stays short.
 */
export const guessLanguage = (code: string): string => {
  const head = code.slice(0, 4000)
  const tests: Array<[RegExp, string]> = [
    [/^\s*<\?php/m, "php"],
    [/^\s*(import\s+React|export\s+(default\s+)?(function|const|class)|const\s+\w+\s*[:=]\s*\(?[^)]*\)?\s*=>)/m, "tsx"],
    [/(^|\n)\s*(interface|type)\s+\w+\s*(<[^>]*>)?\s*[={]|:\s*(string|number|boolean)\b/, "typescript"],
    [/^\s*(def |class \w+(\(.*\))?:|import \w+|from \w+ import|if __name__)/m, "python"],
    [/^\s*(package \w+|func (\(\w+ \*?\w+\) )?\w+\(|import \(\n)/m, "go"],
    [/^\s*(fn \w+|let mut |use \w+::|impl(<.*>)? \w+|pub (fn|struct|enum))/m, "rust"],
    [/^\s*(public|private|protected)\s+(static\s+)?(class|void|int|String)\b/m, "java"],
    [/^\s*#include\s*[<"]/m, "cpp"],
    [/^\s*(using System|namespace \w+;|public (sealed |static )?class)/m, "csharp"],
    [/^\s*(require ['"]|def \w+.*\n[\s\S]*?\bend\b|puts )/m, "ruby"],
    [/^\s*(SELECT|INSERT INTO|CREATE TABLE|UPDATE \w+ SET)\b/im, "sql"],
    [/^\s*(#!\/bin\/(ba)?sh|set -e|echo |export \w+=)/m, "bash"],
    [/^\s*(FROM \w+[:\w.-]*\s*$|RUN |COPY |ENTRYPOINT )/m, "docker"],
    [/^\s*[{[]\s*(\n\s*"[^"]+"\s*:)/, "json"],
    [/^\s*<(!doctype|html|div|span|template|section)\b/im, "markup"],
    [/^\s*[.#]?[\w-]+\s*\{[^}]*:[^}]*\}/m, "css"],
    [/^\s*\w[\w-]*:\s*(\S.*)?$/m, "yaml"],
    [/^\s*(function\s+\w+|const\s+\w+\s*=|let\s+\w+\s*=|module\.exports|require\()/m, "javascript"]
  ]
  for (const [pattern, language] of tests) if (pattern.test(head)) return language
  return "text"
}

/*
 * react-markdown hands <code> children as a string most of the time, but
 * a block that contains entities arrives as an array; flatten by hand.
 */
const toText = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(toText).join("")
  if (isValidElement<{ children?: ReactNode }>(node)) return toText(node.props.children)
  return Children.toArray(node).map(toText).join("")
}

const PRE = "pre[class*=\"language-\"]"
const CODE = "code[class*=\"language-\"]"
const THEME: Record<string, React.CSSProperties> = {
  ...vscDarkPlus,
  [PRE]: { ...vscDarkPlus[PRE], background: "transparent", margin: 0, padding: 0 },
  [CODE]: { ...vscDarkPlus[CODE], background: "transparent", fontFamily: "inherit", fontSize: "inherit" }
}

export const CopyButton = ({ text, label = "copy" }: { text: string; label?: string }) => {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // No clipboard on this origin; the text is selectable.
    }
  }
  return (
    <button type="button" className={`mini ${copied ? "on" : "ghost"}`} onClick={() => void copy()} aria-label={copied ? "Copied" : label}>
      {copied ? "copied" : label}
    </button>
  )
}

interface CodeBlockProps {
  code: string
  language?: string
  /** A caption instead of the language name, e.g. "before the cursor". */
  title?: ReactNode
  /** Something at the right of the bar besides the copy button. */
  extra?: ReactNode
  bare?: boolean
  /** Marks the block as the model's own words: an accent edge. */
  tone?: "reply" | "context" | "plain"
  className?: string
  wrap?: boolean
}

/** Highlighted code with a bar naming the language and a copy button. */
export const CodeBlock = ({ code, language, title, extra, bare, tone = "plain", className, wrap }: CodeBlockProps) => {
  const lang = normalizeLanguage(language)
  const empty = code.length === 0
  return (
    <div className={`code ${tone} ${bare ? "bare" : ""} ${className ?? ""}`}>
      {!bare && (
        <div className="code-bar">
          <span className="code-lang">{title ?? lang}</span>
          <span className="code-actions">
            {extra}
            {!empty && <CopyButton text={code} />}
          </span>
        </div>
      )}
      {empty ? (
        <div className="code-empty">empty</div>
      ) : (
        <SyntaxHighlighter language={lang} style={THEME} PreTag="pre" wrapLongLines={wrap}>
          {code}
        </SyntaxHighlighter>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  A listing with an insertion marked                                        */
/* -------------------------------------------------------------------------- */

/** The highlighter's token tree: nested spans over text (its `rendererNode`). */
type TokenNode = Parameters<typeof createElement>[0]["node"]

export interface CharRange {
  start: number
  end: number
}

const rowText = (node: TokenNode): string =>
  node.type === "text" ? String(node.value ?? "") : (node.children ?? []).map(rowText).join("")
const textLength = (node: TokenNode): number => rowText(node).length

/** Wraps the part of the text inside `range` in a span, splitting tokens where the range starts or ends. */
const markRange = (node: TokenNode, range: CharRange, cursor: { at: number }): TokenNode[] => {
  if (node.type === "text") {
    const value = String(node.value ?? "")
    const s = cursor.at
    const e = s + value.length
    cursor.at = e
    const a = Math.max(range.start, s)
    const b = Math.min(range.end, e)
    if (a >= b) return [node]
    const out: TokenNode[] = []
    if (a > s) out.push({ type: "text", value: value.slice(0, a - s) })
    out.push({ type: "element", tagName: "span", properties: { className: ["ins"] }, children: [{ type: "text", value: value.slice(a - s, b - s) }] })
    if (b < e) out.push({ type: "text", value: value.slice(b - s) })
    return out
  }
  return [{ ...node, children: (node.children ?? []).flatMap((child) => markRange(child, range, cursor)) }]
}

interface ListingProps {
  code: string
  language?: string
  /** Characters of `code` that were inserted, lit like an added line in a diff. */
  insert?: CharRange
  startingLineNumber?: number
}

/**
 * Highlighted code with a line-number gutter, and an inserted range marked
 * the way a review tool marks a change: the lines it touches get a tinted
 * background, the exact characters a stronger one. The rendering is a
 * custom row renderer so the mark can start and end mid-token.
 */
export const Listing = ({ code, language, insert, startingLineNumber = 1 }: ListingProps) => {
  const lang = normalizeLanguage(language)
  const renderer = useCallback(
    ({ rows, stylesheet, useInlineStyles }: { rows: TokenNode[]; stylesheet: Record<string, React.CSSProperties>; useInlineStyles: boolean }) => {
      let offset = 0
      return rows.map((row, i) => {
        const rowStart = offset
        const rowEnd = rowStart + textLength(row)
        offset = rowEnd
        // A row is touched when the insertion covers some of its text, or the
        // whole row; not when it merely begins with the row's own newline.
        const text = textLength(row)
        const contentEnd = rowStart + (String(rowText(row)).endsWith("\n") ? text - 1 : text)
        const touched = !!insert && insert.end > insert.start && ((insert.end > rowStart && insert.start < contentEnd) || (insert.start <= rowStart && insert.end >= rowEnd))
        const node = touched && insert ? markRange(row, insert, { at: rowStart })[0] : row
        const children = (node.children ?? []).map((child, k) =>
          createElement({ node: child, stylesheet, useInlineStyles, key: `${i}-${k}` })
        )
        return (
          <span key={i} className={touched ? "row ins-line" : "row"}>
            <span className="ln" aria-hidden="true">
              {startingLineNumber + i}
            </span>
            {children}
          </span>
        )
      })
    },
    [insert, startingLineNumber]
  )
  if (!code) return <div className="code-empty">empty</div>
  return (
    <SyntaxHighlighter language={lang} style={THEME} PreTag="pre" wrapLines renderer={renderer}>
      {code}
    </SyntaxHighlighter>
  )
}

/* -------------------------------------------------------------------------- */
/*  A unified diff, highlighted in the file's language                        */
/* -------------------------------------------------------------------------- */

type DiffKind = "add" | "del" | "ctx" | "hunk" | "meta"

interface DiffLine {
  kind: DiffKind
  /** The line without its +/-/space prefix; hunk headers keep their text. */
  text: string
  oldNo?: number
  newNo?: number
}

/** Splits a unified-diff patch into lines with old/new numbers from the hunk headers. */
export const parsePatch = (patch: string): DiffLine[] => {
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  for (const raw of patch.replace(/\n$/, "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      out.push({ kind: "hunk", text: raw })
    } else if (raw.startsWith("+")) out.push({ kind: "add", text: raw.slice(1), newNo: newNo++ })
    else if (raw.startsWith("-")) out.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ })
    else if (raw.startsWith("\\")) out.push({ kind: "meta", text: raw })
    else out.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo: oldNo++, newNo: newNo++ })
  }
  return out
}

/** Lines picked out of a diff with the mouse: their text with the +/- signs, and where they are. */
export interface DiffSelection {
  text: string
  /** Numbered as in the new file; a removed line by its old number. */
  startLine?: number
  endLine?: number
}

interface DiffBlockProps {
  patch: string
  /** The file's language, so tokens are lit as in an editor; the +/- only tint the line. */
  language?: string
  title?: ReactNode
  extra?: ReactNode
  /** Offered over a selection of lines, with `pickLabel` on the button. */
  onPick?: (selection: DiffSelection) => void
  pickLabel?: string
  /** Shown under the diff, inside its frame. */
  footer?: ReactNode
}

/** The lines of a diff a selection covers, read from the patch and not from the screen, so the signs come along. */
const selectionIn = (pre: Element, lines: DiffLine[]): { selection: DiffSelection; at: { top: number; left: number } } | undefined => {
  const picked = document.getSelection()
  if (!picked || picked.isCollapsed || picked.rangeCount === 0) return undefined
  const range = picked.getRangeAt(0)
  if (!pre.contains(range.startContainer) || !pre.contains(range.endContainer)) return undefined
  const rows = Array.from(pre.querySelectorAll<HTMLElement>("[data-row]")).filter((row) => range.intersectsNode(row))
  // A selection that only touches a row's edge (a triple click ends at the start of the next line) does not take it.
  const holds = (row: HTMLElement): boolean => {
    const source = row.querySelector(".src")
    if (!source) return false
    const part = document.createRange()
    part.selectNodeContents(source)
    if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset)
    if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset)
    return part.toString().replace(/\n/g, "") !== ""
  }
  while (rows.length > 1 && !holds(rows[rows.length - 1])) rows.pop()
  while (rows.length > 1 && !holds(rows[0])) rows.shift()
  const chosen = rows.flatMap((row) => {
    const line = lines[Number(row.dataset.row)]
    return line && line.kind !== "meta" ? [line] : []
  })
  if (chosen.length === 0 || (chosen.length === 1 && !holds(rows[0]))) return undefined
  const numbered = chosen.filter((line) => line.kind !== "hunk")
  const numberOf = (line?: DiffLine): number | undefined => line?.newNo ?? line?.oldNo
  const text = chosen.map((line) => (line.kind === "hunk" ? line.text : `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`)).join("\n")
  const rects = range.getClientRects()
  const last = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect()
  // Scrolled out of the diff's own window, or off the page: there is nowhere to put the button.
  const view = pre.getBoundingClientRect()
  if (last.bottom < Math.max(view.top, 0) || last.top > Math.min(view.bottom, window.innerHeight)) return undefined
  return {
    selection: { text, ...(numberOf(numbered[0]) ? { startLine: numberOf(numbered[0]), endLine: numberOf(numbered[numbered.length - 1]) } : {}) },
    at: { top: Math.min(last.bottom + 6, window.innerHeight - 44), left: Math.max(8, Math.min(last.right - 20, window.innerWidth - 230)) }
  }
}

/**
 * A patch as a review tool shows it: code highlighted in its own language,
 * added lines tinted green and removed ones red, old and new line numbers
 * in the gutter. Hunk headers are shown as they are.
 */
export const DiffBlock = ({ patch, language, title, extra, onPick, pickLabel = "Use these lines", footer }: DiffBlockProps) => {
  const lang = normalizeLanguage(language)
  const lines = useMemo(() => parsePatch(patch), [patch])
  const frame = useRef<HTMLDivElement>(null)
  const [pick, setPick] = useState<ReturnType<typeof selectionIn>>()
  const canPick = onPick !== undefined
  useEffect(() => {
    if (!canPick) return
    // Read once the mouse or the keys let go: the button must not chase a selection being dragged.
    const read = () =>
      window.setTimeout(() => {
        const pre = frame.current?.querySelector("pre")
        setPick(pre ? selectionIn(pre, lines) : undefined)
      }, 0)
    const clear = () => setPick(undefined)
    const dropped = () => {
      if (document.getSelection()?.isCollapsed !== false) clear()
    }
    // The button is placed on the window, so it follows the selection when anything scrolls.
    let frameId = 0
    const follow = () => {
      if (frameId) return
      frameId = window.requestAnimationFrame(() => {
        frameId = 0
        const pre = frame.current?.querySelector("pre")
        setPick((shown) => (shown && pre ? selectionIn(pre, lines) : shown))
      })
    }
    document.addEventListener("mouseup", read)
    document.addEventListener("keyup", read)
    document.addEventListener("selectionchange", dropped)
    window.addEventListener("scroll", follow, true)
    window.addEventListener("resize", follow)
    return () => {
      document.removeEventListener("mouseup", read)
      document.removeEventListener("keyup", read)
      document.removeEventListener("selectionchange", dropped)
      window.removeEventListener("scroll", follow, true)
      window.removeEventListener("resize", follow)
      if (frameId) window.cancelAnimationFrame(frameId)
    }
  }, [canPick, lines])
  // The highlighter sees the code without diff markers, one row per line.
  const code = useMemo(() => lines.map((line) => (line.kind === "hunk" || line.kind === "meta" ? "" : line.text)).join("\n"), [lines])
  const renderer = useCallback(
    ({ rows, stylesheet, useInlineStyles }: { rows: TokenNode[]; stylesheet: Record<string, React.CSSProperties>; useInlineStyles: boolean }) =>
      rows.map((row, i) => {
        const line = lines[i]
        if (!line) return null
        const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "
        if (line.kind === "hunk" || line.kind === "meta")
          return (
            <span key={i} className={`row ${line.kind}-line`} data-row={i}>
              <span className="ln" aria-hidden="true" />
              <span className="ln" aria-hidden="true" />
              <span className="sign" aria-hidden="true" />
              <span className="src">
                {line.text}
                {"\n"}
              </span>
            </span>
          )
        const children = (row.children ?? []).map((child, k) => createElement({ node: child, stylesheet, useInlineStyles, key: `${i}-${k}` }))
        return (
          <span key={i} className={`row ${line.kind}-line`} data-row={i}>
            <span className="ln" aria-hidden="true">
              {line.oldNo ?? ""}
            </span>
            <span className="ln" aria-hidden="true">
              {line.newNo ?? ""}
            </span>
            <span className="sign" aria-hidden="true">
              {sign}
            </span>
            <span className="src">{children}</span>
          </span>
        )
      }),
    [lines]
  )
  return (
    <div className="code diff-block" ref={frame}>
      <div className="code-bar">
        <span className="code-lang">{title ?? lang}</span>
        <span className="code-actions">
          {extra}
          {patch && <CopyButton text={patch} />}
        </span>
      </div>
      {patch ? (
        <SyntaxHighlighter language={lang} style={THEME} PreTag="pre" wrapLines renderer={renderer}>
          {code}
        </SyntaxHighlighter>
      ) : (
        <div className="code-empty">no diff</div>
      )}
      {pick && onPick && (
        <button
          type="button"
          className="diff-pick"
          style={{ top: pick.at.top, left: pick.at.left }}
          // Taking the press keeps the selection lit while the button is clicked.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onPick(pick.selection)
            setPick(undefined)
            // The lines are named where the question is asked; left selected, the button would come back.
            document.getSelection()?.removeAllRanges()
          }}
        >
          {pickLabel}
        </button>
      )}
      {footer}
    </div>
  )
}

const components: Components = {
  code({ className, children }) {
    const match = /language-([\w#+.-]+)/.exec(className ?? "")
    const text = toText(children)
    const inline = !match && !text.includes("\n")
    if (inline) return <code className="md-inline">{children}</code>
    return <CodeBlock code={text.replace(/\n$/, "")} language={match?.[1]} />
  },
  // The block wrapper: CodeBlock already renders its own <pre>.
  pre({ children }) {
    return <>{children}</>
  },
  a({ href, children }) {
    return <ExternalLink href={href}>{children}</ExternalLink>
  },
  img({ alt, src, width }) {
    return <MdImage alt={alt} src={src} width={width} />
  },
  table({ children }) {
    return (
      <div className="md-table">
        <table>{children}</table>
      </div>
    )
  }
}

/** Fetches an image through the gateway and answers a data: address for it, or nothing when it cannot be had. */
export type ImageLoader = (url: string) => Promise<string | undefined>

const ImageLoaderContext = createContext<ImageLoader | undefined>(undefined)

/**
 * An image in a description. The page loads nothing from outside itself,
 * so the image comes through the gateway when there is a loader for it
 * and the host can supply it; otherwise it is named and linked.
 */
const MdImage = ({ alt, src, width }: { alt?: string; src?: string; width?: string | number }) => {
  const load = useContext(ImageLoaderContext)
  const address = httpUrl(src)
  const [state, setState] = useState<{ data?: string; done: boolean }>({ done: false })
  useEffect(() => {
    let alive = true
    setState({ done: false })
    if (!load || !address) return
    load(address)
      .then((data) => alive && setState({ data, done: true }))
      .catch(() => alive && setState({ done: true }))
    return () => {
      alive = false
    }
  }, [load, address])
  if (state.data)
    return (
      <ExternalLink href={src} className="md-picture" title="Open the image in a new tab">
        <img src={state.data} alt={alt ?? ""} width={width} />
      </ExternalLink>
    )
  const waiting = Boolean(load && address) && !state.done
  return (
    <ExternalLink href={src} className={`md-image ${waiting ? "loading" : ""}`} title={address ? "Open the image in a new tab" : undefined}>
      {alt ? `image: ${alt}` : "image"}
    </ExternalLink>
  )
}

interface MdNode {
  type: string
  value?: string
  url?: string
  alt?: string
  data?: { hProperties?: Record<string, string> }
  children?: MdNode[]
}

const HTML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'" }
const unescapeHtml = (text: string): string => text.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, name: string) => HTML_ENTITIES[name])
const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag)
  return match ? unescapeHtml(match[1] ?? match[2] ?? match[3] ?? "") : undefined
}

/**
 * What a run of raw HTML becomes, or nothing when it holds anything this
 * does not know. Forges let a description carry HTML, and pasted
 * screenshots arrive as <img> tags: those become images (shown as links,
 * like any other) and <br> a line break.
 */
const htmlToNodes = (html: string): MdNode[] | undefined => {
  const nodes: MdNode[] = []
  const rest = html.replace(/<img\b[^>]*>|<br\s*\/?>/gi, (tag) => {
    if (/^<img/i.test(tag)) {
      // The width a screenshot was pasted at: without it a phone capture fills the page.
      const width = attribute(tag, "width")
      nodes.push({ type: "image", url: attribute(tag, "src") ?? "", alt: attribute(tag, "alt") ?? "", ...(width && /^[0-9]{1,4}$/.test(width) ? { data: { hProperties: { width } } } : {}) })
    }
    else if (/^<br/i.test(tag)) nodes.push({ type: "break" })
    return ""
  })
  return rest.trim() ? undefined : nodes
}

/** Rewrites the raw HTML it understands; the rest stays as the text it was written as. */
const remarkForgeHtml = () => (tree: MdNode) => {
  const walk = (node: MdNode) => {
    if (!node.children) return
    node.children = node.children.flatMap((child): MdNode[] => {
      if (child.type !== "html" || typeof child.value !== "string") {
        walk(child)
        return [child]
      }
      const nodes = htmlToNodes(child.value)
      if (!nodes) return [child]
      // An HTML node between blocks holds inline things: give them a paragraph.
      const block = node.type === "root" || node.type === "blockquote" || node.type === "listItem"
      return block ? (nodes.length ? [{ type: "paragraph", children: nodes }] : []) : nodes
    })
  }
  walk(tree)
}

/** Markdown as the chat sidebar would show it: GFM, fenced code highlighted. */
export const MarkdownView = ({ text, className, images }: { text: string; className?: string; images?: ImageLoader }) => {
  const plugins = useMemo(() => [remarkGfm, remarkForgeHtml], [])
  return (
    <div className={`md ${className ?? ""}`}>
      <ImageLoaderContext.Provider value={images}>
        <Markdown remarkPlugins={plugins} components={components}>
          {text}
        </Markdown>
      </ImageLoaderContext.Provider>
    </div>
  )
}

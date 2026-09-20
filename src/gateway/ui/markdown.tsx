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
import React, { Children, isValidElement, ReactNode, useCallback, useMemo, useState } from "react"
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

interface DiffBlockProps {
  patch: string
  /** The file's language, so tokens are lit as in an editor; the +/- only tint the line. */
  language?: string
  title?: ReactNode
  extra?: ReactNode
}

/**
 * A patch as a review tool shows it: code highlighted in its own language,
 * added lines tinted green and removed ones red, old and new line numbers
 * in the gutter. Hunk headers are shown as they are.
 */
export const DiffBlock = ({ patch, language, title, extra }: DiffBlockProps) => {
  const lang = normalizeLanguage(language)
  const lines = useMemo(() => parsePatch(patch), [patch])
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
            <span key={i} className={`row ${line.kind}-line`}>
              <span className="ln" aria-hidden="true" />
              <span className="ln" aria-hidden="true" />
              <span className="sign" aria-hidden="true" />
              {line.text}
              {"\n"}
            </span>
          )
        const children = (row.children ?? []).map((child, k) => createElement({ node: child, stylesheet, useInlineStyles, key: `${i}-${k}` }))
        return (
          <span key={i} className={`row ${line.kind}-line`}>
            <span className="ln" aria-hidden="true">
              {line.oldNo ?? ""}
            </span>
            <span className="ln" aria-hidden="true">
              {line.newNo ?? ""}
            </span>
            <span className="sign" aria-hidden="true">
              {sign}
            </span>
            {children}
          </span>
        )
      }),
    [lines]
  )
  return (
    <div className="code diff-block">
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
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    )
  },
  table({ children }) {
    return (
      <div className="md-table">
        <table>{children}</table>
      </div>
    )
  }
}

/** Markdown as the chat sidebar would show it: GFM, fenced code highlighted. */
export const MarkdownView = ({ text, className }: { text: string; className?: string }) => {
  const plugins = useMemo(() => [remarkGfm], [])
  return (
    <div className={`md ${className ?? ""}`}>
      <Markdown remarkPlugins={plugins} components={components}>
        {text}
      </Markdown>
    </div>
  )
}

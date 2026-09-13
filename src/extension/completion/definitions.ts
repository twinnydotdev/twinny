import {
  CancellationToken,
  commands,
  Location,
  LocationLink,
  Position,
  Range,
  TextDocument,
  Uri,
  workspace
} from "vscode"

import { FimContextFile } from "../../common/types"
import { enclosingRange } from "../embeddings/expand"

import { getParser } from "./parser"

/** Identifiers looked up per completion, nearest the cursor first. */
const MAX_IDENTIFIERS = 4
/** Lines above the cursor scanned for identifiers. */
const SCAN_LINES = 3
/** Characters one definition may take, and all of them together. */
const DEFINITION_CHARS = 1000
const TOTAL_CHARS = 2500
/** Lines shown from a definition when its file has no grammar or is huge. */
const FALLBACK_LINES = 8
/** Files past this many lines are not parsed on a keystroke. */
const PARSE_LINE_LIMIT = 4000
/** All lookups for one completion share this budget. */
const TIMEOUT_MS = 250
/** A looked-up definition is reused for this long. */
const CACHE_TTL_MS = 30_000
const CACHE_SIZE = 200

/** Words that read as identifiers but never have a definition worth reading. */
const KEYWORDS = new Set([
  "abstract", "and", "any", "arguments", "array", "as", "assert", "async",
  "await", "bool", "boolean", "break", "byte", "case", "catch", "char",
  "class", "const", "constructor", "continue", "debugger", "def", "default",
  "del", "delete", "do", "double", "elif", "else", "enum", "except",
  "export", "extends", "false", "final", "finally", "float", "fn", "for",
  "from", "function", "get", "global", "goto", "if", "impl", "implements",
  "import", "in", "instanceof", "int", "interface", "is", "lambda", "let",
  "long", "loop", "match", "mod", "module", "mut", "namespace", "new",
  "none", "not", "null", "number", "object", "of", "or", "override",
  "package", "pass", "private", "protected", "pub", "public", "raise",
  "readonly", "record", "ref", "return", "self", "set", "short", "static",
  "string", "struct", "super", "switch", "this", "throw", "throws", "trait",
  "true", "try", "type", "typeof", "undefined", "union", "unsigned", "use",
  "using", "var", "void", "where", "while", "with", "yield"
])

export interface IdentifierAt {
  name: string
  /** Offset of the identifier's first character within the scanned text. */
  offset: number
}

/** String literals blanked out, offsets kept, so their words are not names. */
const maskStrings = (text: string) =>
  text.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (literal) =>
    " ".repeat(literal.length)
  )

/**
 * The identifiers in a piece of code, nearest the end first, each once,
 * without keywords, very short names or the contents of strings. The end
 * is where the cursor is, so the names the user just typed come first.
 */
export const scanIdentifiers = (text: string): IdentifierAt[] => {
  const seen = new Set<string>()
  const found: IdentifierAt[] = []
  for (const match of maskStrings(text).matchAll(/[A-Za-z_$][\w$]*/g)) {
    const name = match[0]
    if (name.length < 3 || KEYWORDS.has(name.toLowerCase())) continue
    found.push({ name, offset: match.index ?? 0 })
  }
  return found.reverse().filter((item) => {
    if (seen.has(item.name)) return false
    seen.add(item.name)
    return true
  })
}

/** What the definition module needs of a parsed file. */
export interface DefinitionSource {
  lines: string[]
  /** The tree, when the file has a grammar and is small enough to parse. */
  root?: Parameters<typeof enclosingRange>[0]
}

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#)/

/** Where a comment block right above `line` starts, or `line` itself. */
const withLeadingComment = (lines: string[], line: number, maxChars: number, used: number) => {
  let start = line
  let chars = used
  while (start > 0 && COMMENT_LINE.test(lines[start - 1])) {
    chars += lines[start - 1].length + 1
    if (chars > maxChars) break
    start--
  }
  return start
}

/**
 * The text of a definition that starts on `line`: the whole declaration
 * when the tree says where it ends and it fits, otherwise the next few
 * lines up to a blank one, which is usually the signature. A comment
 * block right above comes along when there is room, since that is where
 * the parameters are explained.
 */
export const definitionText = (
  source: DefinitionSource,
  line: number,
  maxChars = DEFINITION_CHARS
): { text: string; startLine: number; endLine: number } | undefined => {
  const { lines, root } = source
  if (line < 0 || line >= lines.length) return undefined
  const range = root && enclosingRange(root, lines, line, line, maxChars)
  let start = range ? range[0] : line
  let end = range ? range[1] : line
  if (!range) {
    while (
      end + 1 < lines.length &&
      end - start + 1 < FALLBACK_LINES &&
      lines[end + 1].trim() !== ""
    ) {
      end++
    }
  }
  const body = lines.slice(start, end + 1).join("\n")
  start = withLeadingComment(lines, start, maxChars, body.length)
  let text = lines.slice(start, end + 1).join("\n")
  if (text.length > maxChars) text = text.slice(0, maxChars)
  if (!text.trim()) return undefined
  return { text, startLine: start, endLine: end }
}

type Definition = Location | LocationLink

/** A definition read from its file, with where it is for de-duplication. */
interface Found extends FimContextFile {
  uri: string
  startLine: number
  endLine: number
}

const targetOf = (definition: Definition): { uri: Uri; line: number } =>
  "targetUri" in definition
    ? {
        uri: definition.targetUri,
        line: (definition.targetSelectionRange ?? definition.targetRange).start.line
      }
    : { uri: definition.uri, line: definition.range.start.line }

/**
 * The definitions of the names just before the cursor, from the language
 * server, as extra context files for a completion. A model finishing
 * `total = applyDiscount(` does far better with `applyDiscount`'s
 * declaration in front of it than with a window of some recent file.
 *
 * Lookups are cheap on a warm language server but never free, so they run
 * in parallel under one timeout, are cached briefly per name, and skip
 * definitions the prompt already shows because they sit in the prefix or
 * suffix of the current file.
 */
export class DefinitionContext {
  private readonly _cache = new Map<string, { files: Found[]; at: number }>()
  private _pending = false

  async get(
    document: TextDocument,
    position: Position,
    /** Lines of the current file already in the prompt, inclusive. */
    visibleLines: [number, number],
    token: CancellationToken
  ): Promise<FimContextFile[]> {
    if (this._pending || token.isCancellationRequested) return []
    const from = new Position(Math.max(0, position.line - SCAN_LINES + 1), 0)
    const text = document.getText(new Range(from, position))
    const base = document.offsetAt(from)
    const identifiers = scanIdentifiers(text).slice(0, MAX_IDENTIFIERS)
    if (!identifiers.length) return []

    this._pending = true
    try {
      const lookups = identifiers.map((identifier) =>
        this.lookup(document, document.positionAt(base + identifier.offset), identifier.name, visibleLines)
      )
      const settled = await Promise.race([
        Promise.all(lookups),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), TIMEOUT_MS))
      ])
      if (!settled || token.isCancellationRequested) return []

      // The same declaration can be reached from two names (a function and
      // the module it came from, say): one copy is enough.
      const files: FimContextFile[] = []
      const shown: Found[] = []
      let remaining = TOTAL_CHARS
      for (const found of settled.flat()) {
        const overlaps = shown.some(
          (other) =>
            other.uri === found.uri &&
            other.startLine <= found.endLine &&
            other.endLine >= found.startLine
        )
        if (overlaps || found.text.length > remaining) continue
        shown.push(found)
        remaining -= found.text.length
        files.push({ name: found.name, text: found.text })
      }
      return files
    } finally {
      this._pending = false
    }
  }

  private async lookup(
    document: TextDocument,
    position: Position,
    name: string,
    visibleLines: [number, number]
  ): Promise<Found[]> {
    const key = `${document.uri.toString()}\n${name}`
    const cached = this._cache.get(key)
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.files

    let files: Found[] = []
    try {
      const definitions =
        (await commands.executeCommand<Definition[]>(
          "vscode.executeDefinitionProvider",
          document.uri,
          position
        )) || []
      const first = definitions[0]
      if (first) {
        const target = targetOf(first)
        const inPrompt =
          target.uri.toString() === document.uri.toString() &&
          target.line >= visibleLines[0] &&
          target.line <= visibleLines[1]
        if (!inPrompt) {
          const file = await this.read(target.uri, target.line)
          if (file) files = [file]
        }
      }
    } catch {
      files = []
    }
    this.remember(key, files)
    return files
  }

  private async read(uri: Uri, line: number): Promise<Found | undefined> {
    let target: TextDocument
    try {
      target = await workspace.openTextDocument(uri)
    } catch {
      return undefined
    }
    const lines = target.getText().split("\n")
    const source: DefinitionSource = { lines }
    let dispose = () => undefined as void
    if (target.lineCount <= PARSE_LINE_LIMIT) {
      try {
        const parser = await getParser(uri.fsPath)
        const tree = parser?.parse(target.getText())
        if (tree) {
          source.root = tree.rootNode
          dispose = () => tree.delete()
        }
      } catch {
        // No grammar or a parse failure: the line window below still works.
      }
    }
    try {
      const definition = definitionText(source, line)
      if (!definition) return undefined
      return {
        name: workspace.asRelativePath(uri),
        text: definition.text,
        uri: uri.toString(),
        startLine: definition.startLine,
        endLine: definition.endLine
      }
    } finally {
      dispose()
    }
  }

  private remember(key: string, files: Found[]) {
    if (this._cache.size >= CACHE_SIZE) {
      const oldest = this._cache.keys().next().value
      if (oldest !== undefined) this._cache.delete(oldest)
    }
    this._cache.set(key, { files, at: Date.now() })
  }
}

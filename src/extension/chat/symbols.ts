import * as path from "path"
import {
  commands,
  DocumentSymbol,
  Location,
  SymbolInformation,
  SymbolKind,
  Uri,
  window,
  workspace
} from "vscode"

import { ContextItem } from "../../common/types"

import { ContextEntry } from "./context-files"
import { decodeSymbolRef, encodeSymbolRef } from "./symbol-ref"

const MAX_RESULTS = 30

/** Symbols worth attaching whole: things with a body. */
const ATTACHABLE = new Set([
  SymbolKind.Class,
  SymbolKind.Constructor,
  SymbolKind.Enum,
  SymbolKind.Function,
  SymbolKind.Interface,
  SymbolKind.Method,
  SymbolKind.Module,
  SymbolKind.Namespace,
  SymbolKind.Struct,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Object,
  SymbolKind.Property,
  SymbolKind.TypeParameter
])

const toItem = (name: string, uri: Uri, line: number, kind: SymbolKind): ContextItem => {
  const relative = workspace.asRelativePath(uri, false)
  return {
    id: encodeSymbolRef({ path: relative, line, name }),
    category: "symbols",
    name,
    path: `${SymbolKind[kind].toLowerCase()} · ${relative}:${line + 1}`
  }
}

type AnySymbol = DocumentSymbol | SymbolInformation

const isDocumentSymbol = (symbol: AnySymbol): symbol is DocumentSymbol =>
  "children" in symbol && "range" in symbol

const flatten = (symbols: DocumentSymbol[], depth = 0): DocumentSymbol[] =>
  symbols.flatMap((symbol) => [
    symbol,
    ...(depth < 2 ? flatten(symbol.children || [], depth + 1) : [])
  ])

/** Language servers return either shape; nested ones are flattened. */
const allSymbols = async (uri: Uri): Promise<AnySymbol[]> => {
  const symbols =
    (await commands.executeCommand<AnySymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      uri
    )) || []
  const flat: AnySymbol[] = []
  for (const symbol of symbols) {
    if (isDocumentSymbol(symbol)) flat.push(...flatten([symbol]))
    else flat.push(symbol)
  }
  return flat
}

const rangeOf = (symbol: AnySymbol) =>
  isDocumentSymbol(symbol) ? symbol.range : symbol.location.range

/**
 * What the `@symbol` picker shows. Without a query: the active file's own
 * symbols, since that is usually what the question is about. With one: a
 * workspace-wide search through whatever language servers are running.
 */
export const searchSymbols = async (query: string): Promise<ContextItem[]> => {
  const trimmed = query.trim()
  if (!trimmed) {
    const document = window.activeTextEditor?.document
    if (!document || document.uri.scheme !== "file") return []
    return (await allSymbols(document.uri))
      .filter((symbol) => ATTACHABLE.has(symbol.kind))
      .slice(0, MAX_RESULTS)
      .map((symbol) =>
        toItem(symbol.name, document.uri, rangeOf(symbol).start.line, symbol.kind)
      )
  }

  const results =
    (await commands.executeCommand<SymbolInformation[]>(
      "vscode.executeWorkspaceSymbolProvider",
      trimmed
    )) || []
  return results
    .filter(
      (symbol) =>
        ATTACHABLE.has(symbol.kind) &&
        symbol.location.uri.scheme === "file" &&
        !/[\\/]node_modules[\\/]/.test(symbol.location.uri.fsPath)
    )
    .slice(0, MAX_RESULTS)
    .map((symbol) =>
      toItem(
        symbol.name,
        symbol.location.uri,
        symbol.location.range.start.line,
        symbol.kind
      )
    )
}

/**
 * The body of a mentioned symbol as it is now. The file's document symbols
 * are asked for again: the one starting on the remembered line wins, then
 * one with the same name (the file was edited above it), then nothing.
 */
export const readSymbolEntry = async (
  id: string
): Promise<ContextEntry | undefined> => {
  const ref = decodeSymbolRef(id)
  const root = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!ref || !root) return undefined

  const uri = Uri.file(path.join(root, ref.path))
  const document = await workspace.openTextDocument(uri).then(
    (doc) => doc,
    () => undefined
  )
  if (!document) return undefined

  const all = await allSymbols(uri)
  const symbol =
    all.find(
      (s) => s.name === ref.name && rangeOf(s).start.line === ref.line
    ) ||
    all.find((s) => rangeOf(s).start.line === ref.line) ||
    all.find((s) => s.name === ref.name)
  if (!symbol) return undefined

  const range = rangeOf(symbol)
  return {
    path: ref.path,
    content: document.getText(range),
    range: { startLine: range.start.line, endLine: range.end.line }
  }
}

/** For the file-location fallback: a symbol enclosing a line, if any. */
export const symbolAtLine = async (
  uri: Uri,
  line: number
): Promise<Location | undefined> => {
  const enclosing = (await allSymbols(uri))
    .filter((symbol) => {
      const range = rangeOf(symbol)
      return range.start.line <= line && range.end.line >= line
    })
    .sort(
      (a, b) =>
        rangeOf(a).end.line - rangeOf(a).start.line -
        (rangeOf(b).end.line - rangeOf(b).start.line)
    )[0]
  return enclosing ? new Location(uri, rangeOf(enclosing)) : undefined
}

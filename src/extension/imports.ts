import fs from "fs"
import path from "path"
import { TextDocument } from "vscode"

const JS_LIKE = new Set([
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact"
])

const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]

const isFile = (filePath: string) => {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

/**
 * Relative module specifiers the document imports, in order of appearance.
 * Only relative paths are returned: package imports can't be turned into a
 * file cheaply and are rarely what the user wants in a completion prompt.
 */
export const getRelativeImportSpecifiers = (
  text: string,
  languageId: string
): string[] => {
  const specifiers: string[] = []
  const add = (specifier: string | undefined) => {
    if (specifier && !specifiers.includes(specifier)) specifiers.push(specifier)
  }

  if (JS_LIKE.has(languageId)) {
    const pattern =
      /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g
    for (const match of text.matchAll(pattern)) add(match[1])
  } else if (languageId === "python") {
    const pattern = /^\s*from\s+(\.+[\w.]*)\s+import\b/gm
    for (const match of text.matchAll(pattern)) add(match[1])
  }

  return specifiers
}

/** Turns a relative specifier into an existing file path, or undefined. */
export const resolveImport = (
  documentPath: string,
  specifier: string,
  languageId: string
): string | undefined => {
  const dir = path.dirname(documentPath)

  if (JS_LIKE.has(languageId)) {
    const base = path.resolve(dir, specifier)
    const candidates = [
      base,
      ...JS_EXTENSIONS.map((ext) => base + ext),
      ...JS_EXTENSIONS.map((ext) => path.join(base, "index" + ext))
    ]
    // ESM TypeScript imports `./x.js` while the source is `./x.ts`.
    if (/\.[cm]?js$/.test(base)) {
      candidates.push(base.replace(/\.([cm]?)js$/, ".$1ts"))
      candidates.push(base.replace(/\.js$/, ".tsx"))
    }
    return candidates.find(isFile)
  }

  if (languageId === "python") {
    const match = /^(\.+)([\w.]*)$/.exec(specifier)
    if (!match) return undefined
    let base = dir
    for (let i = 1; i < match[1].length; i++) base = path.dirname(base)
    const target = path.join(base, ...(match[2] ? match[2].split(".") : []))
    return [target + ".py", path.join(target, "__init__.py")].find(isFile)
  }

  return undefined
}

/** Absolute paths of the local files this document imports, in import order. */
export const getImportedFiles = (document: TextDocument): string[] => {
  if (document.isUntitled) return []
  const documentPath = document.uri.fsPath
  const files: string[] = []
  for (const specifier of getRelativeImportSpecifiers(
    document.getText(),
    document.languageId
  )) {
    const resolved = resolveImport(documentPath, specifier, document.languageId)
    if (resolved && resolved !== documentPath && !files.includes(resolved)) {
      files.push(resolved)
    }
  }
  return files
}

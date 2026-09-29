import * as fs from "fs"
import * as path from "path"
import { ExtensionContext } from "vscode"

let context: ExtensionContext | null = null

export function setContext(extensionContext: ExtensionContext) {
  context = extensionContext
}

export function getContext() {
  return context
}

let root: string | undefined

/**
 * The folder holding package.json: the extension's install directory, or
 * the repository when running from source. Found by walking up from this
 * file, so the esbuild bundle (`out/index.js`) and the tsc tree used by the
 * tests (`out/extension/...`) agree on where assets are.
 */
export function extensionRoot(): string {
  if (root) return root
  if (context?.extensionPath) return (root = context.extensionPath)
  let dir = __dirname
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return (root = dir)
}

/** A file shipped with the extension, addressed from its root. */
export const assetPath = (...segments: string[]) =>
  path.join(extensionRoot(), ...segments)

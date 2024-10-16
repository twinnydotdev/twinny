import { ExtensionContext } from "vscode"

let context: ExtensionContext | null = null

export function setContext(extensionContext: ExtensionContext) {
  context = extensionContext
}

export function getContext() {
  return context
}

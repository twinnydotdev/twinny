import { ExtensionContext } from 'vscode'

let context: ExtensionContext | null = null

export function setContext(newContext: ExtensionContext) {
  context = newContext
}

export function getContext() {
  return context
}

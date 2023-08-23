import {
  commands,
  ExtensionContext,
  languages,
  StatusBarAlignment,
  window,
  workspace
} from 'vscode'

import { CompletionProvider } from './completion'

export function activate(context: ExtensionContext) {
  const config = workspace.getConfiguration('twinny')
  const statusBar = window.createStatusBarItem(StatusBarAlignment.Right)
  statusBar.text = '$(code)'
  statusBar.tooltip = 'twinny - Ready'

  context.subscriptions.push(
    languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      new CompletionProvider(statusBar)
    ),
    commands.registerCommand('twinny.enable', () => {
      statusBar.show()
    }),
    commands.registerCommand('twinny.disable', () => {
      statusBar.hide()
    }),
    statusBar
  )

  if (config.get('enabled')) {
    statusBar.show()
  }
}

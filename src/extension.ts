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

  const completionProvider = new CompletionProvider(statusBar);

  context.subscriptions.push(
    languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      completionProvider
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

	context.subscriptions.push(
    workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('twinny')) {
        return
      }

      completionProvider.updateConfig()
	}));
}

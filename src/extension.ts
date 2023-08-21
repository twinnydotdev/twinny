// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import {
  commands,
  ExtensionContext,
  languages,
  StatusBarAlignment,
  window,
  workspace
} from 'vscode'
import { CompletionProvider } from './CompletionProvider'

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {
  const statusBar = window.createStatusBarItem(StatusBarAlignment.Right)
  statusBar.text = '$(light-bulb)'
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

  if (workspace.getConfiguration('twinny').get('enabled')) {
    statusBar.show()
  }
}

// this method is called when your extension is deactivated
export function deactivate() {
  console.debug('Deactivating twinny provider', new Date())
}

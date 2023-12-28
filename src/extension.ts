import {
  commands,
  ExtensionContext,
  languages,
  StatusBarAlignment,
  window,
  workspace
} from 'vscode'

import { CompletionProvider } from './completion'
import { init } from './init'

export async function activate(context: ExtensionContext) {
  const config = workspace.getConfiguration('twinny')
  const model = config.get('ollamaModelName') as string
  const statusBar = window.createStatusBarItem(StatusBarAlignment.Right)

  try {
    await init()
  } catch (e) {
    console.error(e)
  }

  statusBar.text = '🤖'
  statusBar.tooltip = `twinny is running: ${model}`

  const completionProvider = new CompletionProvider(statusBar)

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
    workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('twinny')) {
        return
      }

      completionProvider.updateConfig()
    })
  )
}

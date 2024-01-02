import {
  commands,
  ExtensionContext,
  languages,
  StatusBarAlignment,
  window,
  workspace
} from 'vscode'

import { CompletionProvider } from './providers/completion'
import { init } from './init'
import { SidebarProvider } from './providers/sidebar'
import { chatCompletion } from './utils'

export async function activate(context: ExtensionContext) {
  const config = workspace.getConfiguration('twinny')
  const fimModel = config.get('fimModelName') as string
  const chatModel = config.get('chatModelName') as string
  const statusBar = window.createStatusBarItem(StatusBarAlignment.Right)

  try {
    await init()
  } catch (e) {
    console.error(e)
  }

  statusBar.text = '🤖'
  statusBar.tooltip = `twinny is running: fim: ${fimModel} chat: ${chatModel}`

  const completionProvider = new CompletionProvider(statusBar)
  const sidebarProvider = new SidebarProvider(context.extensionUri)

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
    window.registerWebviewViewProvider('twinny-sidebar', sidebarProvider),
    statusBar
  )

  setTimeout(() => {
    commands.registerCommand('twinny.explain', () => {
      commands.executeCommand('workbench.view.extension.twinny-sidebar-view')
      chatCompletion('explain', sidebarProvider.view)
    }),
      commands.registerCommand('twinny.addTypes', () => {
        commands.executeCommand('workbench.view.extension.twinny-sidebar-view')
        chatCompletion('add-types', sidebarProvider.view)
      }),
      commands.registerCommand('twinny.refactor', () => {
        commands.executeCommand('workbench.view.extension.twinny-sidebar-view')
        chatCompletion('refactor', sidebarProvider.view)
      }),
      commands.registerCommand('twinny.addTests', () => {
        commands.executeCommand('workbench.view.extension.twinny-sidebar-view')
        chatCompletion('add-tests', sidebarProvider.view)
      }),
      commands.registerCommand('twinny.generateDocs', () => {
        commands.executeCommand('workbench.view.extension.twinny-sidebar-view')
        chatCompletion('generate-docs', sidebarProvider.view)
      })
  }, 2000)

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

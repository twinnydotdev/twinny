import {
  commands,
  ExtensionContext,
  languages,
  StatusBarAlignment,
  window,
  workspace,
  Uri,
} from 'vscode'
import * as path from 'path'
import * as os from 'os'
import * as vscode from 'vscode'

import { CompletionProvider } from './providers/completion'
import { init } from './init'
import { SidebarProvider } from './providers/sidebar'
import { delayExecution, deleteTempFiles } from './utils'
import { setContext } from './context'
import { EXTENSION_NAME, MESSAGE_KEY } from './constants'
import { TemplateProvider } from './template-provider'

export async function activate(context: ExtensionContext) {
  const config = workspace.getConfiguration('twinny')
  const fimModel = config.get('fimModelName') as string
  const chatModel = config.get('chatModelName') as string
  const statusBar = window.createStatusBarItem(StatusBarAlignment.Right)
  const templateDir =
    config.get('templateDir') as string  ||
    path.join(os.homedir(), '.twinny/templates') as string
  setContext(context)

  try {
    await init()
  } catch (e) {
    console.error(e)
  }

  statusBar.text = '🤖'
  statusBar.tooltip = `twinny is running: fim: ${fimModel} chat: ${chatModel}`

  const completionProvider = new CompletionProvider(statusBar)
  new TemplateProvider(templateDir).createTemplateDir()

  if (!context) {
    return
  }

  const sidebarProvider = new SidebarProvider(statusBar, context, templateDir)

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
    commands.registerCommand('twinny.explain', () => {
      commands.executeCommand('twinny.sidebar.focus')
      delayExecution(() =>
        sidebarProvider.chatService?.streamTemplateCompletion('explain')
      )
    }),
    commands.registerCommand('twinny.fixCode', () => {
      commands.executeCommand('twinny.sidebar.focus')
      delayExecution(() =>
        sidebarProvider.chatService?.streamTemplateCompletion('fix-code')
      )
    }),
    commands.registerCommand('twinny.stopGeneration', () => {
      completionProvider.destroyStream()
      sidebarProvider.destroyStream()
    }),
    commands.registerCommand('twinny.addTypes', () => {
      commands.executeCommand('twinny.sidebar.focus')
      delayExecution(() =>
        sidebarProvider.chatService?.streamTemplateCompletion('add-types')
      )
    }),
    commands.registerCommand('twinny.refactor', () => {
      commands.executeCommand('twinny.sidebar.focus')
      delayExecution(() =>
        sidebarProvider.chatService?.streamTemplateCompletion('refactor')
      )
    }),
    commands.registerCommand('twinny.addTests', () => {
      commands.executeCommand('twinny.sidebar.focus')
      delayExecution(() =>
        sidebarProvider.chatService?.streamTemplateCompletion('add-tests')
      )
    }),
    commands.registerCommand('twinny.generateDocs', () => {
      commands.executeCommand('twinny.sidebar.focus')
      delayExecution(() =>
        sidebarProvider.chatService?.streamTemplateCompletion('generate-docs')
      )
    }),
    commands.registerCommand('twinny.templates', async () => {
      await vscode.commands.executeCommand('vscode.openFolder', Uri.parse(templateDir), true);
    }),
    commands.registerCommand('twinny.settings', () => {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        EXTENSION_NAME
      )
    }),
    commands.registerCommand('twinny.newChat', () => {
      sidebarProvider.setTwinnyWorkspaceContext({
        key: MESSAGE_KEY.lastConversation,
        messages: []
      })
      sidebarProvider.getTwinnyWorkspaceContext({
        key: MESSAGE_KEY.lastConversation
      })
    }),

    window.registerWebviewViewProvider('twinny.sidebar', sidebarProvider),
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

export function deactivate() {
  deleteTempFiles()
}

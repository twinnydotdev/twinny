import {
  commands,
  ExtensionContext,
  languages,
  StatusBarAlignment,
  window,
  workspace
} from 'vscode'
import * as path from 'path'
import * as os from 'os'
import * as vscode from 'vscode'

import { CompletionProvider } from './providers/completion'
import { init } from './init'
import { SidebarProvider } from './providers/sidebar'
import { delayExecution, deleteTempFiles } from './utils'
import { setContext } from './context'
import {
  CONTEXT_NAME,
  EXTENSION_NAME,
  MESSAGE_KEY,
  MESSAGE_NAME,
  TABS
} from './constants'
import { TemplateProvider } from './template-provider'
import { ServerMessage } from './types'

export async function activate(context: ExtensionContext) {
  const config = workspace.getConfiguration('twinny')
  const fimModel = config.get('fimModelName') as string
  const chatModel = config.get('chatModelName') as string
  const statusBar = window.createStatusBarItem(StatusBarAlignment.Right)
  const templateDir =
    (config.get('templateDir') as string) ||
    (path.join(os.homedir(), '.twinny/templates') as string)
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
    commands.registerCommand('twinny.templateCompletion', (template: string) => {
      commands.executeCommand('twinny.sidebar.focus')
      delayExecution(() =>
        sidebarProvider.chatService?.streamTemplateCompletion(template)
      )
    }),
    commands.registerCommand('twinny.stopGeneration', () => {
      completionProvider.destroyStream()
      sidebarProvider.destroyStream()
    }),
    commands.registerCommand('twinny.templates', async () => {
      await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.parse(templateDir),
        true
      )
    }),
    commands.registerCommand('twinny.manageTemplates', async () => {
      commands.executeCommand(
        'setContext',
        CONTEXT_NAME.twinnyManageTemplates,
        true
      )
      sidebarProvider.view?.webview.postMessage({
        type: MESSAGE_NAME.twinnySetTab,
        value: {
          data: TABS.templates
        }
      } as ServerMessage<string>)
    }),
    commands.registerCommand('twinny.openChat', () => {
      commands.executeCommand(
        'setContext',
        CONTEXT_NAME.twinnyManageTemplates,
        false
      )
      sidebarProvider.view?.webview.postMessage({
        type: MESSAGE_NAME.twinnySetTab,
        value: {
          data: TABS.chat
        }
      } as ServerMessage<string>)
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
        data: []
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

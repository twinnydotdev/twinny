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

import { CompletionProvider } from './extension/providers/completion'
import { SidebarProvider } from './extension/providers/sidebar'
import { delayExecution } from './extension/utils'
import { setContext } from './extension/context'
import {
  CONTEXT_NAME,
  EXTENSION_NAME,
  MESSAGE_KEY,
  MESSAGE_NAME,
  UI_TABS
} from './common/constants'
import { TemplateProvider } from './extension/template-provider'
import { ServerMessage } from './common/types'
import { FileInteractionCache } from './extension/file-interaction'
import { getLineBreakCount } from './webview/utils'

export async function activate(context: ExtensionContext) {
  setContext(context)
  const config = workspace.getConfiguration('twinny')
  const statusBar = window.createStatusBarItem(StatusBarAlignment.Right)
  const templateDir = path.join(os.homedir(), '.twinny/templates') as string
  const templateProvider = new TemplateProvider(templateDir)
  const fileInteractionCache = new FileInteractionCache()
  const completionProvider = new CompletionProvider(
    statusBar,
    fileInteractionCache,
    templateProvider
  )
  const sidebarProvider = new SidebarProvider(statusBar, context, templateDir)

  templateProvider.init()

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
    commands.registerCommand('twinny.generateDocs', () => {
      commands.executeCommand('twinny.sidebar.focus')
      delayExecution(() =>
        sidebarProvider.chatService?.streamTemplateCompletion('generate-docs')
      )
    }),
    commands.registerCommand('twinny.addTests', () => {
      commands.executeCommand('twinny.sidebar.focus')
      delayExecution(() =>
        sidebarProvider.chatService?.streamTemplateCompletion('add-tests')
      )
    }),
    commands.registerCommand(
      'twinny.templateCompletion',
      (template: string) => {
        commands.executeCommand('twinny.sidebar.focus')
        delayExecution(() =>
          sidebarProvider.chatService?.streamTemplateCompletion(template)
        )
      }
    ),
    commands.registerCommand('twinny.stopGeneration', () => {
      completionProvider.onError()
      sidebarProvider.destroyStream()
    }),
    commands.registerCommand('twinny.templates', async () => {
      await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(templateDir),
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
          data: UI_TABS.templates
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
          data: UI_TABS.chat
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

  context.subscriptions.push(
    workspace.onDidCloseTextDocument((document) => {
      const filePath = document.uri.fsPath
      fileInteractionCache.endSession()
      fileInteractionCache.delete(filePath)
    }),
    workspace.onDidOpenTextDocument((document) => {
      const filePath = document.uri.fsPath
      fileInteractionCache.startSession(filePath)
      fileInteractionCache.incrementVisits()
    }),
    workspace.onDidChangeTextDocument((e) => {
      const changes = e.contentChanges[0]
      if (!changes) return
      const lastCompletion = completionProvider.getLastCompletion()
      const isLastCompltionMultiline = getLineBreakCount(lastCompletion) > 1
      completionProvider.setAcceptedLastCompletion(
        !!(
          changes.text &&
          lastCompletion &&
          changes.text === lastCompletion &&
          isLastCompltionMultiline
        )
      )
      const currentLine = changes.range.start.line
      const currentCharacter = changes.range.start.character
      fileInteractionCache.incrementStrokes(currentLine, currentCharacter)
    })
  )

  window.onDidChangeTextEditorSelection(() => {
    completionProvider.abortCompletion()
    delayExecution(() => {
      completionProvider.setAcceptedLastCompletion(false)
    }, 200)
  })

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('twinny')) return
      completionProvider.updateConfig()
    })
  )

  if (config.get('enabled')) statusBar.show()
  statusBar.text = '🤖'
}

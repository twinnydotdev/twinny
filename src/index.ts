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
import * as fs from 'fs'
import { EmbeddingDatabase } from './extension/embeddings'
import * as vscode from 'vscode'

import { CompletionProvider } from './extension/providers/completion'
import { SidebarProvider } from './extension/providers/sidebar'
import {
  delayExecution,
  getTerminal,
  getSanitizedCommitMessage
} from './extension/utils'
import { setContext } from './extension/context'
import {
  EXTENSION_CONTEXT_NAME,
  EXTENSION_NAME,
  EVENT_NAME,
  WEBUI_TABS,
  TWINNY_COMMAND_NAME
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

  const homeDir = os.homedir()
  const dbDir = path.join(homeDir, '.twinny/embeddings')
  let db

  if (workspace.name) {
    const dbPath = path.join(dbDir, workspace.name as string)

    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })
    db = new EmbeddingDatabase(dbPath, context)
    await db.connect()
  }

  const completionProvider = new CompletionProvider(
    statusBar,
    fileInteractionCache,
    templateProvider,
    context
  )
  const sidebarProvider = new SidebarProvider(statusBar, context, templateDir, db)

  templateProvider.init()

  context.subscriptions.push(
    languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      completionProvider
    ),
    commands.registerCommand(TWINNY_COMMAND_NAME.enable, () => {
      statusBar.show()
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.disable, () => {
      statusBar.hide()
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.explain, () => {
      commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
      delayExecution(() =>
        sidebarProvider.chatService?.streamTemplateCompletion('explain')
      )
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.addTypes, () => {
      commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
      delayExecution(() =>
        sidebarProvider.chatService?.streamTemplateCompletion('add-types')
      )
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.refactor, () => {
      commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
      delayExecution(() =>
        sidebarProvider.chatService?.streamTemplateCompletion('refactor')
      )
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.generateDocs, () => {
      commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
      delayExecution(() =>
        sidebarProvider.chatService?.streamTemplateCompletion('generate-docs')
      )
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.addTests, () => {
      commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
      delayExecution(() =>
        sidebarProvider.chatService?.streamTemplateCompletion('add-tests')
      )
    }),
    commands.registerCommand(
      TWINNY_COMMAND_NAME.templateCompletion,
      (template: string) => {
        commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
        delayExecution(() =>
          sidebarProvider.chatService?.streamTemplateCompletion(template)
        )
      }
    ),
    commands.registerCommand(TWINNY_COMMAND_NAME.stopGeneration, () => {
      completionProvider.onError()
      sidebarProvider.destroyStream()
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.templates, async () => {
      await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(templateDir),
        true
      )
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.manageProviders, async () => {
      commands.executeCommand(
        'setContext',
        EXTENSION_CONTEXT_NAME.twinnyManageProviders,
        true
      )
      sidebarProvider.view?.webview.postMessage({
        type: EVENT_NAME.twinnySetTab,
        value: {
          data: WEBUI_TABS.providers
        }
      } as ServerMessage<string>)
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.conversationHistory, async () => {
      commands.executeCommand(
        'setContext',
        EXTENSION_CONTEXT_NAME.twinnyConversationHistory,
        true
      )
      sidebarProvider.view?.webview.postMessage({
        type: EVENT_NAME.twinnySetTab,
        value: {
          data: WEBUI_TABS.history
        }
      } as ServerMessage<string>)
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.manageTemplates, async () => {
      commands.executeCommand(
        'setContext',
        EXTENSION_CONTEXT_NAME.twinnyManageTemplates,
        true
      )
      sidebarProvider.view?.webview.postMessage({
        type: EVENT_NAME.twinnySetTab,
        value: {
          data: WEBUI_TABS.templates
        }
      } as ServerMessage<string>)
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.hideBackButton, () => {
      commands.executeCommand(
        'setContext',
        EXTENSION_CONTEXT_NAME.twinnyManageTemplates,
        false
      )
      commands.executeCommand(
        'setContext',
        EXTENSION_CONTEXT_NAME.twinnyConversationHistory,
        false
      )
      commands.executeCommand(
        'setContext',
        EXTENSION_CONTEXT_NAME.twinnyManageProviders,
        false
      )
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.openChat, () => {
      commands.executeCommand(TWINNY_COMMAND_NAME.hideBackButton)
      sidebarProvider.view?.webview.postMessage({
        type: EVENT_NAME.twinnySetTab,
        value: {
          data: WEBUI_TABS.chat
        }
      } as ServerMessage<string>)
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.settings, () => {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        EXTENSION_NAME
      )
    }),
    commands.registerCommand(
      TWINNY_COMMAND_NAME.sendTerminalText,
      async (commitMessage: string) => {
        const terminal = await getTerminal()
        terminal?.sendText(getSanitizedCommitMessage(commitMessage), false)
      }
    ),
    commands.registerCommand(TWINNY_COMMAND_NAME.getGitCommitMessage, () => {
      commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
      sidebarProvider.conversationHistory?.resetConversation()
      delayExecution(() => sidebarProvider.getGitCommitMessage(), 400)
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.newChat, () => {
      sidebarProvider.conversationHistory?.resetConversation()
      sidebarProvider.view?.webview.postMessage({
        type: EVENT_NAME.twinnyStopGeneration
      } as ServerMessage<string>)

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
      const lastCompletion = completionProvider.lastCompletionText
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

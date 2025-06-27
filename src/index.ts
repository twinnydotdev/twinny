import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { v4 as uuidv4 } from "uuid"
import {
  commands,
  ExtensionContext,
  languages,
  StatusBarAlignment,
  window,
  workspace
} from "vscode"
import * as vscode from "vscode"

import {
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  EXTENSION_NAME,
  TWINNY_COMMAND_NAME,
  WEBUI_TABS
} from "./common/constants"
import { logger } from "./common/logger"
import {
  FileContextItem,
  SelectionContextItem,
  ServerMessage} from "./common/types"
import { setContext } from "./extension/context"
import { EmbeddingDatabase } from "./extension/embeddings"
import { FileInteractionCache } from "./extension/file-interaction"
import { CompletionProvider } from "./extension/providers/completion"
import { FullScreenProvider } from "./extension/providers/panel"
import { SidebarProvider } from "./extension/providers/sidebar"
import { SessionManager } from "./extension/session-manager"
import { TemplateProvider } from "./extension/template-provider"
import { delayExecution, sanitizeWorkspaceName } from "./extension/utils"
import { getLineBreakCount } from "./webview/utils"

export async function activate(context: ExtensionContext) {
  setContext(context)
  const config = workspace.getConfiguration("twinny")
  const statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right)

  logger.log("Twinny extension starting")
  const templateDir = path.join(os.homedir(), ".twinny/templates") as string
  const templateProvider = new TemplateProvider(templateDir)
  const fileInteractionCache = new FileInteractionCache()
  const sessionManager = new SessionManager()
  const fullScreenProvider = new FullScreenProvider(
    context,
    templateDir,
    statusBarItem
  )

  const homeDir = os.homedir()
  const dbDir = path.join(homeDir, ".twinny/embeddings")
  let db
  const workspaceName = sanitizeWorkspaceName(workspace.name)

  if (workspaceName) {
    const dbPath = path.join(dbDir, workspaceName as string)

    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })
    db = new EmbeddingDatabase(dbPath, context)
    await db.connect()
  }

  const sidebarProvider = new SidebarProvider(
    statusBarItem,
    context,
    templateDir,
    db,
    sessionManager
  )

  const completionProvider = new CompletionProvider(
    statusBarItem,
    fileInteractionCache,
    templateProvider,
    context
  )

  templateProvider.init()

  context.subscriptions.push(
    languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      completionProvider
    ),
    commands.registerCommand(TWINNY_COMMAND_NAME.enable, () => {
      statusBarItem.show()
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.disable, () => {
      statusBarItem.hide()
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.explain, async () => {
      await commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
      await sidebarProvider.waitForSidebarReady()
      sidebarProvider?.streamTemplateCompletion("explain")
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.addTypes, async () => {
      await commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
      await sidebarProvider.waitForSidebarReady()
      sidebarProvider?.streamTemplateCompletion("add-types")
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.refactor, async () => {
      await commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
      await sidebarProvider.waitForSidebarReady()
      sidebarProvider?.streamTemplateCompletion("refactor")
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.generateDocs, async () => {
      await commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
      await sidebarProvider.waitForSidebarReady()
      sidebarProvider?.streamTemplateCompletion("generate-docs")
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.addTests, async () => {
      await commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
      await sidebarProvider.waitForSidebarReady()
      sidebarProvider?.streamTemplateCompletion("add-tests")
    }),
    commands.registerCommand(
      TWINNY_COMMAND_NAME.templateCompletion,
      async (template: string) => {
        await commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
        await sidebarProvider.waitForSidebarReady()
        sidebarProvider?.streamTemplateCompletion(template)
      }
    ),
    commands.registerCommand(TWINNY_COMMAND_NAME.stopGeneration, () => {
      completionProvider.onError()
      sidebarProvider.destroyStream()
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.manageProviders, async () => {
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyManageProviders,
        true
      )
      sidebarProvider.webView?.postMessage({
        type: EVENT_NAME.twinnySetTab,
        data: WEBUI_TABS.providers
      } as ServerMessage<string>)
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.embeddings, async () => {
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyEmbeddingsTab,
        true
      )
      sidebarProvider.webView?.postMessage({
        type: EVENT_NAME.twinnySetTab,
        data: WEBUI_TABS.embeddings
      } as ServerMessage<string>)
    }),
    commands.registerCommand(
      TWINNY_COMMAND_NAME.twinnySymmetryTab,
      async () => {
        commands.executeCommand(
          "setContext",
          EXTENSION_CONTEXT_NAME.twinnySymmetryTab,
          true
        )
        sidebarProvider.webView?.postMessage({
          type: EVENT_NAME.twinnySetTab,
          data: WEBUI_TABS.symmetry
        } as ServerMessage<string>)
      }
    ),
    commands.registerCommand(
      TWINNY_COMMAND_NAME.conversationHistory,
      async () => {
        commands.executeCommand(
          "setContext",
          EXTENSION_CONTEXT_NAME.twinnyConversationHistory,
          true
        )
        sidebarProvider.webView?.postMessage({
          type: EVENT_NAME.twinnySetTab,
          data: WEBUI_TABS.history
        } as ServerMessage<string>)
      }
    ),
    commands.registerCommand(TWINNY_COMMAND_NAME.review, async () => {
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyReviewTab,
        true
      )
      sidebarProvider.webView?.postMessage({
        type: EVENT_NAME.twinnySetTab,
        data: WEBUI_TABS.review
      } as ServerMessage<string>)
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.manageTemplates, async () => {
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyManageTemplates,
        true
      )
      sidebarProvider.webView?.postMessage({
        type: EVENT_NAME.twinnySetTab,
        data: WEBUI_TABS.settings
      } as ServerMessage<string>)
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.hideBackButton, () => {
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyManageTemplates,
        false
      )
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyConversationHistory,
        false
      )
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnySymmetryTab,
        false
      )
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyManageProviders,
        false
      )
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyReviewTab,
        false
      )
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.openChat, () => {
      commands.executeCommand(TWINNY_COMMAND_NAME.hideBackButton)
      sidebarProvider.webView?.postMessage({
        type: EVENT_NAME.twinnySetTab,
        data: WEBUI_TABS.chat
      } as ServerMessage<string>)
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.settings, () => {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        EXTENSION_NAME
      )
    }),
    commands.registerCommand(
      TWINNY_COMMAND_NAME.getGitCommitMessage,
      async () => {
        await commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
        sidebarProvider.conversationHistory?.resetConversation()
        await sidebarProvider.waitForSidebarReady()
        sidebarProvider.getGitCommitMessage()
      }
    ),
    commands.registerCommand(TWINNY_COMMAND_NAME.newConversation, () => {
      sidebarProvider.newSymmetryConversation()
      sidebarProvider.webView?.postMessage({
        type: EVENT_NAME.twinnyNewConversation
      } as ServerMessage<string>)
      sidebarProvider.conversationHistory?.resetConversation()
      sidebarProvider.chat?.resetConversation()
      sidebarProvider.webView?.postMessage({
        type: EVENT_NAME.twinnySetTab,
        data: WEBUI_TABS.chat
      } as ServerMessage<string>)
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.openPanelChat, () => {
      commands.executeCommand("workbench.action.closeSidebar")
      fullScreenProvider.createOrShowPanel()
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.addFileToContext, () => {
      const editor = window.activeTextEditor
      if (editor) {
        const filePath = workspace.asRelativePath(editor.document.uri.fsPath)
        const fileContextItem: FileContextItem = {
          id: filePath, // Use filePath as the ID for files
          category: "file",
          name: path.basename(editor.document.uri.fsPath),
          path: filePath
        }
        // Ensure addContextItem is used, which should exist from previous subtask
        if (sidebarProvider.addContextItem) {
          sidebarProvider.addContextItem(fileContextItem)
        } else {
          // Fallback for robustness, similar to addSelectionToContext
          // @ts-expect-error addFileToContext might not exist
          if (sidebarProvider.addFileToContext) {
            // @ts-expect-error addFileToContext might expect a different structure now
            sidebarProvider.addFileToContext(fileContextItem)
            window.showWarningMessage(
              "Using fallback file context method. Please ensure `addContextItem` is available."
            )
          } else {
            window.showErrorMessage(
              "Could not add file to context. Provider method not found."
            )
          }
        }
      }
    }),
    commands.registerCommand(
      TWINNY_COMMAND_NAME.addSelectionToContext,
      async () => {
        const editor = window.activeTextEditor
        if (editor && !editor.selection.isEmpty) {
          const selection = editor.selection
          const selectedText = editor.document.getText(selection)
          const filePath = workspace.asRelativePath(editor.document.uri.fsPath)
          const selectionContextItem: SelectionContextItem = {
            id: uuidv4(),
            category: "selection",
            name: `Selection from ${path.basename(filePath)} (L${
              selection.start.line + 1
            }-L${selection.end.line + 1})`,
            path: filePath,
            content: selectedText,
            selectionRange: {
              startLine: selection.start.line,
              startCharacter: selection.start.character,
              endLine: selection.end.line,
              endCharacter: selection.end.character
            }
          }
          // The addContextItem method should exist on BaseProvider, and thus on sidebarProvider
          // It was renamed from addFileToContext in a previous step.
          if (sidebarProvider.addContextItem) {
            sidebarProvider.addContextItem(selectionContextItem)
          } else {
            // Fallback or error if the method somehow doesn't exist (e.g. if previous step was skipped)
            // This else block is more for robustness during development.
            // In a sequential execution of subtasks, addFileToContext would have been renamed to addContextItem.
            // For now, let's try to call the old name if new one is not present.
            // This indicates a potential issue if addContextItem is not found.
            // @ts-expect-error addFileToContext might not exist
            if (sidebarProvider.addFileToContext) {
              // @ts-expect-error addFileToContext expects a FileContextItem
              sidebarProvider.addFileToContext(selectionContextItem)
              window.showWarningMessage(
                "Using fallback context method. Please ensure `addContextItem` is available."
              )
            } else {
              window.showErrorMessage(
                "Could not add selection to context. Provider method not found."
              )
            }
          }
        } else {
          window.showInformationMessage("No text selected to add to context.")
        }
      }
    ),
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
    }),
    window.registerWebviewViewProvider("twinny.sidebar", sidebarProvider),
    statusBarItem
  )

  window.onDidChangeTextEditorSelection(() => {
    completionProvider.abortCompletion()
    delayExecution(() => {
      completionProvider.setAcceptedLastCompletion(false)
    }, 200)
  })

  if (config.get("enabled")) statusBarItem.show()

  statusBarItem.text = "$(code)"

  logger.log("Twinny extension activation complete")
}

export function deactivate() {
  logger.log("Twinny extension deactivated")
}
